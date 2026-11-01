import { DatabaseSync } from 'node:sqlite';
import type { ItemKind, ItemStatus } from '../shared/types.ts';

export interface ItemRow {
  id: number;
  rel_path: string;
  kind: ItemKind;
  size: number;
  mtime_ms: number;
  content_hash: string;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  status: ItemStatus;
  error: string | null;
  ai_json: string | null;
  user_json: string | null;
  analysed_hash: string | null;
  added_at: string;
  updated_at: string;
  analysed_at: string | null;
}

export interface NewItem {
  relPath: string;
  kind: ItemKind;
  size: number;
  mtimeMs: number;
  contentHash: string;
  width: number | null;
  height: number | null;
  durationS: number | null;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE items (
    id            INTEGER PRIMARY KEY,
    rel_path      TEXT NOT NULL UNIQUE,
    kind          TEXT NOT NULL CHECK (kind IN ('image','video')),
    size          INTEGER NOT NULL,
    mtime_ms      INTEGER NOT NULL,
    content_hash  TEXT NOT NULL,
    width         INTEGER,
    height        INTEGER,
    duration_s    REAL,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','analysing','analysed','failed')),
    error         TEXT,
    ai_json       TEXT,
    user_json     TEXT,
    analysed_hash TEXT,
    added_at      TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    analysed_at   TEXT
  );
  CREATE INDEX items_status ON items(status);
  CREATE TABLE tags (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE item_tags (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    source  TEXT NOT NULL CHECK (source IN ('ai','user')),
    PRIMARY KEY (item_id, tag_id)
  );
  CREATE INDEX item_tags_tag ON item_tags(tag_id);
  `,
];

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

const now = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  allItems(): ItemRow[] {
    return this.db.prepare('SELECT * FROM items ORDER BY added_at DESC, id DESC').all() as unknown as ItemRow[];
  }

  getItem(id: number): ItemRow | undefined {
    return this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as unknown as ItemRow | undefined;
  }

  getByPath(relPath: string): ItemRow | undefined {
    return this.db.prepare('SELECT * FROM items WHERE rel_path = ?').get(relPath) as unknown as ItemRow | undefined;
  }

  insertItem(item: NewItem): number {
    const t = now();
    const res = this.db
      .prepare(
        `INSERT INTO items (rel_path, kind, size, mtime_ms, content_hash, width, height, duration_s, status, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(item.relPath, item.kind, item.size, item.mtimeMs, item.contentHash, item.width, item.height, item.durationS, t, t);
    return Number(res.lastInsertRowid);
  }

  /**
   * File contents changed: refresh file facts and queue for re-analysis.
   * ai_json is kept until the new analysis lands; user_json is never touched.
   */
  markChanged(id: number, item: NewItem): void {
    this.db
      .prepare(
        `UPDATE items SET kind = ?, size = ?, mtime_ms = ?, content_hash = ?, width = ?, height = ?, duration_s = ?,
           status = 'pending', error = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(item.kind, item.size, item.mtimeMs, item.contentHash, item.width, item.height, item.durationS, now(), id);
  }

  /** Same bytes, new size/mtime bookkeeping only. */
  touch(id: number, size: number, mtimeMs: number): void {
    this.db.prepare('UPDATE items SET size = ?, mtime_ms = ? WHERE id = ?').run(size, mtimeMs, id);
  }

  deleteItem(id: number): void {
    this.db.prepare('DELETE FROM items WHERE id = ?').run(id);
  }

  setUserJson(id: number, userJson: Record<string, unknown> | null): void {
    this.db
      .prepare('UPDATE items SET user_json = ?, updated_at = ? WHERE id = ?')
      .run(userJson ? JSON.stringify(userJson) : null, now(), id);
  }

  countsByStatus(): Record<ItemStatus, number> {
    const counts: Record<ItemStatus, number> = { pending: 0, analysing: 0, analysed: 0, failed: 0 };
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM items GROUP BY status').all() as unknown as {
      status: ItemStatus;
      n: number;
    }[];
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  }

  tagsFor(itemId: number): string[] {
    const rows = this.db
      .prepare('SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ? ORDER BY t.name')
      .all(itemId) as unknown as { name: string }[];
    return rows.map((r) => r.name);
  }
}
