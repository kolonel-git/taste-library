import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolCheck } from '../shared/types.ts';

const run = promisify(execFile);

async function check(bin: string, args: string[], missing: string): Promise<ToolCheck> {
  try {
    const { stdout } = await run(bin, args, { timeout: 10_000, windowsHide: true });
    return { ok: true, version: stdout.split('\n')[0].trim() };
  } catch {
    return { ok: false, message: missing };
  }
}

export async function checkTools(): Promise<{ ffmpeg: ToolCheck; claude: ToolCheck }> {
  const [ffmpeg, ffprobe, claude] = await Promise.all([
    check('ffmpeg', ['-version'], 'ffmpeg was not found on your PATH. Install it (https://ffmpeg.org) so thumbnails and video frames can be made.'),
    check('ffprobe', ['-version'], 'ffprobe was not found on your PATH. It ships with ffmpeg.'),
    check('claude', ['--version'], 'The Claude Code CLI was not found on your PATH. Install it so items can be analysed.'),
  ]);
  if (ffmpeg.ok && !ffprobe.ok) return { ffmpeg: ffprobe, claude };
  return { ffmpeg, claude };
}
