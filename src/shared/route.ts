/** `#/item/12` -> 12, anything else -> null. */
export function parseRoute(hash: string): number | null {
  const m = /^#\/item\/(\d+)$/.exec(hash);
  return m ? Number(m[1]) : null;
}

export const routeFor = (id: number): string => `#/item/${id}`;

export interface Neighbours {
  index: number;
  total: number;
  prev: number | null;
  next: number | null;
}

/** Position of `id` in grid order and the ids either side (null at the ends or if absent). */
export function neighbours(ids: number[], id: number): Neighbours {
  const index = ids.indexOf(id);
  if (index < 0) return { index: -1, total: ids.length, prev: null, next: null };
  return { index, total: ids.length, prev: index > 0 ? ids[index - 1] : null, next: index < ids.length - 1 ? ids[index + 1] : null };
}
