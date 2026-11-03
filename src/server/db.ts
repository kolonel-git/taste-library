import { DatabaseSync } from 'node:sqlite';
import type { ItemKind, ItemStatus } from '../shared/types.ts';
import { normaliseTag } from '../analysis/tags.ts';

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
  analysis_version: number;
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
  `ALTER TABLE items ADD COLUMN claimed_at TEXT;`,
  // Which prompt/schema version produced ai_json. Existing analyses are version 1.
  `ALTER TABLE items ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 1;`,
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

function userHasTags(userJson: string | null): boolean {
  if (!userJson) return false;
  try {
    return Array.isArray((JSON.parse(userJson) as { tags?: unknown }).tags);
  } catch {
    return false;
  }
}

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

  countAnalysable(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'pending'").get() as unknown as {
      n: number;
    };
    return row.n;
  }

  /** Atomically take the next pending item. Safe against a second process doing the same. */
  claimNext(): ItemRow | undefined {
    return this.db
      .prepare(
        `UPDATE items SET status = 'analysing', claimed_at = ?, error = NULL
         WHERE id = (SELECT id FROM items WHERE status = 'pending' ORDER BY id LIMIT 1)
         RETURNING *`,
      )
      .get(now()) as unknown as ItemRow | undefined;
  }

  /** Items stuck "analysing" (crashed run) go back to pending after a while. */
  releaseStaleClaims(maxAgeMs: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const res = this.db
      .prepare("UPDATE items SET status = 'pending', claimed_at = NULL WHERE status = 'analysing' AND (claimed_at IS NULL OR claimed_at < ?)")
      .run(cutoff);
    return Number(res.changes);
  }

  /**
   * Store an analysis. Only lands if the item is still being analysed for the same
   * file contents; otherwise the result is stale and dropped. Replaces AI tag links only.
   */
  saveAnalysis(id: number, contentHash: string, ai: unknown, tagNames: string[], version = 1): boolean {
    return this.transaction(() => {
      const t = now();
      const res = this.db
        .prepare(
          `UPDATE items SET ai_json = ?, status = 'analysed', error = NULL, analysed_hash = ?, analysed_at = ?,
             analysis_version = ?, claimed_at = NULL, updated_at = ? WHERE id = ? AND content_hash = ? AND status = 'analysing'`,
        )
        .run(JSON.stringify(ai), contentHash, t, version, t, id, contentHash);
      if (Number(res.changes) === 0) return false;
      // A hand-edited tag list is the user's, so a new analysis must not touch it.
      const row = this.db.prepare('SELECT user_json FROM items WHERE id = ?').get(id) as unknown as { user_json: string | null };
      if (!userHasTags(row.user_json)) this.replaceTags(id, tagNames, 'ai');
      return true;
    });
  }

  /** Replace every tag link of an item, then drop tags nobody uses any more. */
  private replaceTags(id: number, names: string[], source: 'ai' | 'user'): void {
    this.db.prepare('DELETE FROM item_tags WHERE item_id = ?').run(id);
    for (const name of names) {
      this.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
      const tag = this.db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as unknown as { id: number };
      this.db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, source) VALUES (?, ?, ?)').run(id, tag.id, source);
    }
    this.db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM item_tags)').run();
  }

  /**
   * Apply hand edits. A value sets the field; null removes the edit so the AI version shows again.
   * Edited tags replace the AI tags wholesale; reverting them restores the AI tags.
   */
  applyEdits(id: number, patch: Record<string, unknown>): ItemRow | undefined {
    return this.transaction(() => {
      const row = this.getItem(id);
      if (!row) return undefined;
      const user: Record<string, unknown> = row.user_json ? JSON.parse(row.user_json) : {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete user[key];
        else user[key] = value;
      }
      this.db
        .prepare('UPDATE items SET user_json = ?, updated_at = ? WHERE id = ?')
        .run(Object.keys(user).length ? JSON.stringify(user) : null, now(), id);

      if ('tags' in patch) {
        if (patch.tags === null) {
          const ai = row.ai_json ? (JSON.parse(row.ai_json) as { tags?: string[] }) : {};
          this.replaceTags(id, [...new Set((ai.tags ?? []).map(normaliseTag).filter(Boolean))], 'ai');
        } else {
          this.replaceTags(id, patch.tags as string[], 'user');
        }
      }
      return this.getItem(id);
    });
  }

  markFailed(id: number, contentHash: string, message: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE items SET status = 'failed', error = ?, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND content_hash = ? AND status = 'analysing'`,
      )
      .run(message.slice(0, 400), now(), id, contentHash);
    return Number(res.changes) > 0;
  }

  /** Analysed items made with an older prompt/schema than `version`. */
  countOutdated(version: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'analysed' AND analysis_version < ?")
      .get(version) as unknown as { n: number };
    return row.n;
  }

  /**
   * Queue analysed items for a fresh analysis. With no id: every item older than `version`.
   * With an id: that one item, whatever its version. The old result stays until the new one lands,
   * and hand edits are never touched.
   */
  requeue(version: number, id?: number): number {
    const res =
      id === undefined
        ? this.db
            .prepare("UPDATE items SET status = 'pending', error = NULL, updated_at = ? WHERE status = 'analysed' AND analysis_version < ?")
            .run(now(), version)
        : this.db.prepare("UPDATE items SET status = 'pending', error = NULL, updated_at = ? WHERE status = 'analysed' AND id = ?").run(now(), id);
    return Number(res.changes);
  }

  /** failed -> pending so the next run picks it up again. */
  retry(id: number): boolean {
    const res = this.db
      .prepare("UPDATE items SET status = 'pending', error = NULL, updated_at = ? WHERE id = ? AND status = 'failed'")
      .run(now(), id);
    return Number(res.changes) > 0;
  }

  /** Every failed item back to pending (for example after signing in again). */
  retryAllFailed(): number {
    const res = this.db.prepare("UPDATE items SET status = 'pending', error = NULL, updated_at = ? WHERE status = 'failed'").run(now());
    return Number(res.changes);
  }

  /** Tag vocabulary, most used first. */
  tagVocabulary(limit = 300): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.name FROM tags t LEFT JOIN item_tags it ON it.tag_id = t.id
         GROUP BY t.id ORDER BY COUNT(it.item_id) DESC, t.name LIMIT ?`,
      )
      .all(limit) as unknown as { name: string }[];
    return rows.map((r) => r.name);
  }

  tagsFor(itemId: number): string[] {
    const rows = this.db
      .prepare('SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ? ORDER BY t.name')
      .all(itemId) as unknown as { name: string }[];
    return rows.map((r) => r.name);
  }
}
