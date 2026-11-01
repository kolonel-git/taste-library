import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanFolder, kindOf } from '../src/server/scanner.ts';
import { tmpDir, write } from './helpers.ts';

test('kindOf recognises every supported format, case-insensitively', () => {
  for (const f of ['a.png', 'a.JPG', 'a.jpeg', 'a.webp', 'a.gif']) assert.equal(kindOf(f), 'image', f);
  for (const f of ['a.mp4', 'a.MOV', 'a.webm']) assert.equal(kindOf(f), 'video', f);
  for (const f of ['a.txt', 'a.psd', 'a', 'a.svg']) assert.equal(kindOf(f), null, f);
});

test('scanFolder walks subfolders, uses / paths, and skips unsupported files with a reason', async () => {
  const root = tmpDir();
  write(root, 'one.png');
  write(root, 'sub/two.MP4');
  write(root, 'sub/deep/three.webp');
  write(root, 'notes.txt');
  write(root, 'noext');

  const { files, skipped } = await scanFolder(root);
  assert.deepEqual(
    files.map((f) => [f.relPath, f.kind]),
    [
      ['one.png', 'image'],
      ['sub/deep/three.webp', 'image'],
      ['sub/two.MP4', 'video'],
    ],
  );
  assert.deepEqual(
    skipped.map((s) => s.relPath),
    ['noext', 'notes.txt'],
  );
  assert.match(skipped.find((s) => s.relPath === 'notes.txt')!.reason, /unsupported format ".txt"/);
  assert.ok(files.every((f) => f.size > 0 && f.mtimeMs > 0));
});

test('scanFolder on an empty folder returns nothing', async () => {
  const { files, skipped } = await scanFolder(tmpDir());
  assert.equal(files.length, 0);
  assert.equal(skipped.length, 0);
});
