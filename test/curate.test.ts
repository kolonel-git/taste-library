import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { ItemView } from '../src/shared/types.ts';
import { filterByTags, parseTagsParam, sortItems, tagCounts, toggleTag, withTagsParam } from '../src/shared/filter.ts';
import { LIMITS, validateEdit } from '../src/analysis/edits.ts';
import { openDb, Store, type NewItem } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { ensureDataDirs, saveConfig } from '../src/server/config.ts';
import { syncLibrary } from '../src/server/sync.ts';
import { analysePending } from '../src/analysis/analyse.ts';
import { envelope, goodAnalysis, stubExec } from './fixtures.ts';
import { tmpDir, write } from './helpers.ts';

// ---------- filter and sort (pure) ----------

const view = (id: number, tags: string[], over: Partial<ItemView> = {}): ItemView => ({
  id,
  relPath: `f${id}.png`,
  kind: 'image',
  status: 'analysed',
  title: null,
  tags,
  width: 1,
  height: 1,
  durationS: null,
  error: null,
  analysedAt: null,
  thumbUrl: '',
  mediaUrl: '',
  ...over,
});

const library = [
  view(1, ['dashboard', 'dark-mode', 'minimal'], { title: 'Zebra', analysedAt: '2026-01-02T00:00:00Z' }),
  view(2, ['dashboard', 'light-mode'], { title: 'apple', analysedAt: '2026-01-05T00:00:00Z' }),
  view(3, ['poster'], { title: 'Item 10' }),
  view(4, ['dark-mode'], { title: 'Item 9' }),
];

test('tagCounts: most used first, ties A to Z', () => {
  assert.deepEqual(tagCounts(library), [
    { name: 'dark-mode', count: 2 },
    { name: 'dashboard', count: 2 },
    { name: 'light-mode', count: 1 },
    { name: 'minimal', count: 1 },
    { name: 'poster', count: 1 },
  ]);
  assert.deepEqual(tagCounts([]), []);
});

test('filterByTags needs every selected tag; nothing selected shows everything', () => {
  assert.equal(filterByTags(library, []).length, 4);
  assert.deepEqual(filterByTags(library, ['dashboard']).map((i) => i.id), [1, 2]);
  assert.deepEqual(filterByTags(library, ['dashboard', 'dark-mode']).map((i) => i.id), [1]);
  assert.deepEqual(filterByTags(library, ['dashboard', 'poster']), []);
  assert.deepEqual(filterByTags(library, ['nope']), []);
});

test('toggleTag adds, removes and keeps order', () => {
  assert.deepEqual(toggleTag([], 'a'), ['a']);
  assert.deepEqual(toggleTag(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(toggleTag(['a'], 'b'), ['a', 'b']);
});

test('the filter round-trips through the URL and leaves other parameters alone', () => {
  assert.deepEqual(parseTagsParam('?tags=dashboard,dark-mode'), ['dashboard', 'dark-mode']);
  assert.deepEqual(parseTagsParam('?tags=a,,a, b ,'), ['a', 'b']);
  assert.deepEqual(parseTagsParam(''), []);
  assert.deepEqual(parseTagsParam('?tags=a%2Cb'), ['a', 'b']);
  assert.equal(withTagsParam('', ['a', 'b']), '?tags=a,b');
  assert.equal(withTagsParam('?tags=a,b&x=1', []), '?x=1');
  assert.equal(withTagsParam('?tags=a', []), '');
  assert.equal(withTagsParam('?x=1', ['c']), '?x=1&tags=c');
});

test('sortItems: newest keeps order, A to Z is case- and number-aware, analysed puts the freshest first', () => {
  const ids = (xs: ItemView[]) => xs.map((i) => i.id);
  assert.deepEqual(ids(sortItems(library, 'newest')), [1, 2, 3, 4]);
  assert.deepEqual(ids(sortItems(library, 'az')), [2, 4, 3, 1]); // apple, Item 9, Item 10, Zebra
  assert.deepEqual(ids(sortItems(library, 'analysed')), [2, 1, 4, 3]); // never-analysed last, by name
  const before = ids(library);
  sortItems(library, 'az');
  assert.deepEqual(ids(library), before); // input untouched
  assert.deepEqual(ids(sortItems([view(9, [], { title: null, relPath: 'sub/Beta.png' }), view(8, [], { title: 'Alpha' })], 'az')), [8, 9]);
});

// ---------- edit validation ----------

const vocab = ['dark-mode', 'dashboard'];
const ok = (body: unknown) => {
  const r = validateEdit(body, vocab);
  assert.ok(r.ok, JSON.stringify(r));
  return r.ok ? r.patch : {};
};
const bad = (body: unknown, re: RegExp) => {
  const r = validateEdit(body, vocab);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, re);
};

test('edits: only the six editable fields are accepted', () => {
  bad({ palette: [] }, /"palette" cannot be edited/);
  bad({ status: 'analysed' }, /cannot be edited/);
  bad({}, /Nothing to change/);
  bad([], /object/);
  bad('title', /object/);
  bad(null, /object/);
});

test('edits: null reverts a field', () => {
  assert.deepEqual(ok({ title: null, tags: null }), { title: null, tags: null });
});

test('edits: text is tidied and limited', () => {
  assert.deepEqual(ok({ title: '  My Name  ', description: 'line one\r\nline two\r\n' }), { title: 'My Name', description: 'line one\nline two' });
  assert.deepEqual(ok({ description: '' }), { description: '' }); // blanking a body field is allowed
  bad({ title: '   ' }, /cannot be empty/);
  bad({ title: 'x'.repeat(LIMITS.title + 1) }, /longer than 120/);
  bad({ styleGuide: 'x'.repeat(LIMITS.styleGuide + 1) }, /styleGuide is longer/);
  bad({ title: 5 }, /must be text/);
});

test('edits: tags are normalised onto the existing vocabulary and capped', () => {
  assert.deepEqual(ok({ tags: ['Dark Modes', 'Dashboards', 'Brand New!', 'brand-new'] }), { tags: ['dark-mode', 'dashboard', 'brand-new'] });
  assert.deepEqual(ok({ tags: [] }), { tags: [] });
  const many = Array.from({ length: 30 }, (_, i) => `tag-${i}x`);
  assert.equal((ok({ tags: many }).tags as string[]).length, LIMITS.tags);
  bad({ tags: 'dark-mode' }, /list of text/);
  bad({ tags: [1] }, /list of text/);
});

test('edits: keywords are trimmed and de-duplicated, with limits', () => {
  assert.deepEqual(ok({ keywords: ['  soft   shadows ', 'Soft Shadows', '', 'glass'] }), { keywords: ['soft shadows', 'glass'] });
  bad({ keywords: ['x'.repeat(LIMITS.keywordLength + 1)] }, /longer than 80/);
  bad({ keywords: Array.from({ length: 41 }, (_, i) => `k${i}`) }, /At most 40/);
  bad({ keywords: 'a,b' }, /list of text/);
});

// ---------- store: applying and reverting edits ----------

const newItem = (relPath: string): NewItem => ({ relPath, kind: 'image', size: 1, mtimeMs: 1, contentHash: `h-${relPath}`, width: 1, height: 1, durationS: null });

function analysedItem(tags = ['dashboard', 'dark-mode']) {
  const s = new Store(openDb(':memory:'));
  const id = s.insertItem(newItem('a.png'));
  s.db.prepare("UPDATE items SET status='analysing' WHERE id=?").run(id);
  s.saveAnalysis(id, 'h-a.png', goodAnalysis(), tags, 2);
  return { s, id };
}

test('applyEdits stores the edit, keeps the AI result, and replaces the tag list', () => {
  const { s, id } = analysedItem();
  const row = s.applyEdits(id, { title: 'Mine', tags: ['mine', 'dashboard'] })!;
  assert.deepEqual(JSON.parse(row.user_json!), { title: 'Mine', tags: ['mine', 'dashboard'] });
  assert.equal(JSON.parse(row.ai_json!).title, 'Midnight Ledger Dashboard');
  assert.deepEqual(s.tagsFor(id), ['dashboard', 'mine']);
  assert.deepEqual((s.db.prepare('SELECT DISTINCT source FROM item_tags').all() as { source: string }[]).map((r) => r.source), ['user']);
  assert.ok(!s.tagVocabulary().includes('dark-mode')); // nobody uses it now, so it is pruned
});

test('reverting removes only that edit; reverting tags brings the AI tags back', () => {
  const { s, id } = analysedItem();
  s.applyEdits(id, { title: 'Mine', tags: ['mine'] });
  const afterTitle = s.applyEdits(id, { title: null })!;
  assert.deepEqual(JSON.parse(afterTitle.user_json!), { tags: ['mine'] });
  const afterTags = s.applyEdits(id, { tags: null })!;
  assert.equal(afterTags.user_json, null); // nothing left to remember
  assert.deepEqual(s.tagsFor(id), ['dark-mode', 'dashboard', 'minimal']); // the fixture's three AI tags, tidied
  assert.ok(!s.tagVocabulary().includes('mine'));
});

test('an unknown id changes nothing', () => {
  const { s } = analysedItem();
  assert.equal(s.applyEdits(999, { title: 'x' }), undefined);
});

test('an unanalysed item can still be named and tagged', () => {
  const s = new Store(openDb(':memory:'));
  const id = s.insertItem(newItem('p.png'));
  const row = s.applyEdits(id, { title: 'Before analysis', tags: ['inbox'] })!;
  assert.equal(row.status, 'pending');
  assert.deepEqual(s.tagsFor(id), ['inbox']);
  s.applyEdits(id, { tags: null });
  assert.deepEqual(s.tagsFor(id), []); // no AI tags to restore yet
});

// ---------- edits survive re-analysis ----------

test('a new analysis never overwrites edited fields or an edited tag list', async () => {
  const source = tmpDir('src-');
  const dataDir = tmpDir('data-');
  ensureDataDirs(dataDir);
  write(source, 'a.png', 'aaa');
  const store = new Store(openDb(':memory:'));
  await syncLibrary({ store, sourceFolder: source, dataDir, probe: async () => ({ width: 1, height: 1, durationS: null }) });
  await analysePending({ store, sourceFolder: source, dataDir, exec: stubExec(() => envelope(goodAnalysis())) });
  const id = store.getByPath('a.png')!.id;

  store.applyEdits(id, { title: 'My Title', keywords: ['mine'], tags: ['mine-only'] });
  store.requeue(99, id);
  const second = goodAnalysis({ title: 'Second Opinion', keywords: ['a1', 'b2', 'c3', 'd4', 'e5'], tags: ['poster', 'bold'] });
  await analysePending({ store, sourceFolder: source, dataDir, exec: stubExec(() => envelope(second)) });

  const row = store.getItem(id)!;
  assert.equal(JSON.parse(row.ai_json!).title, 'Second Opinion'); // AI side moved on
  assert.deepEqual(JSON.parse(row.user_json!), { title: 'My Title', keywords: ['mine'], tags: ['mine-only'] }); // yours did not
  assert.deepEqual(store.tagsFor(id), ['mine-only']);

  // reverting the tags now shows the NEW AI tags
  store.applyEdits(id, { tags: null });
  assert.deepEqual(store.tagsFor(id), ['bold', 'poster']);
});

// ---------- HTTP ----------

async function withApp(fn: (base: string, store: Store) => Promise<void>) {
  const source = tmpDir('src-');
  const dataDir = tmpDir('data-');
  ensureDataDirs(dataDir);
  saveConfig(dataDir, { sourceFolder: source, concurrency: 1, model: null, keyframeMode: 'even', keyframeCount: 6 });
  write(source, 'a.png', 'aaa');
  const store = new Store(openDb(':memory:'));
  await syncLibrary({ store, sourceFolder: source, dataDir, probe: async () => ({ width: 1, height: 1, durationS: null }) });
  const row = store.getByPath('a.png')!;
  store.db.prepare("UPDATE items SET status='analysing' WHERE id=?").run(row.id);
  store.saveAnalysis(row.id, row.content_hash, goodAnalysis(), ['dashboard', 'dark-mode'], 2);
  const app = createApp({ store, dataDir, uiDir: tmpDir('ui-') });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, store);
  } finally {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  }
}

const patch = (base: string, id: number, body: unknown, raw = false) =>
  fetch(`${base}/api/items/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: raw ? (body as string) : JSON.stringify(body) });

test('PATCH saves an edit, returns the full record, and the grid sees it', async () => {
  await withApp(async (base, store) => {
    const id = store.getByPath('a.png')!.id;
    const res = await patch(base, id, { title: '  Edited Name ', tags: ['Dark Modes', 'fresh'], keywords: ['one', 'two'] });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.title, 'Edited Name');
    assert.deepEqual(d.tags, ['dark-mode', 'fresh']);
    assert.deepEqual(d.user, { title: 'Edited Name', tags: ['dark-mode', 'fresh'], keywords: ['one', 'two'] });
    assert.equal(d.ai.title, 'Midnight Ledger Dashboard');
    assert.deepEqual(d.effective.keywords, ['one', 'two']);

    const list = await (await fetch(`${base}/api/items`)).json();
    assert.equal(list[0].title, 'Edited Name');
    assert.deepEqual(list[0].tags, ['dark-mode', 'fresh']);
    assert.ok(list[0].analysedAt);

    const back = await (await patch(base, id, { title: null, tags: null, keywords: null })).json();
    assert.equal(back.title, 'Midnight Ledger Dashboard');
    assert.deepEqual(back.user, {});
    assert.deepEqual(back.tags, ['dark-mode', 'dashboard', 'minimal']);
  });
});

test('PATCH refuses bad input with a clear 400, and an unknown item with 404', async () => {
  await withApp(async (base, store) => {
    const id = store.getByPath('a.png')!.id;
    for (const [body, re] of [
      [{ palette: [] }, /cannot be edited/],
      [{ title: '' }, /cannot be empty/],
      [{ tags: 'x' }, /list of text/],
      [{}, /Nothing to change/],
    ] as const) {
      const res = await patch(base, id, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json()).error, re);
    }
    const junk = await patch(base, id, '{nope', true);
    assert.equal(junk.status, 400);
    assert.match((await junk.json()).error, /not valid JSON/);
    assert.equal((await patch(base, 9999, { title: 'x' })).status, 404);
    assert.equal(JSON.parse(store.getItem(id)!.user_json ?? '{}').title, undefined); // nothing slipped through
  });
});

test('PATCH from another origin is refused', async () => {
  await withApp(async (base, store) => {
    const id = store.getByPath('a.png')!.id;
    const res = await fetch(`${base}/api/items/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'hijack' }),
    });
    assert.equal(res.status, 403);
    assert.equal(store.getItem(id)!.user_json, null);
  });
});
