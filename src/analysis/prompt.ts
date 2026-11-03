import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ItemKind } from '../shared/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.join(here, 'prompt.md'), 'utf8');

/**
 * Bump when prompt.md or schema.json change in a way that makes older analyses worth redoing.
 * 1 = original per-image style guide. 2 = generic design system + separate style prompt.
 * 3 = one paste-ready design-system guide (no separate prompt), 150 to 200 word description.
 */
export const ANALYSIS_VERSION = 3;

export const analysisSchemaText = fs.readFileSync(path.join(here, 'schema.json'), 'utf8');
export const analysisSchema = JSON.parse(analysisSchemaText);

export interface PromptInput {
  kind: ItemKind;
  /** Absolute paths: one image, or the keyframes of a video in time order. */
  files: string[];
  /** Current tag vocabulary. */
  tags: string[];
  /** Video only: when each keyframe was taken, in seconds. */
  times?: number[];
}

export function buildPrompt({ kind, files, tags, times }: PromptInput): string {
  const list = files
    .map((f, i) => (kind === 'video' && times?.[i] !== undefined ? `- ${f} (frame ${i + 1} of ${files.length}, at ${times[i]}s)` : `- ${f}`))
    .join('\n');
  const media =
    kind === 'video'
      ? `These ${files.length} images are keyframes from ONE video, in time order. Treat them as a single piece: describe the motion, transitions and what changes across frames, and give one combined analysis. Add a final \`### Motion\` section to the style guide covering pacing, transitions, easing and animation style as far as the frames let you infer them.\n\n${list}`
      : `This is one image:\n\n${list}`;
  const vocab = tags.length ? tags.map((t) => `- ${t}`).join('\n') : '(none yet; you are starting the vocabulary)';
  return template
    .replace('{{SUBJECT}}', kind === 'video' ? 'a short video, shown as keyframes' : 'an image')
    .replace('{{MEDIA_INSTRUCTIONS}}', () => media)
    .replace('{{TAGS}}', () => vocab);
}
