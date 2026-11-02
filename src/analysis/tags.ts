/** Lowercase kebab-case: "Dark Mode!" -> "dark-mode". */
export function normaliseTag(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Crude singular form so "dashboards" and "dashboard" compare equal. */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && /(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

/** Comparison key: ignores hyphens and plural endings, so "dark-mode", "darkmode" and "dark-modes" match. */
export function tagKey(tag: string): string {
  const parts = normaliseTag(tag).split('-').filter(Boolean);
  if (parts.length === 0) return '';
  parts[parts.length - 1] = singular(parts[parts.length - 1]);
  return parts.join('');
}

/**
 * Map proposed tags onto the existing vocabulary: reuse an existing spelling when the key
 * matches, otherwise keep the normalised new tag. Result is unique and capped.
 */
export function resolveTags(existing: string[], proposed: string[], max = 6): string[] {
  const byKey = new Map<string, string>();
  for (const name of existing) {
    const key = tagKey(name);
    if (key && !byKey.has(key)) byKey.set(key, name);
  }
  const out: string[] = [];
  const used = new Set<string>();
  for (const raw of proposed) {
    const name = normaliseTag(raw);
    const key = tagKey(name);
    if (!name || !key || used.has(key)) continue;
    used.add(key);
    const canonical = byKey.get(key) ?? name;
    byKey.set(key, canonical);
    out.push(canonical);
    if (out.length >= max) break;
  }
  return out;
}
