import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAnalysis } from '../src/analysis/validate.ts';
import { normaliseTag, resolveTags, tagKey } from '../src/analysis/tags.ts';
import { effectiveFields } from '../src/analysis/merge.ts';
import { buildPrompt } from '../src/analysis/prompt.ts';
import { OutputError, parseClaudeOutput } from '../src/analysis/claude.ts';
import { envelope, goodAnalysis } from './fixtures.ts';

// --- schema validation ---

test('a good analysis validates and is tidied', () => {
  const r = validateAnalysis(goodAnalysis());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.palette[0].hex, '#0E0E10');
  assert.deepEqual(r.value.keywords, ['dark ui', 'kpi cards', 'data density', 'soft borders', 'financial']); // "Dark UI" duplicate dropped
  assert.deepEqual(r.value.tags, ['dashboard', 'dark-mode', 'minimal']); // "Dashboard" tidied to kebab-case
});

for (const [name, mutate, expect] of [
  ['missing field', (a: any) => delete a.styleGuide, /styleGuide/],
  ['extra property', (a: any) => (a.extra = 1), /additional/],
  ['bad hex', (a: any) => (a.palette[0].hex = 'red'), /pattern/],
  ['bad role', (a: any) => (a.palette[0].role = 'neon'), /allowed values/],
  ['title too long', (a: any) => (a.title = 'x'.repeat(61)), /title/],
  ['too few keywords', (a: any) => (a.keywords = ['one']), /keywords/],
  ['tags that normalise to nothing', (a: any) => (a.tags = ['!!!', '???', 'ok']), /tags/],
  ['wrong type', (a: any) => (a.palette = 'nope'), /array/],
] as const) {
  test(`rejects: ${name}`, () => {
    const a: any = goodAnalysis();
    mutate(a);
    const r = validateAnalysis(a);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, expect);
  });
}

test('rejects non-objects', () => {
  for (const v of [null, 'text', 42, []]) assert.equal(validateAnalysis(v).ok, false);
});

// --- tags ---

test('normaliseTag makes kebab-case', () => {
  assert.equal(normaliseTag('Dark Mode!'), 'dark-mode');
  assert.equal(normaliseTag('  UI / UX  '), 'ui-ux');
  assert.equal(normaliseTag('Café & Bar'), 'cafe-and-bar');
  assert.equal(normaliseTag('---'), '');
});

test('tagKey folds hyphens and plurals', () => {
  assert.equal(tagKey('dark-mode'), tagKey('darkmode'));
  assert.equal(tagKey('dark-mode'), tagKey('Dark Modes'));
  assert.equal(tagKey('dashboards'), tagKey('dashboard'));
  assert.equal(tagKey('gallery'), tagKey('galleries'));
  assert.notEqual(tagKey('glass'), tagKey('glas '.trim() + 'x'));
  assert.equal(tagKey('glass'), 'glass'); // "ss" is not a plural
});

test('resolveTags reuses existing spellings and removes near-duplicates', () => {
  const existing = ['dark-mode', 'dashboard'];
  assert.deepEqual(resolveTags(existing, ['Dark Modes', 'darkmode', 'dashboards', 'minimal']), ['dark-mode', 'dashboard', 'minimal']);
});

test('resolveTags dedupes within a batch and caps the count', () => {
  assert.deepEqual(resolveTags([], ['dark-mode', 'DarkMode', 'dark-modes', 'c', 'd', 'e', 'f', 'g', 'h'], 4), ['dark-mode', 'c', 'd', 'e']);
  assert.deepEqual(resolveTags([], ['!!!', '']), []);
});

// --- user edits win ---

test('effectiveFields: hand edits win per field, the rest stays AI', () => {
  const ai = JSON.stringify(goodAnalysis());
  const user = JSON.stringify({ title: 'My Name', keywords: ['mine'] });
  const eff = effectiveFields(ai, user);
  assert.equal(eff.title, 'My Name');
  assert.deepEqual(eff.keywords, ['mine']);
  assert.equal(eff.description, goodAnalysis().description);
});

test('effectiveFields tolerates missing or corrupt json', () => {
  assert.deepEqual(effectiveFields(null, null), {});
  assert.deepEqual(effectiveFields('{nope', null), {});
  assert.equal(effectiveFields(JSON.stringify({ title: 'AI' }), '{nope').title, 'AI');
});

// --- prompt ---

test('prompt includes the file path and the existing tags', () => {
  const p = buildPrompt({ kind: 'image', files: ['C:/src/a.png'], tags: ['dark-mode', 'poster'] });
  assert.match(p, /C:\/src\/a\.png/);
  assert.match(p, /- dark-mode\n- poster/);
  assert.doesNotMatch(p, /\{\{/);
});

test('prompt copes with an empty vocabulary and video keyframes', () => {
  const p = buildPrompt({ kind: 'video', files: ['/f/1.jpg', '/f/2.jpg'], tags: [] });
  assert.match(p, /keyframes from ONE video/);
  assert.match(p, /starting the vocabulary/);
});

// --- claude output parsing ---

test('parses structured_output', () => {
  assert.deepEqual(parseClaudeOutput(envelope({ a: 1 })), { a: 1 });
});

test('falls back to JSON in result', () => {
  assert.deepEqual(parseClaudeOutput(JSON.stringify({ is_error: false, result: '{"a":2}' })), { a: 2 });
});

test('error envelope, junk and empty results are failures', () => {
  assert.throws(() => parseClaudeOutput(JSON.stringify({ is_error: true, result: 'Not logged in' })), /Not logged in/);
  assert.throws(() => parseClaudeOutput('Segmentation fault'), OutputError);
  assert.throws(() => parseClaudeOutput(JSON.stringify({ is_error: false, result: 'sorry, cannot' })), OutputError);
});
