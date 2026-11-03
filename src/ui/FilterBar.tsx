import { useState } from 'preact/hooks';
import { SORT_LABELS, type SortKey, type TagCount } from '../shared/filter.ts';

interface Props {
  counts: TagCount[];
  selected: string[];
  shown: number;
  total: number;
  sort: SortKey;
  onToggle: (tag: string) => void;
  onClear: () => void;
  onSort: (key: SortKey) => void;
}

const COLLAPSED = 14;

export function FilterBar({ counts, selected, shown, total, sort, onToggle, onClear, onSort }: Props) {
  const [all, setAll] = useState(false);

  // Keep chosen tags visible even if they no longer exist anywhere (count 0), so they can be cleared.
  const known = new Set(counts.map((c) => c.name));
  const list: TagCount[] = [...counts, ...selected.filter((t) => !known.has(t)).map((name) => ({ name, count: 0 }))];
  const shownList = all ? list : list.filter((t, i) => i < COLLAPSED || selected.includes(t.name));
  const hidden = list.length - shownList.length;

  return (
    <section class="filters" aria-label="Filter and sort">
      <div class="filters-top">
        <span class="muted tally" role="status">
          {selected.length > 0 ? `${shown} of ${total}` : `${total} ${total === 1 ? 'item' : 'items'}`}
        </span>
        {selected.length > 0 && (
          <button class="link" onClick={onClear}>
            Clear filter
          </button>
        )}
        <label class="sort">
          <span class="muted">Sort</span>
          <select value={sort} onChange={(e) => onSort((e.target as HTMLSelectElement).value as SortKey)}>
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {list.length > 0 && (
        <ul class="tags filter-tags" aria-label="Tags (select to filter)">
          {shownList.map((t) => {
            const on = selected.includes(t.name);
            return (
              <li key={t.name}>
                <button class={on ? 'fchip on' : 'fchip'} aria-pressed={on} onClick={() => onToggle(t.name)}>
                  {t.name} <span class="n">{t.count}</span>
                </button>
              </li>
            );
          })}
          {(hidden > 0 || all) && list.length > COLLAPSED && (
            <li>
              <button class="link" onClick={() => setAll(!all)}>
                {all ? 'Show fewer' : `Show all ${list.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
