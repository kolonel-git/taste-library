import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeThumb, probeMedia } from '../src/server/media.ts';
import { tmpDir } from './helpers.ts';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const opts = { skip: hasFfmpeg ? false : 'ffmpeg not installed' };

function make(dir: string, name: string, args: string[]) {
  const file = path.join(dir, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, file]);
  return file;
}

test('probe + thumbnail for an image', opts, async () => {
  const dir = tmpDir();
  const src = make(dir, 'red.png', ['-f', 'lavfi', '-i', 'color=c=red:s=1000x500', '-frames:v', '1']);
  const p = await probeMedia(src);
  assert.deepEqual([p.width, p.height], [1000, 500]);

  const out = path.join(dir, 'thumb.jpg');
  await makeThumb(src, out, 'image', null);
  const t = await probeMedia(out);
  assert.deepEqual([t.width, t.height], [720, 360]);
});

test('probe + thumbnail for a video', opts, async () => {
  const dir = tmpDir();
  const src = make(dir, 'clip.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=320x240:d=2:r=10', '-pix_fmt', 'yuv420p']);
  const p = await probeMedia(src, 'video');
  assert.deepEqual([p.width, p.height], [320, 240]);
  assert.ok(p.durationS! > 1.5 && p.durationS! < 2.5);

  const out = path.join(dir, 'thumb.jpg');
  await makeThumb(src, out, 'video', p.durationS);
  assert.ok(fs.statSync(out).size > 0);
});

test('probe of a corrupt file degrades to nulls instead of throwing', opts, async () => {
  const dir = tmpDir();
  const bad = path.join(dir, 'bad.png');
  fs.writeFileSync(bad, 'not an image');
  assert.deepEqual(await probeMedia(bad), { width: null, height: null, durationS: null });
});

test('failed thumbnail leaves no partial file behind', opts, async () => {
  const dir = tmpDir();
  const bad = path.join(dir, 'bad.png');
  fs.writeFileSync(bad, 'not an image');
  const out = path.join(dir, 'thumb.jpg');
  await assert.rejects(makeThumb(bad, out, 'image', null));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['bad.png']);
});
