import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { evenTimestamps, extractKeyframes, framesDir, pickTimestamps, removeFrames } from '../src/analysis/keyframes.ts';
import { analysePending } from '../src/analysis/analyse.ts';
import { parseRange, mediaType } from '../src/server/range.ts';
import { openDb, Store } from '../src/server/db.ts';
import { ensureDataDirs } from '../src/server/config.ts';
import { syncLibrary } from '../src/server/sync.ts';
import { probeMedia } from '../src/server/media.ts';
import { buildPrompt } from '../src/analysis/prompt.ts';
import { envelope, goodAnalysis, stubExec } from './fixtures.ts';
import { snapshot, tmpDir } from './helpers.ts';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const opts = { skip: hasFfmpeg ? false : 'ffmpeg not installed' };

/** 6s clip: black, white, grey, 2s each, so there are two hard cuts. */
function makeCutClip(file: string) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=2:r=10',
    '-f', 'lavfi', '-i', 'color=c=white:s=320x240:d=2:r=10',
    '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:d=2:r=10',
    '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-pix_fmt', 'yuv420p', file,
  ]);
}

function makeSmoothClip(file: string) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=4:r=10', '-pix_fmt', 'yuv420p', file]);
}

// --- timestamps (pure) ---

test('evenTimestamps takes the middle of each slice', () => {
  assert.deepEqual(evenTimestamps(6, 3), [1, 3, 5]);
  const t = evenTimestamps(5.05, 6);
  assert.equal(t.length, 6);
  assert.ok(t[0] > 0 && t[5] < 5.05);
  assert.deepEqual(t, [...t].sort((a, b) => a - b));
});

// --- extraction ---

test('even extraction writes numbered jpgs, a manifest, and is reused from cache', opts, async () => {
  const src = path.join(tmpDir(), 'smooth.mp4');
  makeSmoothClip(src);
  const framesRoot = tmpDir('frames-');
  const base = { src, framesRoot, id: 7, contentHash: 'abcdef1234567890', durationS: 4, count: 4 };

  const first = await extractKeyframes(base);
  assert.equal(first.files.length, 4);
  assert.equal(first.mode, 'even');
  for (const f of first.files) assert.ok(fs.statSync(f).size > 500, f);
  const stamp = fs.statSync(first.files[0]).mtimeMs;

  const second = await extractKeyframes(base);
  assert.deepEqual(second.files, first.files);
  assert.equal(fs.statSync(second.files[0]).mtimeMs, stamp); // not re-made

  const different = await extractKeyframes({ ...base, count: 3 });
  assert.equal(different.files.length, 3);
});

test('scene mode finds the cuts; a clip without cuts falls back to even spacing', opts, async () => {
  const dir = tmpDir();
  const cuts = path.join(dir, 'cuts.mp4');
  const smooth = path.join(dir, 'smooth.mp4');
  makeCutClip(cuts);
  makeSmoothClip(smooth);

  const a = await pickTimestamps(cuts, 6, 'scene', 6);
  assert.equal(a.mode, 'scene');
  assert.ok(a.times.some((t) => Math.abs(t - 2.1) < 0.3), JSON.stringify(a.times));
  assert.ok(a.times.some((t) => Math.abs(t - 4.1) < 0.3), JSON.stringify(a.times));

  const b = await pickTimestamps(smooth, 4, 'scene', 6);
  assert.equal(b.mode, 'even');
  assert.equal(b.times.length, 6);
});

test('a missing duration is a clear error, and a bad file leaves no half-made folder', opts, async () => {
  const dir = tmpDir();
  const framesRoot = tmpDir('frames-');
  await assert.rejects(extractKeyframes({ src: path.join(dir, 'x.mp4'), framesRoot, id: 1, contentHash: 'h'.repeat(12), durationS: null }), /video length/);

  const bad = path.join(dir, 'bad.mp4');
  fs.writeFileSync(bad, 'junk');
  await assert.rejects(extractKeyframes({ src: bad, framesRoot, id: 1, contentHash: 'h'.repeat(12), durationS: 3 }), /keyframes/);
  assert.deepEqual(fs.readdirSync(framesRoot), []);
});

test('removeFrames clears every hash for an item and leaves other items alone', async () => {
  const root = tmpDir();
  const dataDir = root;
  for (const d of ['5-aaaaaaaaaaaa', '5-bbbbbbbbbbbb', '50-cccccccccccc']) fs.mkdirSync(path.join(root, 'frames', d), { recursive: true });
  await removeFrames(dataDir, 5);
  assert.deepEqual(fs.readdirSync(path.join(root, 'frames')), ['50-cccccccccccc']);
});

// --- video through the analyser ---

test('a video is analysed as one item from its keyframes, never from the original', opts, async () => {
  const source = tmpDir('src-');
  const dataDir = tmpDir('data-');
  ensureDataDirs(dataDir);
  const clip = path.join(source, 'motion.mp4');
  makeSmoothClip(clip);
  const store = new Store(openDb(':memory:'));
  await syncLibrary({ store, sourceFolder: source, dataDir });
  const item = store.getByPath('motion.mp4')!;
  assert.equal(item.kind, 'video');
  assert.ok(item.duration_s! > 3);

  const seen: { prompt: string; addDirs: string[] }[] = [];
  const exec = stubExec(() => envelope(goodAnalysis({ title: 'Test Pattern Reel' })));
  const wrapped = (async (req) => (seen.push({ prompt: req.prompt, addDirs: req.addDirs }), exec(req))) as typeof exec;
  const before = snapshot(source);
  const r = await analysePending({ store, sourceFolder: source, dataDir, exec: wrapped, keyframes: { mode: 'even', count: 5 } });

  assert.equal(r.analysed, 1);
  assert.equal(seen.length, 1); // one call for the whole video
  assert.match(seen[0].prompt, /keyframes from ONE video/);
  assert.match(seen[0].prompt, /frame 5 of 5, at/);
  assert.match(seen[0].prompt, /Motion/);
  assert.equal((seen[0].prompt.match(/\.jpg/g) ?? []).length, 5);
  assert.deepEqual(seen[0].addDirs, [path.join(dataDir, 'frames')]); // original video not exposed
  assert.equal(JSON.parse(store.getByPath('motion.mp4')!.ai_json!).title, 'Test Pattern Reel');
  assert.deepEqual(snapshot(source), before);
  assert.ok(fs.existsSync(framesDir(path.join(dataDir, 'frames'), item.id, item.content_hash)));
});

test('frames are removed when the video changes or is deleted', opts, async () => {
  const source = tmpDir('src-');
  const dataDir = tmpDir('data-');
  ensureDataDirs(dataDir);
  const clip = path.join(source, 'm.mp4');
  makeSmoothClip(clip);
  const store = new Store(openDb(':memory:'));
  const sync = () => syncLibrary({ store, sourceFolder: source, dataDir });
  await sync();
  await analysePending({ store, sourceFolder: source, dataDir, exec: stubExec(() => envelope(goodAnalysis())) });
  const frames = path.join(dataDir, 'frames');
  assert.equal(fs.readdirSync(frames).length, 1);

  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=3:r=10', '-pix_fmt', 'yuv420p', clip]);
  const s = await sync();
  assert.equal(s.changed, 1);
  assert.equal(fs.readdirSync(frames).length, 0);

  await analysePending({ store, sourceFolder: source, dataDir, exec: stubExec(() => envelope(goodAnalysis())) });
  assert.equal(fs.readdirSync(frames).length, 1);
  fs.rmSync(clip);
  await sync();
  assert.equal(fs.readdirSync(frames).length, 0);
});

test('ffprobe reports a duration for videos only', opts, async () => {
  const clip = path.join(tmpDir(), 'm.mp4');
  makeSmoothClip(clip);
  assert.ok((await probeMedia(clip, 'video')).durationS! > 3);
  assert.equal((await probeMedia(clip, 'image')).durationS, null);
});

test('prompt for a video lists each frame with its time', () => {
  const p = buildPrompt({ kind: 'video', files: ['/f/1.jpg', '/f/2.jpg'], tags: [], times: [1.5, 4.5] });
  assert.match(p, /\/f\/1\.jpg \(frame 1 of 2, at 1\.5s\)/);
  assert.match(p, /\/f\/2\.jpg \(frame 2 of 2, at 4\.5s\)/);
});

// --- range requests ---

test('parseRange handles open, closed, suffix, clamped and bad ranges', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=20-10', 100), 'invalid');
  assert.equal(parseRange('bytes=-0', 100), 'invalid');
  assert.equal(parseRange('bytes=-', 100), 'invalid');
  assert.equal(parseRange('items=0-1', 100), 'invalid');
});

test('mediaType covers every supported extension', () => {
  assert.equal(mediaType('.MP4'), 'video/mp4');
  assert.equal(mediaType('.mov'), 'video/quicktime');
  assert.equal(mediaType('.webm'), 'video/webm');
  assert.equal(mediaType('.webp'), 'image/webp');
  assert.equal(mediaType('.xyz'), 'application/octet-stream');
});
