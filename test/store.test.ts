import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, Store, type NewItem } from '../src/server/db.ts';

const item = (relPath: string, over: Partial<NewItem> = {}): NewItem => ({
  relPath,
  kind: 'image',
  size: 5,
  mtimeMs: 100,
  contentHash: 'h1',
  width: 10,
  height: 20,
  durationS: null,
  ...over,
});

const fresh = () => new Store(openDb(':memory:'));

test('migration sets schema version and tables exist', () => {
  const s = fresh();
  const v = s.db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(v.user_version, 2);
  const names = (s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  for (const t of ['items', 'tags', 'item_tags']) assert.ok(names.includes(t), t);
});

test('insert starts pending and rel_path is unique', () => {
  const s = fresh();
  const id = s.insertItem(item('a.png'));
  assert.equal(s.getItem(id)!.status, 'pending');
  assert.throws(() => s.insertItem(item('a.png')));
});

test('markChanged re-queues but keeps hand edits and the previous AI result', () => {
  const s = fresh();
  const id = s.insertItem(item('a.png'));
  s.db.prepare("UPDATE items SET status='analysed', ai_json='{\"title\":\"AI\"}' WHERE id=?").run(id);
  s.setUserJson(id, { title: 'Mine' });

  s.markChanged(id, item('a.png', { contentHash: 'h2', size: 9 }));
  const row = s.getItem(id)!;
  assert.equal(row.status, 'pending');
  assert.equal(row.content_hash, 'h2');
  assert.equal(row.user_json, '{"title":"Mine"}');
  assert.equal(row.ai_json, '{"title":"AI"}');
});

test('deleting an item removes its tag links but keeps the tag', () => {
  const s = fresh();
  const id = s.insertItem(item('a.png'));
  s.db.prepare("INSERT INTO tags (id, name) VALUES (1, 'dark-mode')").run();
  s.db.prepare("INSERT INTO item_tags (item_id, tag_id, source) VALUES (?, 1, 'ai')").run(id);
  assert.deepEqual(s.tagsFor(id), ['dark-mode']);

  s.deleteItem(id);
  assert.equal(s.getItem(id), undefined);
  assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM item_tags').get() as { n: number }).n, 0);
  assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n, 1);
});

test('transaction rolls back on error', () => {
  const s = fresh();
  assert.throws(() =>
    s.transaction(() => {
      s.insertItem(item('a.png'));
      s.insertItem(item('a.png'));
    }),
  );
  assert.equal(s.allItems().length, 0);
});

test('countsByStatus covers every status', () => {
  const s = fresh();
  s.insertItem(item('a.png'));
  const id = s.insertItem(item('b.png'));
  s.db.prepare("UPDATE items SET status='failed' WHERE id=?").run(id);
  assert.deepEqual(s.countsByStatus(), { pending: 1, analysing: 0, analysed: 0, failed: 1 });
});
