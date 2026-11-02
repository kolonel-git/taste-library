import type { Analysis } from '../shared/types.ts';

export type Fields = Partial<Analysis>;

export function parseJson(text: string | null): Fields {
  if (!text) return {};
  try {
    return JSON.parse(text) as Fields;
  } catch {
    return {};
  }
}

/**
 * The value shown and copied for each field. A hand-edited field always wins over
 * AI output; a re-analysis only ever replaces the AI side.
 */
export function effectiveFields(aiJson: string | null, userJson: string | null): Fields {
  const ai = parseJson(aiJson);
  const user = parseJson(userJson);
  const out: Fields = { ...ai };
  for (const key of Object.keys(user) as (keyof Analysis)[]) {
    if (user[key] !== undefined) (out as Record<string, unknown>)[key] = user[key];
  }
  return out;
}
