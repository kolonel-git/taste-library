import { useState } from 'preact/hooks';
import type { ItemView } from '../shared/types.ts';

function stem(relPath: string): string {
  const name = relPath.split('/').pop() ?? relPath;
  return name.replace(/\.[^.]+$/, '');
}

function duration(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending analysis',
  analysing: 'Analysing…',
  failed: 'Analysis failed',
};

export function Card({ item, onRetry }: { item: ItemView; onRetry: (id: number) => void }) {
  const [broken, setBroken] = useState(false);
  const ratio = item.width && item.height ? `${item.width} / ${item.height}` : '4 / 3';
  const label = STATUS_LABEL[item.status];

  return (
    <article class="card">
      <div class="media" style={{ aspectRatio: ratio }}>
        {broken ? (
          <div class="media-fallback">{stem(item.relPath)}</div>
        ) : (
          <img src={item.thumbUrl} alt={item.title ?? stem(item.relPath)} loading="lazy" onError={() => setBroken(true)} />
        )}
        {item.kind === 'video' && (
          <span class="vid">
            <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="currentColor" /></svg>
            {item.durationS ? duration(item.durationS) : 'Video'}
          </span>
        )}
        {label && (
          <span class={`status ${item.status}`} title={item.error ?? undefined}>
            <i /> {label}
          </span>
        )}
        {item.status === 'failed' && (
          <button class="retry" onClick={() => onRetry(item.id)}>
            Retry
          </button>
        )}
      </div>
      <div class="meta">
        <h2 class={item.title ? 'title' : 'title untitled'}>{item.title ?? stem(item.relPath)}</h2>
        {item.tags.length > 0 && (
          <ul class="tags">
            {item.tags.slice(0, 4).map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
