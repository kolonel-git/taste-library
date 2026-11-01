import type { ScannedFile } from './scanner.ts';
import { mapLimit } from './hash.ts';

export interface KnownFile {
  id: number;
  rel_path: string;
  size: number;
  mtime_ms: number;
  content_hash: string;
}

export interface HashedFile extends ScannedFile {
  hash: string;
}

export interface ChangeSet {
  added: HashedFile[];
  /** Contents differ from what was last seen. */
  changed: (HashedFile & { id: number })[];
  /** Size/mtime moved but bytes are identical. */
  touched: (ScannedFile & { id: number })[];
  deleted: KnownFile[];
  unchanged: number;
}

/**
 * Compare a fresh scan with what the library knows.
 * Files with identical size + mtime are trusted and not re-hashed.
 * A rename shows up as one deletion plus one addition, by design.
 */
export async function detectChanges(
  known: KnownFile[],
  scanned: ScannedFile[],
  hash: (absPath: string) => Promise<string>,
  concurrency = 4,
): Promise<ChangeSet> {
  const byPath = new Map(known.map((k) => [k.rel_path, k]));
  const seen = new Set<string>();
  const toHashNew: ScannedFile[] = [];
  const toHashMaybe: (ScannedFile & { id: number; oldHash: string })[] = [];
  let unchanged = 0;

  for (const file of scanned) {
    seen.add(file.relPath);
    const prev = byPath.get(file.relPath);
    if (!prev) {
      toHashNew.push(file);
    } else if (prev.size === file.size && prev.mtime_ms === file.mtimeMs) {
      unchanged++;
    } else {
      toHashMaybe.push({ ...file, id: prev.id, oldHash: prev.content_hash });
    }
  }

  const added = await mapLimit(toHashNew, concurrency, async (f) => ({ ...f, hash: await hash(f.absPath) }));
  const rehashed = await mapLimit(toHashMaybe, concurrency, async (f) => ({ ...f, hash: await hash(f.absPath) }));

  const changed: ChangeSet['changed'] = [];
  const touched: ChangeSet['touched'] = [];
  for (const f of rehashed) {
    if (f.hash === f.oldHash) touched.push(f);
    else changed.push(f);
  }

  const deleted = known.filter((k) => !seen.has(k.rel_path));
  return { added, changed, touched, deleted, unchanged };
}
