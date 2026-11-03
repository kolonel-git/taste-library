import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { ANALYSIS_VERSION, buildPrompt } from '../src/analysis/prompt.ts';
import { validateAnalysis } from '../src/analysis/validate.ts';
import { analysePending } from '../src/analysis/analyse.ts';
import { descriptionText, everythingText, paletteText, styleGuideText } from '../src/shared/copytext.ts';
import { openDb, Store, type NewItem } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { ensureDataDirs, saveConfig } from '../src/server/config.ts';
import { syncLibrary } from '../src/server/sync.ts';
import { envelope, goodAnalysis, stubExec } from './fixtures.ts';
import { tmpDir, write } from './helpers.ts';

const HEADINGS = [
  'Design principles',
  'Colour',
  'Typography',
  'Layout & grid',
  'Spacing & sizing',
  'Shape, borders & elevation',
  'Components',
  'Iconography',
  'Imagery & illustration',
  'Motion',
  'Content & voice',
  'Accessibility',
  "Do and don't",
];

// --- prompt asks for one generic, paste-ready design system ---

test('prompt asks for every design-system section, in order, and for extrapolation', () => {
  const p = buildPrompt({ kind: 'image', files: ['/x/a.png'], tags: [] });
  let last = -1;
  for (const h of HEADINGS) {
    const at = p.indexOf(`### ${h}`);
    assert.ok(at > last, `missing or out of order: ${h}`);
    last = at;
  }
  assert.match(p, /DESIGN SYSTEM/);
  assert.match(p, /\(inferred\)/);
  assert.match(p, /do NOT appear in the image/i);
  assert.match(p, /Do not describe "the weather card"/);
});

test('the guide must be paste-ready, stand alone and never mention the image; there is no separate prompt', () => {
  const p = buildPrompt({ kind: 'image', files: ['/x/a.png'], tags: [] });
  assert.match(p, /paste-ready for an AI design or coding agent/);
  assert.match(p, /Use the following design system for everything you build in this project\./);
  assert.match(p, /Never mention the reference image/);
  assert.match(p, /extrapolate from the principles/);
  assert.doesNotMatch(p, /stylePrompt/);
});

test('a video prompt keeps the motion instruction', () => {
  const p = buildPrompt({ kind: 'video', files: ['/f/1.jpg', '/f/2.jpg'], tags: [], times: [1, 2] });
  assert.match(p, /### Motion/);
  assert.match(p, /keyframes from ONE video/);
});

// --- schema ---

test('there is no style prompt field any more: old-style output with one is refused, new output is fine', () => {
  assert.ok(validateAnalysis(goodAnalysis()).ok);
  const withExtra: any = { ...goodAnalysis(), stylePrompt: 'x'.repeat(500) };
  const r = validateAnalysis(withExtra);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /additional properties/);
});

test('semantic palette roles are accepted; a thin style guide is not', () => {
  const roles = ['success', 'warning', 'danger', 'info'].map((role, i) => ({ hex: `#00${i}0F0`, role }));
  const r = validateAnalysis(goodAnalysis({ palette: [...goodAnalysis().palette, ...(roles as any)] }));
  assert.ok(r.ok);
  assert.equal(validateAnalysis(goodAnalysis({ styleGuide: '### Colour\nblue' })).ok, false);
});

// --- copy text per section ---

const copyable = () => ({ title: 'T', tags: ['a', 'b'], effective: goodAnalysis() });

test('each section has its own copy text', () => {
  assert.equal(descriptionText(copyable()), goodAnalysis().description);
  assert.equal(paletteText(copyable()), '#0E0E10: background\n#17171A: surface (Ink)\n#E6C07B: accent');
  assert.equal(styleGuideText(copyable()), goodAnalysis().styleGuide.trim());
  assert.equal(paletteText({ ...copyable(), effective: {} }), '');
});

test('copy everything ends with the style guide', () => {
  const text = everythingText(copyable());
  assert.ok(text.indexOf('## Palette') < text.indexOf('## Keywords'));
  assert.ok(text.indexOf('## Keywords') < text.indexOf('## Style guide'));
  assert.doesNotMatch(text, /Style prompt/);
  assert.ok(text.trimEnd().endsWith(goodAnalysis().styleGuide.trim()));
});

// --- store: versions and requeue ---

const item = (relPath: string): NewItem => ({ relPath, kind: 'image', size: 1, mtimeMs: 1, contentHash: `h-${relPath}`, width: 1, height: 1, durationS: null });

function analysedStore() {
  const s = new Store(openDb(':memory:'));
  const old = s.insertItem(item('old.png'));
  const fresh = s.insertItem(item('new.png'));
  for (const [id, v] of [[old, 1], [fresh, ANALYSIS_VERSION]] as const) {
    s.db.prepare("UPDATE items SET status='analysing' WHERE id=?").run(id);
    s.saveAnalysis(id, `h-${id === old ? 'old' : 'new'}.png`, goodAnalysis(), ['dashboard'], v);
  }
  return { s, old, fresh };
}

test('items carry the version of the prompt that analysed them', () => {
  const { s, old, fresh } = analysedStore();
  assert.equal(s.getItem(old)!.analysis_version, 1);
  assert.equal(s.getItem(fresh)!.analysis_version, ANALYSIS_VERSION);
  assert.equal(s.countOutdated(ANALYSIS_VERSION), 1);
});

test('requeue with no id only takes older analyses; keeps the old result and hand edits', () => {
  const { s, old, fresh } = analysedStore();
  s.setUserJson(old, { title: 'Mine' });
  assert.equal(s.requeue(ANALYSIS_VERSION), 1);
  assert.equal(s.getItem(old)!.status, 'pending');
  assert.equal(s.getItem(fresh)!.status, 'analysed');
  assert.ok(s.getItem(old)!.ai_json);
  assert.equal(s.getItem(old)!.user_json, '{"title":"Mine"}');
  assert.equal(s.countOutdated(ANALYSIS_VERSION), 0); // no longer "analysed"
});

test('requeue with an id redoes that item whatever its version, and ignores non-analysed items', () => {
  const { s, fresh } = analysedStore();
  assert.equal(s.requeue(ANALYSIS_VERSION, fresh), 1);
  assert.equal(s.getItem(fresh)!.status, 'pending');
  assert.equal(s.requeue(ANALYSIS_VERSION, fresh), 0); // already pending
});

test('migration keeps existing analyses at version 1', () => {
  const s = new Store(openDb(':memory:'));
  const id = s.insertItem(item('a.png'));
  assert.equal(s.getItem(id)!.analysis_version, 1);
});

// --- analyser records the version and stores the prompt ---

test('a fresh analysis stores the current version and the paste-ready guide', async () => {
  const source = tmpDir('src-');
  const dataDir = tmpDir('data-');
  ensureDataDirs(dataDir);
  write(source, 'a.png', 'aaa');
  const store = new Store(openDb(':memory:'));
  await syncLibrary({ store, sourceFolder: source, dataDir, probe: async () => ({ width: 1, height: 1, durationS: null }) });
  await analysePending({ store, sourceFolder: source, dataDir, exec: stubExec(() => envelope(goodAnalysis())) });
  const row = store.getByPath('a.png')!;
  assert.equal(row.analysis_version, ANALYSIS_VERSION);
  assert.match(JSON.parse(row.ai_json!).styleGuide, /^Use the following design system/);
  assert.equal(JSON.parse(row.ai_json!).stylePrompt, undefined);
});

// --- HTTP: re-analyse routes ---

async function withApp(fn: (base: string, ctx: { store: Store; calls: () => number }) => Promise<void>, claudeOk = true) {
  const source = tmpDir('src-');
  const dataDir = tmpDir('data-');
  ensureDataDirs(dataDir);
  saveConfig(dataDir, { sourceFolder: source, concurrency: 1, model: null, keyframeMode: 'even', keyframeCount: 6 });
  write(source, 'a.png', 'aaa');
  const store = new Store(openDb(':memory:'));
  await syncLibrary({ store, sourceFolder: source, dataDir, probe: async () => ({ width: 1, height: 1, durationS: null }) });
  const exec = stubExec(() => envelope(goodAnalysis({ title: 'Second Pass' })));
  const app = createApp({
    store,
    dataDir,
    uiDir: tmpDir('ui-'),
    exec,
    checkTools: async () => ({ ffmpeg: { ok: true }, claude: claudeOk ? { ok: true } : { ok: false, message: 'claude missing' } }),
  });
  await app.refreshTools();
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, { store, calls: () => exec.calls });
  } finally {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  }
}

const settle = async (store: Store) => {
  for (let i = 0; i < 100; i++) {
    if (store.countsByStatus().analysing === 0 && store.countAnalysable() === 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
};

function analyseOldItem(store: Store) {
  const row = store.getByPath('a.png')!;
  store.db.prepare("UPDATE items SET status='analysing' WHERE id=?").run(row.id);
  store.saveAnalysis(row.id, row.content_hash, goodAnalysis({ title: 'First Pass' }), ['dashboard'], 1);
  return row.id;
}

test('status reports how many analyses are out of date; detail marks an old one', async () => {
  await withApp(async (base, { store }) => {
    const id = analyseOldItem(store);
    assert.equal((await (await fetch(`${base}/api/status`)).json()).outdated, 1);
    assert.equal((await (await fetch(`${base}/api/items/${id}`)).json()).outdated, true);
  });
});

test('POST /api/reanalyse-outdated redoes older items with the current prompt', async () => {
  await withApp(async (base, { store, calls }) => {
    const id = analyseOldItem(store);
    store.setUserJson(id, { title: 'Mine' });
    const res = await fetch(`${base}/api/reanalyse-outdated`, { method: 'POST' });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { started: true, queued: 1 });
    await settle(store);
    const row = store.getItem(id)!;
    assert.equal(calls(), 1);
    assert.equal(row.analysis_version, ANALYSIS_VERSION);
    assert.equal(JSON.parse(row.ai_json!).title, 'Second Pass');
    assert.equal(row.user_json, '{"title":"Mine"}'); // hand edit kept
    const again = await (await fetch(`${base}/api/reanalyse-outdated`, { method: 'POST' })).json();
    assert.deepEqual(again, { started: false, queued: 0 });
  });
});

test('POST /api/items/:id/reanalyse redoes one analysed item; refuses others and a missing CLI', async () => {
  await withApp(async (base, { store }) => {
    const id = analyseOldItem(store);
    assert.equal((await fetch(`${base}/api/items/${id}/reanalyse`, { method: 'POST' })).status, 202);
    await settle(store);
    assert.equal(JSON.parse(store.getItem(id)!.ai_json!).title, 'Second Pass');
    assert.equal((await fetch(`${base}/api/items/9999/reanalyse`, { method: 'POST' })).status, 409);
  });
  await withApp(async (base, { store }) => {
    const id = analyseOldItem(store);
    const res = await fetch(`${base}/api/items/${id}/reanalyse`, { method: 'POST' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /claude missing/);
    assert.equal(store.getItem(id)!.status, 'analysed'); // untouched
  }, false);
});

// --- shorter description ---

test('prompt asks for a 150 to 200 word plain-prose description', () => {
  const p = buildPrompt({ kind: 'image', files: ['/x/a.png'], tags: [] });
  assert.match(p, /Write 150 to 200 words \(never more than 200\)/);
  assert.match(p, /plain prose, no lists/);
});

test('an over-long description is rejected, a normal one passes', () => {
  assert.equal(validateAnalysis(goodAnalysis({ description: 'word '.repeat(450) })).ok, false); // ~2,250 characters
  assert.ok(validateAnalysis(goodAnalysis({ description: 'word '.repeat(190).trim() })).ok);
});

// --- retry all failed, and a failed re-analysis keeps the earlier result ---

test('retryAllFailed puts every failed item back, and only those', () => {
  const s = new Store(openDb(':memory:'));
  const a = s.insertItem(item('a.png'));
  const b = s.insertItem(item('b.png'));
  s.insertItem(item('c.png'));
  for (const id of [a, b]) s.db.prepare("UPDATE items SET status='failed', error='boom' WHERE id=?").run(id);
  assert.equal(s.retryAllFailed(), 2);
  assert.deepEqual(s.countsByStatus(), { pending: 3, analysing: 0, analysed: 0, failed: 0 });
  assert.equal(s.getItem(a)!.error, null);
});

test('POST /api/retry-failed requeues and re-runs failed items', async () => {
  await withApp(async (base, { store, calls }) => {
    const row = store.getByPath('a.png')!;
    store.db.prepare("UPDATE items SET status='failed', error='Not signed in' WHERE id=?").run(row.id);
    const res = await fetch(`${base}/api/retry-failed`, { method: 'POST' });
    assert.deepEqual(await res.json(), { started: true, queued: 1 });
    await settle(store);
    assert.equal(store.getItem(row.id)!.status, 'analysed');
    assert.equal(calls(), 1);
    assert.deepEqual(await (await fetch(`${base}/api/retry-failed`, { method: 'POST' })).json(), { started: false, queued: 0 });
  });
});

test('a failed re-analysis keeps the earlier analysis in the record', async () => {
  const { s, old } = analysedStore();
  s.db.prepare("UPDATE items SET status='analysing' WHERE id=?").run(old);
  s.markFailed(old, 'h-old.png', 'login expired');
  const row = s.getItem(old)!;
  assert.equal(row.status, 'failed');
  assert.equal(JSON.parse(row.ai_json!).title, 'Midnight Ledger Dashboard');
});
