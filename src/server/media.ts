import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ItemKind } from '../shared/types.ts';

const run = promisify(execFile);

export interface Probe {
  width: number | null;
  height: number | null;
  durationS: number | null;
}

const positive = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

/** Dimensions for any file; duration only for videos (ffprobe reports a fake one for stills). */
export async function probeMedia(file: string, kind: ItemKind = 'image', ffprobe = 'ffprobe'): Promise<Probe> {
  try {
    const { stdout } = await run(
      ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file],
      { timeout: 30_000, windowsHide: true },
    );
    const data = JSON.parse(stdout);
    const s = data.streams?.[0] ?? {};
    const dur = Number.parseFloat(data.format?.duration);
    return {
      width: positive(s.width),
      height: positive(s.height),
      durationS: kind === 'video' ? positive(dur) : null,
    };
  } catch {
    return { width: null, height: null, durationS: null };
  }
}

export function thumbFile(dataDir: string, id: number, contentHash: string): string {
  return path.join(dataDir, 'thumbs', `${id}-${contentHash.slice(0, 12)}.jpg`);
}

/** Remove every cached thumbnail for an item (any hash). */
export async function removeThumbs(dataDir: string, id: number): Promise<void> {
  const dir = path.join(dataDir, 'thumbs');
  const prefix = `${id}-`;
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(names.filter((n) => n.startsWith(prefix)).map((n) => fs.rm(path.join(dir, n), { force: true })));
}

/** Make a single-frame JPEG thumbnail into the data dir. Source is only read. */
export async function makeThumb(
  src: string,
  out: string,
  kind: ItemKind,
  durationS: number | null,
  ffmpeg = 'ffmpeg',
): Promise<void> {
  const seek = kind === 'video' ? Math.min(Math.max((durationS ?? 0) * 0.25, 0), 30) : 0;
  const tmp = `${out}.${process.pid}.tmp.jpg`;
  const args = ['-v', 'error', '-y'];
  if (seek > 0) args.push('-ss', seek.toFixed(2));
  args.push('-i', src, '-frames:v', '1', '-vf', "scale='min(720,iw)':-2", '-q:v', '3', tmp);
  try {
    await run(ffmpeg, args, { timeout: 60_000, windowsHide: true });
    await fs.rename(tmp, out);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
