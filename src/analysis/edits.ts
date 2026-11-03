import { resolveTags } from './tags.ts';

export const EDITABLE_FIELDS = ['title', 'tags', 'description', 'keywords', 'styleGuide'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** A string or list sets the hand-edited value; null reverts the field to the AI version. */
export type Patch = Partial<Record<EditableField, string | string[] | null>>;

export type Checked = { ok: true; patch: Patch } | { ok: false; error: string };

export const LIMITS = {
  title: 120,
  description: 8_000,
  styleGuide: 60_000,
  tags: 12,
  keywords: 40,
  keywordLength: 80,
} as const;

const isEditable = (key: string): key is EditableField => (EDITABLE_FIELDS as readonly string[]).includes(key);

const clean = (s: string) => s.replace(/\r\n?/g, '\n').trim();

/**
 * Check an edit request. Returns the cleaned patch to store, or a message for the user.
 * Tags are normalised onto the existing vocabulary so near-duplicates do not creep in.
 */
export function validateEdit(body: unknown, vocabulary: string[]): Checked {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send an object such as {"title": "New name"}.' };
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, error: 'Nothing to change.' };

  const patch: Patch = {};
  for (const [key, value] of entries) {
    if (!isEditable(key)) return { ok: false, error: `"${key}" cannot be edited.` };
    if (value === null) {
      patch[key] = null;
      continue;
    }

    if (key === 'tags' || key === 'keywords') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return { ok: false, error: `${key} must be a list of text.` };
      if (value.length > 100) return { ok: false, error: `Too many ${key}.` };
      if (key === 'tags') {
        patch.tags = resolveTags(vocabulary, value as string[], LIMITS.tags);
      } else {
        const seen = new Set<string>();
        const list: string[] = [];
        for (const raw of value as string[]) {
          const word = raw.trim().replace(/\s+/g, ' ');
          if (!word || seen.has(word.toLowerCase())) continue;
          if (word.length > LIMITS.keywordLength) return { ok: false, error: `A keyword is longer than ${LIMITS.keywordLength} characters.` };
          seen.add(word.toLowerCase());
          list.push(word);
        }
        if (list.length > LIMITS.keywords) return { ok: false, error: `At most ${LIMITS.keywords} keywords.` };
        patch.keywords = list;
      }
      continue;
    }

    if (typeof value !== 'string') return { ok: false, error: `${key} must be text.` };
    const text = clean(value);
    if (key === 'title') {
      if (!text) return { ok: false, error: 'The title cannot be empty. Use Revert to go back to the AI title.' };
      if (text.length > LIMITS.title) return { ok: false, error: `The title is longer than ${LIMITS.title} characters.` };
    } else if (text.length > LIMITS[key]) {
      return { ok: false, error: `${key} is longer than ${LIMITS[key].toLocaleString('en')} characters.` };
    }
    patch[key] = text;
  }
  return { ok: true, patch };
}
