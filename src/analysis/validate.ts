import { Ajv } from 'ajv';
import type { Analysis } from '../shared/types.ts';
import { analysisSchema } from './prompt.ts';
import { normaliseTag } from './tags.ts';

const validator = new Ajv({ allErrors: true, strict: true }).compile(analysisSchema);

export type Validated = { ok: true; value: Analysis } | { ok: false; error: string };

/** Check raw model output against the shared schema and tidy it up. */
export function validateAnalysis(input: unknown): Validated {
  // Be forgiving about tag spelling ("Dark Mode" is fine); everything else must match exactly.
  const data =
    input && typeof input === 'object' && Array.isArray((input as { tags?: unknown }).tags)
      ? {
          ...input,
          tags: ((input as { tags: unknown[] }).tags)
            .map((t) => (typeof t === 'string' ? normaliseTag(t) : t))
            .filter((t) => t !== ''),
        }
      : input;
  if (!validator(data)) {
    const msg = (validator.errors ?? [])
      .slice(0, 4)
      .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
      .join('; ');
    return { ok: false, error: `Result did not match the schema: ${msg}` };
  }
  const raw = data as unknown as Analysis;
  const seen = new Set<string>();
  const keywords = raw.keywords
    .map((k) => k.trim())
    .filter((k) => {
      const key = k.toLowerCase();
      if (!k || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    ok: true,
    value: {
      title: raw.title.trim(),
      description: raw.description.trim(),
      styleGuide: raw.styleGuide.trim(),
      stylePrompt: raw.stylePrompt.trim(),
      palette: raw.palette.map((c) => ({ ...c, hex: c.hex.toUpperCase() })),
      keywords,
      tags: raw.tags,
    },
  };
}
