import fs from 'node:fs/promises';
import path from 'node:path';
import type { ItemKind } from '../shared/types.ts';

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm']);

export interface ScannedFile {
  relPath: string;
  absPath: string;
  kind: ItemKind;
  size: number;
  mtimeMs: number;
}

export interface SkippedFile {
  relPath: string;
  reason: string;
}

export interface ScanResult {
  files: ScannedFile[];
  skipped: SkippedFile[];
}

export function kindOf(file: string): ItemKind | null {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

/** Read-only recursive walk. Never writes, moves or deletes anything under root. */
export async function scanFolder(root: string): Promise<ScanResult> {
  const files: ScannedFile[] = [];
  const skipped: SkippedFile[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath, relPath);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ relPath, reason: 'not a regular file' });
        continue;
      }
      const kind = kindOf(entry.name);
      if (!kind) {
        skipped.push({ relPath, reason: `unsupported format "${path.extname(entry.name) || 'no extension'}"` });
        continue;
      }
      const stat = await fs.stat(absPath);
      files.push({ relPath, absPath, kind, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
    }
  }

  await walk(root, '');
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  skipped.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return { files, skipped };
}
