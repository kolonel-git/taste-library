import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, Store, type NewItem } from '../src/server/db.ts';
import { analysePending, type ProgressEvent } from '../src/analysis/analyse.ts';
import { ensureDataDirs } from '../src/server/config.ts';
import { envelope, goodAnalysis, stubExec } from './fixtures.ts';
import { snapshot, tmpDir, write } from './helpers.ts';

function setup(files: Record<string, string> = { 'a.png': 'aaa' }) {
  const source = tmpDir('src-');
  const dataDir = tmpDir('data-');
  ensureDataDirs(dataDir);
  const store = new Store(openDb(':memory:'));
  for (const [rel, body] of Object.entries(files)) {
    write(source, rel, body);
    const kind = rel.endsWith('.mp4') ? 'video' : 'image';
    store.insertItem({ relPath: rel, kind, size: body.length, mtimeMs: 1, contentHash: `hash-${rel}`, width: 10, height: 10, durationS: null } satisfies NewItem);
  }
  return { source, dataDir, store };
}

const row = (s: Store, rel: string) => s.getByPath(rel)!;

test('success: analysis saved, tags resolved and linked, status analysed', async () => {
  const { source, dataDir, store } = setup();
  const exec = stubExec(() => envelope(goodAnalysis()));
  const events: ProgressEvent[] = [];
  const r = await analysePending({ store, sourceFolder: source, dataDir, exec, onProgress: (e) => events.push(e) });

  assert.deepEqual([r.analysed, r.failed], [1, 0]);
  const item = row(store, 'a.png');
  assert.equal(item.status, 'analysed');
  assert.equal(JSON.parse(item.ai_json!).title, 'Midnight Ledger Dashboard');
  assert.equal(item.analysed_hash, 'hash-a.png');
  assert.deepEqual(store.tagsFor(item.id), ['dark-mode', 'dashboard', 'minimal']);
  assert.ok(events.some((e) => e.type === 'item' && e.status === 'analysing'));
  assert.ok(events.some((e) => e.type === 'item' && e.status === 'analysed'));
});

test('the prompt carries the image path and the current tag vocabulary', async () => {
  const { source, dataDir, store } = setup({ 'a.png': 'a', 'b.png': 'b' });
  const exec = stubExec(() => envelope(goodAnalysis()));
  await analysePending({ store, sourceFolder: source, dataDir, exec, concurrency: 1 });
  assert.match(exec.prompts[0], new RegExp(path.join(source, 'a.png').replace(/\\/g, '\\\\')));
  assert.match(exec.prompts[0], /starting the vocabulary/);
  assert.match(exec.prompts[1], /- dashboard/); // learnt from the first item
});

test('invalid output: one retry, then failed with a reason; retry() puts it back', async () => {
  const { source, dataDir, store } = setup();
  const exec = stubExec(() => envelope({ title: 'x' }));
  const r = await analysePending({ store, sourceFolder: source, dataDir, exec });
  assert.equal(exec.calls, 2);
  assert.deepEqual([r.analysed, r.failed], [0, 1]);
  const item = row(store, 'a.png');
  assert.equal(item.status, 'failed');
  assert.match(item.error!, /did not match the schema/);

  assert.equal(store.retry(item.id), true);
  assert.equal(row(store, 'a.png').status, 'pending');
  assert.equal(store.retry(item.id), false); // only failed items can be retried
});

test('second attempt can rescue a bad first answer', async () => {
  const { source, dataDir, store } = setup();
  const exec = stubExec((n) => (n === 1 ? 'not json at all' : envelope(goodAnalysis())));
  const r = await analysePending({ store, sourceFolder: source, dataDir, exec });
  assert.equal(r.analysed, 1);
  assert.equal(exec.calls, 2);
});

test('infrastructure errors are not retried and mark the item failed', async () => {
  const { source, dataDir, store } = setup();
  const exec = stubExec(() => {
    throw new Error('Claude Code timed out after 240s');
  });
  await analysePending({ store, sourceFolder: source, dataDir, exec });
  assert.equal(exec.calls, 1);
  assert.equal(row(store, 'a.png').status, 'failed');
  assert.match(row(store, 'a.png').error!, /timed out/);
});

test('an error envelope (for example not signed in) fails the item with the CLI message', async () => {
  const { source, dataDir, store } = setup();
  const exec = stubExec(() => JSON.stringify({ is_error: true, result: 'Not logged in. Run claude login.' }));
  await analysePending({ store, sourceFolder: source, dataDir, exec });
  assert.match(row(store, 'a.png').error!, /Not logged in/);
});

test('a file removed before analysis fails cleanly without calling claude', async () => {
  const { source, dataDir, store } = setup();
  fs.rmSync(path.join(source, 'a.png'));
  const exec = stubExec(() => envelope(goodAnalysis()));
  await analysePending({ store, sourceFolder: source, dataDir, exec });
  assert.equal(exec.calls, 0);
  assert.match(row(store, 'a.png').error!, /no longer in the source folder/);
});

test('stops after repeated failures and leaves the rest pending', async () => {
  const files = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [`${n}.png`, n]));
  const { source, dataDir, store } = setup(files);
  const exec = stubExec(() => {
    throw new Error('boom');
  });
  const r = await analysePending({ store, sourceFolder: source, dataDir, exec, concurrency: 1, maxConsecutiveFailures: 3 });
  assert.equal(r.failed, 3);
  assert.equal(r.abortedWith, 2);
  assert.deepEqual(store.countsByStatus(), { pending: 2, analysing: 0, analysed: 0, failed: 3 });
});

test('videos are left alone in this sprint', async () => {
  const { source, dataDir, store } = setup({ 'a.png': 'a', 'clip.mp4': 'v' });
  const exec = stubExec(() => envelope(goodAnalysis()));
  const r = await analysePending({ store, sourceFolder: source, dataDir, exec });
  assert.equal(r.analysed, 1);
  assert.equal(row(store, 'clip.mp4').status, 'pending');
  assert.equal(store.countAnalysable(), 0);
});

test('concurrency limit is respected and every item is analysed exactly once', async () => {
  const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}.png`, `x${i}`]));
  const { source, dataDir, store } = setup(files);
  let live = 0;
  let peak = 0;
  const exec = stubExec(async () => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 15));
    live--;
    return envelope(goodAnalysis());
  });
  const r = await analysePending({ store, sourceFolder: source, dataDir, exec, concurrency: 3 });
  assert.equal(r.analysed, 7);
  assert.equal(exec.calls, 7);
  assert.equal(peak, 3);
});

test('two runners at once never analyse the same item twice', async () => {
  const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.png`, `x${i}`]));
  const { source, dataDir, store } = setup(files);
  const exec = stubExec(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return envelope(goodAnalysis());
  });
  const deps = { store, sourceFolder: source, dataDir, exec, concurrency: 2 };
  const [a, b] = await Promise.all([analysePending(deps), analysePending(deps)]);
  assert.equal(a.analysed + b.analysed, 6);
  assert.equal(exec.calls, 6);
});

test('file changed while analysing: the stale result is dropped, item stays pending', async () => {
  const { source, dataDir, store } = setup();
  const exec = stubExec((n) => {
    // a rescan lands mid-analysis (first call only): new contents, queued again
    if (n === 1) {
      store.markChanged(row(store, 'a.png').id, { relPath: 'a.png', kind: 'image', size: 9, mtimeMs: 2, contentHash: 'new-hash', width: 1, height: 1, durationS: null });
    }
    return envelope(goodAnalysis({ title: `Run ${n}` }));
  });
  const r = await analysePending({ store, sourceFolder: source, dataDir, exec, concurrency: 1 });
  // run 1 is dropped as stale; the changed file is picked up again and analysed on the new contents
  assert.equal(exec.calls, 2);
  assert.equal(r.analysed, 1);
  const item = row(store, 'a.png');
  assert.equal(JSON.parse(item.ai_json!).title, 'Run 2');
  assert.equal(item.analysed_hash, 'new-hash');
});

test('re-analysis keeps hand edits and user tags, replaces AI output and AI tags', async () => {
  const { source, dataDir, store } = setup();
  await analysePending({ store, sourceFolder: source, dataDir, exec: stubExec(() => envelope(goodAnalysis())) });
  const id = row(store, 'a.png').id;
  store.setUserJson(id, { title: 'Mine' });
  store.db.prepare("INSERT INTO tags (name) VALUES ('mine')").run();
  store.db.prepare("INSERT INTO item_tags (item_id, tag_id, source) SELECT ?, id, 'user' FROM tags WHERE name = 'mine'").run(id);

  store.markChanged(id, { relPath: 'a.png', kind: 'image', size: 5, mtimeMs: 3, contentHash: 'h2', width: 1, height: 1, durationS: null });
  const second = goodAnalysis({ title: 'Second Opinion', tags: ['poster', 'bold'] });
  await analysePending({ store, sourceFolder: source, dataDir, exec: stubExec(() => envelope(second)) });

  const item = row(store, 'a.png');
  assert.equal(JSON.parse(item.ai_json!).title, 'Second Opinion');
  assert.equal(item.user_json, '{"title":"Mine"}');
  assert.deepEqual(store.tagsFor(id), ['bold', 'mine', 'poster']);
  // tags nobody uses any more are pruned from the vocabulary
  assert.deepEqual(store.tagVocabulary().sort(), ['bold', 'mine', 'poster']);
});

test('stale claims from a crashed run are released', async () => {
  const { source, dataDir, store } = setup();
  const claimed = store.claimNext()!;
  store.db.prepare("UPDATE items SET claimed_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(claimed.id);
  const r = await analysePending({ store, sourceFolder: source, dataDir, exec: stubExec(() => envelope(goodAnalysis())) });
  assert.equal(r.analysed, 1);
});

test('the source folder is untouched by analysis', async () => {
  const { source, dataDir, store } = setup({ 'a.png': 'a', 'b.png': 'b' });
  const before = snapshot(source);
  await analysePending({ store, sourceFolder: source, dataDir, exec: stubExec(() => envelope(goodAnalysis())) });
  assert.deepEqual(snapshot(source), before);
});
