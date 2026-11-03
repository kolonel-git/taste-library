import type { ItemView } from './types.ts';

export type SortKey = 'newest' | 'az' | 'analysed';

export const SORT_LABELS: Record<SortKey, string> = {
  newest: 'Newest first',
  az: 'A to Z',
  analysed: 'Recently analysed',
};

export interface TagCount {
  name: string;
  count: number;
}

/** Every tag in the library with how many items carry it, most used first, then A to Z. */
export function tagCounts(items: ItemView[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const item of items) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Items that carry every selected tag. With nothing selected, everything. */
export function filterByTags(items: ItemView[], selected: string[]): ItemView[] {
  if (selected.length === 0) return items;
  return items.filter((item) => selected.every((tag) => item.tags.includes(tag)));
}

export function toggleTag(selected: string[], tag: string): string[] {
  return selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag];
}

/** `?tags=a,b` -> ['a', 'b'] (ignores blanks and repeats). */
export function parseTagsParam(search: string): string[] {
  const raw = new URLSearchParams(search).get('tags') ?? '';
  return [...new Set(raw.split(',').map((t) => t.trim()).filter(Boolean))];
}

/** Rebuild a query string with the selected tags, keeping any other parameters. */
export function withTagsParam(search: string, selected: string[]): string {
  const params = new URLSearchParams(search);
  if (selected.length) params.set('tags', selected.join(','));
  else params.delete('tags');
  const out = params.toString().replace(/%2C/g, ',');
  return out ? `?${out}` : '';
}

const title = (item: ItemView) => (item.title ?? item.relPath.split('/').pop() ?? '').toLowerCase();

/** `newest` keeps the server's order (newest added first). */
export function sortItems(items: ItemView[], key: SortKey): ItemView[] {
  if (key === 'newest') return items;
  const copy = [...items];
  if (key === 'az') return copy.sort((a, b) => title(a).localeCompare(title(b), undefined, { numeric: true }));
  return copy.sort((a, b) => {
    if (a.analysedAt === b.analysedAt) return title(a).localeCompare(title(b), undefined, { numeric: true });
    if (!a.analysedAt) return 1;
    if (!b.analysedAt) return -1;
    return a.analysedAt < b.analysedAt ? 1 : -1;
  });
}

export function isSortKey(value: unknown): value is SortKey {
  return value === 'newest' || value === 'az' || value === 'analysed';
}
