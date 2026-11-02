import fs from 'node:fs/promises';
import path from 'node:path';
import type { ItemKind, SyncSummary } from '../shared/types.ts';
import { Store, type NewItem } from './db.ts';
import { scanFolder, type ScannedFile } from './scanner.ts';
import { detectChanges } from './changes.ts';
import { hashFile } from './hash.ts';
import { probeMedia, removeThumbs, type Probe } from './media.ts';
import { removeFrames } from '../analysis/keyframes.ts';

export interface SyncOptions {
  store: Store;
  sourceFolder: string;
  dataDir: string;
  probe?: (file: string, kind: ItemKind) => Promise<Probe>;
  hash?: (file: string) => Promise<string>;
  log?: (line: string) => void;
}

/**
 * Bring the library in line with the source folder.
 * Refuses to run if the folder is unreachable, so an unplugged drive can't empty the library.
 */
export async function syncLibrary(opts: SyncOptions): Promise<SyncSummary> {
  const { store, sourceFolder, dataDir } = opts;
  const probe = opts.probe ?? probeMedia;
  const hash = opts.hash ?? hashFile;
  const log = opts.log ?? (() => {});

  let stat;
  try {
    stat = await fs.stat(sourceFolder);
  } catch {
    throw new Error(`Source folder not found: ${sourceFolder}`);
  }
  if (!stat.isDirectory()) throw new Error(`Source path is not a folder: ${sourceFolder}`);

  const { files, skipped } = await scanFolder(sourceFolder);
  for (const s of skipped) log(`skipped ${s.relPath}: ${s.reason}`);

  const changes = await detectChanges(store.allItems(), files, hash);

  const facts = async (f: ScannedFile, contentHash: string): Promise<NewItem> => {
    const p = await probe(f.absPath, f.kind);
    return {
      relPath: f.relPath,
      kind: f.kind,
      size: f.size,
      mtimeMs: f.mtimeMs,
      contentHash,
      width: p.width,
      height: p.height,
      durationS: p.durationS,
    };
  };

  const addedRows = await Promise.all(changes.added.map((f) => facts(f, f.hash)));
  const changedRows = await Promise.all(changes.changed.map(async (f) => ({ id: f.id, row: await facts(f, f.hash) })));

  store.transaction(() => {
    for (const row of addedRows) store.insertItem(row);
    for (const { id, row } of changedRows) store.markChanged(id, row);
    for (const t of changes.touched) store.touch(t.id, t.size, t.mtimeMs);
    for (const d of changes.deleted) store.deleteItem(d.id);
  });

  const stale = [...changes.changed.map((c) => c.id), ...changes.deleted.map((d) => d.id)];
  await Promise.all(stale.flatMap((id) => [removeThumbs(dataDir, id), removeFrames(dataDir, id)]));

  const summary: SyncSummary = {
    added: changes.added.length,
    changed: changes.changed.length,
    deleted: changes.deleted.length,
    unchanged: changes.unchanged + changes.touched.length,
    skipped: skipped.length,
    at: new Date().toISOString(),
  };
  log(`sync ${path.basename(sourceFolder)}: +${summary.added} ~${summary.changed} -${summary.deleted} =${summary.unchanged} skipped ${summary.skipped}`);
  return summary;
}
