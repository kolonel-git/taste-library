import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChanges, type KnownFile } from '../src/server/changes.ts';
import type { ScannedFile } from '../src/server/scanner.ts';

const scanned = (relPath: string, size = 10, mtimeMs = 1000): ScannedFile => ({
  relPath,
  absPath: `/src/${relPath}`,
  kind: 'image',
  size,
  mtimeMs,
});
const known = (id: number, rel_path: string, hash: string, size = 10, mtime_ms = 1000): KnownFile => ({
  id,
  rel_path,
  size,
  mtime_ms,
  content_hash: hash,
});

function hasher(map: Record<string, string>) {
  const calls: string[] = [];
  return { calls, fn: async (abs: string) => (calls.push(abs), map[abs] ?? 'new-hash') };
}

test('new files are added and hashed', async () => {
  const h = hasher({});
  const r = await detectChanges([], [scanned('a.png')], h.fn);
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].hash, 'new-hash');
  assert.deepEqual([r.changed.length, r.touched.length, r.deleted.length, r.unchanged], [0, 0, 0, 0]);
});

test('unchanged files (same size + mtime) are not re-hashed', async () => {
  const h = hasher({});
  const r = await detectChanges([known(1, 'a.png', 'x')], [scanned('a.png')], h.fn);
  assert.equal(r.unchanged, 1);
  assert.equal(h.calls.length, 0);
});

test('size or mtime differs and hash differs -> changed', async () => {
  const h = hasher({ '/src/a.png': 'y' });
  const r = await detectChanges([known(7, 'a.png', 'x')], [scanned('a.png', 11, 2000)], h.fn);
  assert.equal(r.changed.length, 1);
  assert.equal(r.changed[0].id, 7);
  assert.equal(r.changed[0].hash, 'y');
});

test('mtime differs but hash is identical -> touched, not changed', async () => {
  const h = hasher({ '/src/a.png': 'x' });
  const r = await detectChanges([known(1, 'a.png', 'x')], [scanned('a.png', 10, 5000)], h.fn);
  assert.deepEqual([r.changed.length, r.touched.length], [0, 1]);
});

test('missing files are deleted', async () => {
  const r = await detectChanges([known(1, 'a.png', 'x'), known(2, 'b.png', 'y')], [scanned('a.png')], hasher({}).fn);
  assert.deepEqual(
    r.deleted.map((d) => d.rel_path),
    ['b.png'],
  );
  assert.equal(r.unchanged, 1);
});

test('a rename is one delete plus one add', async () => {
  const r = await detectChanges([known(1, 'old.png', 'x')], [scanned('new.png')], hasher({ '/src/new.png': 'x' }).fn);
  assert.deepEqual(
    r.deleted.map((d) => d.rel_path),
    ['old.png'],
  );
  assert.deepEqual(
    r.added.map((a) => a.relPath),
    ['new.png'],
  );
});
