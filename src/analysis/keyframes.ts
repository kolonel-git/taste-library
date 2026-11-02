import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mapLimit } from '../server/hash.ts';

const run = promisify(execFile);

export type KeyframeMode = 'even' | 'scene';

export interface KeyframeOptions {
  src: string;
  /** `<data dir>/frames` */
  framesRoot: string;
  id: number;
  contentHash: string;
  durationS: number | null;
  mode?: KeyframeMode;
  count?: number;
  ffmpeg?: string;
}

export interface Keyframes {
  files: string[];
  times: number[];
  mode: KeyframeMode;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Mid-point of each of `count` equal slices, so the first and last frame avoid black fades. */
export function evenTimestamps(durationS: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => round((durationS * (i + 0.5)) / count));
}

/** Evenly thin a list down to `max` entries, keeping the first and last. */
function thin(values: number[], max: number): number[] {
  if (values.length <= max) return values;
  return Array.from({ length: max }, (_, i) => values[Math.round((i * (values.length - 1)) / (max - 1))]);
}

/** Times (seconds) where the picture changes sharply. */
export async function detectScenes(src: string, threshold = 0.3, ffmpeg = 'ffmpeg'): Promise<number[]> {
  const { stderr } = await run(
    ffmpeg,
    ['-v', 'info', '-i', src, '-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'],
    { timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  return [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
}

/** Choose which moments to grab. Scene mode falls back to even spacing for clips without real cuts. */
export async function pickTimestamps(
  src: string,
  durationS: number,
  mode: KeyframeMode,
  count: number,
  ffmpeg = 'ffmpeg',
): Promise<{ times: number[]; mode: KeyframeMode }> {
  if (mode === 'scene') {
    try {
      const cuts = (await detectScenes(src, 0.3, ffmpeg)).filter((t) => t > 0.2 && t < durationS - 0.2);
      if (cuts.length >= 2) {
        const opening = round(Math.min(0.3, durationS / 2));
        const times = thin([opening, ...cuts.map((t) => round(Math.min(t + 0.1, durationS - 0.05)))], count);
        return { times, mode: 'scene' };
      }
    } catch {
      /* fall through to even spacing */
    }
  }
  return { times: evenTimestamps(durationS, count), mode: 'even' };
}

export const framesDir = (framesRoot: string, id: number, contentHash: string) =>
  path.join(framesRoot, `${id}-${contentHash.slice(0, 12)}`);

/**
 * Extract keyframes into `frames/<id>-<hash>/` (inside the app data dir; the source is only read).
 * Re-uses a complete earlier extraction made with the same settings.
 */
export async function extractKeyframes(opts: KeyframeOptions): Promise<Keyframes> {
  const { src, framesRoot, id, contentHash, durationS } = opts;
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const mode = opts.mode ?? 'even';
  const count = Math.min(Math.max(opts.count ?? 6, 2), 12);
  if (!durationS || durationS <= 0) throw new Error('Could not read the video length, so no keyframes could be taken.');

  const dir = framesDir(framesRoot, id, contentHash);
  const manifest = path.join(dir, 'frames.json');
  try {
    const cached = JSON.parse(await fs.readFile(manifest, 'utf8')) as { times: number[]; mode: KeyframeMode; want: KeyframeMode; count: number };
    if (cached.want === mode && cached.count === count) {
      const files = cached.times.map((_, i) => path.join(dir, `${i + 1}.jpg`));
      await Promise.all(files.map((f) => fs.access(f)));
      return { files, times: cached.times, mode: cached.mode };
    }
  } catch {
    /* no usable cache */
  }

  const picked = await pickTimestamps(src, durationS, mode, count, ffmpeg);
  const tmp = `${dir}.${process.pid}.tmp`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
  try {
    await mapLimit(
      picked.times.map((t, i) => ({ t, i })),
      3,
      ({ t, i }) =>
        run(
          ffmpeg,
          ['-v', 'error', '-y', '-ss', t.toFixed(2), '-i', src, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', path.join(tmp, `${i + 1}.jpg`)],
          { timeout: 60_000, windowsHide: true },
        ),
    );
    await Promise.all(picked.times.map((_, i) => fs.access(path.join(tmp, `${i + 1}.jpg`))));
    await fs.writeFile(manifest.replace(dir, tmp), JSON.stringify({ times: picked.times, mode: picked.mode, want: mode, count }));
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(tmp, dir);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw new Error(`Could not extract keyframes: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
  }
  return { files: picked.times.map((_, i) => path.join(dir, `${i + 1}.jpg`)), times: picked.times, mode: picked.mode };
}

/** Remove every cached frame set for an item (any hash). */
export async function removeFrames(dataDir: string, id: number): Promise<void> {
  const root = path.join(dataDir, 'frames');
  let names: string[] = [];
  try {
    names = await fs.readdir(root);
  } catch {
    return;
  }
  await Promise.all(names.filter((n) => n.startsWith(`${id}-`)).map((n) => fs.rm(path.join(root, n), { recursive: true, force: true })));
}
