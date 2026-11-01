import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, Store } from '../src/server/db.ts';
import { syncLibrary } from '../src/server/sync.ts';
import { ensureDataDirs, validateSourceFolder } from '../src/server/config.ts';
import { thumbFile } from '../src/server/media.ts';
import { snapshot, tmpDir, write } from './helpers.ts';

const probe = async () => ({ width: 100, height: 50, durationS: null });

function setup() {
  const source = tmpDir('src-');
  const dataDir = tmpDir('data-');
  ensureDataDirs(dataDir);
  const store = new Store(openDb(':memory:'));
  const run = () => syncLibrary({ store, sourceFolder: source, dataDir, probe });
  return { source, dataDir, store, run };
}

test('first sync adds every supported file as pending', async () => {
  const { source, store, run } = setup();
  write(source, 'a.png', 'aaa');
  write(source, 'sub/b.mp4', 'bbb');
  write(source, 'readme.txt');

  const s = await run();
  assert.deepEqual([s.added, s.changed, s.deleted, s.skipped], [2, 0, 0, 1]);
  const rows = store.allItems();
  assert.deepEqual(rows.map((r) => r.rel_path).sort(), ['a.png', 'sub/b.mp4']);
  assert.ok(rows.every((r) => r.status === 'pending' && r.width === 100));
  assert.deepEqual(store.countsByStatus().pending, 2);
});

test('second sync with no changes is a no-op', async () => {
  const { source, run } = setup();
  write(source, 'a.png', 'aaa');
  await run();
  const s = await run();
  assert.deepEqual([s.added, s.changed, s.deleted, s.unchanged], [0, 0, 0, 1]);
});

test('deleting a file removes its item and thumbnails', async () => {
  const { source, dataDir, store, run } = setup();
  const f = write(source, 'a.png', 'aaa');
  write(source, 'b.png', 'bbb');
  await run();
  const gone = store.getByPath('a.png')!;
  const thumb = thumbFile(dataDir, gone.id, gone.content_hash);
  fs.writeFileSync(thumb, 'jpg');

  fs.rmSync(f);
  const s = await run();
  assert.equal(s.deleted, 1);
  assert.equal(store.getByPath('a.png'), undefined);
  assert.ok(store.getByPath('b.png'));
  assert.equal(fs.existsSync(thumb), false);
});

test('rename = delete + new item, queued for analysis again', async () => {
  const { source, store, run } = setup();
  write(source, 'old.png', 'same bytes');
  await run();
  const oldId = store.getByPath('old.png')!.id;
  store.db.prepare("UPDATE items SET status='analysed' WHERE id=?").run(oldId);

  fs.renameSync(path.join(source, 'old.png'), path.join(source, 'new.png'));
  const s = await run();
  assert.deepEqual([s.added, s.deleted], [1, 1]);
  assert.equal(store.getByPath('old.png'), undefined);
  assert.equal(store.getByPath('new.png')!.status, 'pending');
});

test('changed contents -> pending again, hand edits kept, old thumb dropped', async () => {
  const { source, dataDir, store, run } = setup();
  const f = write(source, 'a.png', 'version one');
  await run();
  const row = store.getByPath('a.png')!;
  store.db.prepare("UPDATE items SET status='analysed', ai_json='{\"title\":\"AI\"}' WHERE id=?").run(row.id);
  store.setUserJson(row.id, { title: 'Mine' });
  const oldThumb = thumbFile(dataDir, row.id, row.content_hash);
  fs.writeFileSync(oldThumb, 'jpg');

  fs.writeFileSync(f, 'version two, longer');
  const s = await run();
  assert.equal(s.changed, 1);
  const after = store.getByPath('a.png')!;
  assert.equal(after.id, row.id);
  assert.equal(after.status, 'pending');
  assert.notEqual(after.content_hash, row.content_hash);
  assert.equal(after.user_json, '{"title":"Mine"}');
  assert.equal(fs.existsSync(oldThumb), false);
});

test('touching a file without changing bytes keeps its analysis', async () => {
  const { source, store, run } = setup();
  const f = write(source, 'a.png', 'same');
  await run();
  const id = store.getByPath('a.png')!.id;
  store.db.prepare("UPDATE items SET status='analysed' WHERE id=?").run(id);

  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(f, later, later);
  const s = await run();
  assert.deepEqual([s.changed, s.unchanged], [0, 1]);
  assert.equal(store.getItem(id)!.status, 'analysed');
});

test('a missing source folder throws and never empties the library', async () => {
  const { source, store, run } = setup();
  write(source, 'a.png', 'aaa');
  await run();
  fs.rmSync(source, { recursive: true });
  await assert.rejects(run, /Source folder not found/);
  assert.equal(store.allItems().length, 1);
});

test('sync never writes to the source folder', async () => {
  const { source, run } = setup();
  write(source, 'a.png', 'aaa');
  write(source, 'sub/b.mp4', 'bbb');
  write(source, 'notes.txt', 'x');
  const before = snapshot(source);
  await run();
  await run();
  assert.deepEqual(snapshot(source), before);
});

test('validateSourceFolder rejects missing folders, files, and the data dir', () => {
  const source = tmpDir('src-');
  const file = write(source, 'a.png');
  const dataDir = tmpDir('data-');
  assert.equal(validateSourceFolder(`"${source}"`, dataDir), path.resolve(source));
  assert.throws(() => validateSourceFolder(path.join(source, 'nope'), dataDir), /not found/);
  assert.throws(() => validateSourceFolder(file, dataDir), /Not a folder/);
  assert.throws(() => validateSourceFolder(dataDir, dataDir), /app data folder/);
  assert.throws(() => validateSourceFolder(path.dirname(dataDir), dataDir), /app data folder/);
});
