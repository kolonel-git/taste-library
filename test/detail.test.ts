import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { renderMarkdown } from '../src/shared/markdown.ts';
import { everythingText, keywordsText, styleGuideText } from '../src/shared/copytext.ts';
import { neighbours, parseRoute, routeFor } from '../src/shared/route.ts';
import { openDb, Store } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { ensureDataDirs, saveConfig } from '../src/server/config.ts';
import { syncLibrary } from '../src/server/sync.ts';
import { goodAnalysis } from './fixtures.ts';
import { tmpDir, write } from './helpers.ts';

// --- markdown ---

test('renders headings (shifted below the sheet headings), lists, bold, italics and code', () => {
  const html = renderMarkdown('### Colour\n- Background **#0E0E10** and `#fff`\n- Accent *amber*\n\nPlain text\nsecond line\n\n1. one\n2. two');
  assert.match(html, /<h4>Colour<\/h4>/);
  assert.match(html, /<ul><li>Background <strong>#0E0E10<\/strong> and <code>#fff<\/code><\/li><li>Accent <em>amber<\/em><\/li><\/ul>/);
  assert.match(html, /<p>Plain text second line<\/p>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
});

test('model text can never inject markup', () => {
  const html = renderMarkdown('### <img src=x onerror=alert(1)>\n- <script>alert(1)</script> & "quoted"\n`<b>code</b>` **<i>x</i>**');
  assert.doesNotMatch(html, /<img|<script|<b>|<i>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp; &quot;quoted&quot;/);
  assert.match(html, /<code>&lt;b&gt;code&lt;\/b&gt;<\/code>/);
});

test('wrapped list items, windows newlines and empty input are handled', () => {
  assert.match(renderMarkdown('- first line\r\n  continued\r\n- second'), /<li>first line continued<\/li><li>second<\/li>/);
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('\n\n'), '');
  assert.match(renderMarkdown('####### too deep'), /<p>/); // not a heading, stays text
});

test('a real-shaped style guide renders every section', () => {
  const html = renderMarkdown(goodAnalysis().styleGuide);
  for (const h of ['Colour', 'Typography', 'Layout &amp; grid', 'Mood']) assert.match(html, new RegExp(`<h4>${h}</h4>`));
});

// --- copy text ---

const copyable = (over = {}) => ({
  title: 'Midnight Ledger Dashboard',
  tags: ['dark-mode', 'dashboard'],
  effective: goodAnalysis(),
  ...over,
});

test('copy keywords is a comma list; copy style guide is the raw markdown', () => {
  assert.equal(keywordsText(copyable()), 'dark ui, kpi cards, data density, soft borders, financial, Dark UI');
  assert.equal(styleGuideText(copyable()), goodAnalysis().styleGuide.trim());
});

test('copy everything has every part, in order, as markdown', () => {
  const text = everythingText(copyable());
  const at = (s: string) => text.indexOf(s);
  assert.ok(text.startsWith('# Midnight Ledger Dashboard\n'));
  assert.ok(at('Tags: dark-mode, dashboard') > 0);
  assert.ok(at('## Description') < at('## Palette'));
  assert.ok(at('## Palette') < at('## Keywords'));
  assert.ok(at('## Keywords') < at('## Style guide'));
  assert.match(text, /- #0E0E10: background\n/);
  assert.match(text, /- #17171A: surface \(Ink\)/);
  assert.match(text, /### Colour/);
  assert.ok(text.endsWith('\n'));
});

test('copy everything uses hand-edited values and skips missing parts', () => {
  const text = everythingText({ title: 'Mine', tags: [], effective: { title: 'Mine', keywords: ['one', 'two'] } });
  assert.equal(text, '# Mine\n\n## Keywords\n\none, two\n');
});

// --- routes ---

test('route parsing', () => {
  assert.equal(parseRoute('#/item/12'), 12);
  for (const bad of ['', '#', '#/item/', '#/item/x', '#/item/12/extra', '#/items/12', '/item/12']) assert.equal(parseRoute(bad), null, bad);
  assert.equal(parseRoute(routeFor(7)), 7);
});

test('neighbours: middle, both ends, unknown id, single item', () => {
  const ids = [10, 20, 30];
  assert.deepEqual(neighbours(ids, 20), { index: 1, total: 3, prev: 10, next: 30 });
  assert.deepEqual(neighbours(ids, 10), { index: 0, total: 3, prev: null, next: 20 });
  assert.deepEqual(neighbours(ids, 30), { index: 2, total: 3, prev: 20, next: null });
  assert.deepEqual(neighbours(ids, 99), { index: -1, total: 3, prev: null, next: null });
  assert.deepEqual(neighbours([5], 5), { index: 0, total: 1, prev: null, next: null });
});

// --- HTTP: detail and media routes ---

async function withServer(fn: (base: string, ctx: { store: Store; source: string }) => Promise<void>) {
  const source = tmpDir('src-');
  const dataDir = tmpDir('data-');
  ensureDataDirs(dataDir);
  saveConfig(dataDir, { sourceFolder: source, concurrency: 2, model: null, keyframeMode: 'even', keyframeCount: 6 });
  write(source, 'a.png', Buffer.from('0123456789'.repeat(10)));
  write(source, 'sub/b.webp', 'bbb');
  const store = new Store(openDb(':memory:'));
  await syncLibrary({ store, sourceFolder: source, dataDir, probe: async () => ({ width: 4, height: 3, durationS: null }) });
  const app = createApp({ store, dataDir, uiDir: tmpDir('ui-') });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    await fn(base, { store, source });
  } finally {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  }
}

test('GET /api/items/:id returns effective, AI and user values; unknown id is 404', async () => {
  await withServer(async (base, { store }) => {
    const row = store.getByPath('a.png')!;
    store.db.prepare("UPDATE items SET status='analysing' WHERE id=?").run(row.id);
    store.saveAnalysis(row.id, row.content_hash, goodAnalysis(), ['dashboard', 'dark-mode']);
    store.setUserJson(row.id, { title: 'My Own Title' });

    const d = await (await fetch(`${base}/api/items/${row.id}`)).json();
    assert.equal(d.title, 'My Own Title');
    assert.equal(d.effective.title, 'My Own Title');
    assert.equal(d.ai.title, 'Midnight Ledger Dashboard');
    assert.deepEqual(d.user, { title: 'My Own Title' });
    assert.equal(d.effective.palette.length, 3);
    assert.deepEqual(d.tags, ['dark-mode', 'dashboard']);
    assert.match(d.mediaUrl, /^\/media\/\d+\?v=/);

    assert.equal((await fetch(`${base}/api/items/9999`)).status, 404);
  });
});

test('GET /media/:id serves the original, with ranges, and refuses bad ones', async () => {
  await withServer(async (base, { store }) => {
    const id = store.getByPath('a.png')!.id;
    const full = await fetch(`${base}/media/${id}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'image/png');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal((await full.text()).length, 100);

    const part = await fetch(`${base}/media/${id}`, { headers: { range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/100');
    assert.equal(await part.text(), '0123456789');

    assert.equal((await fetch(`${base}/media/${id}`, { headers: { range: 'bytes=500-' } })).status, 416);
    assert.equal((await fetch(`${base}/media/9999`)).status, 404);
  });
});

test('GET /media/:id reports a vanished file as 404 rather than crashing', async () => {
  await withServer(async (base, { store, source }) => {
    const id = store.getByPath('sub/b.webp')!.id;
    assert.equal((await fetch(`${base}/media/${id}`)).headers.get('content-type'), 'image/webp');
    fs.rmSync(`${source}/sub/b.webp`);
    assert.equal((await fetch(`${base}/media/${id}`)).status, 404);
  });
});
