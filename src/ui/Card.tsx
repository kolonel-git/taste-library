import { useState } from 'preact/hooks';
import type { ItemView } from '../shared/types.ts';
import { routeFor } from '../shared/route.ts';

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

export function Card({ item, activeTags, onTag, onRetry }: { item: ItemView; activeTags: string[]; onTag: (tag: string) => void; onRetry: (id: number) => void }) {
  const [broken, setBroken] = useState(false);
  const [hover, setHover] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [noPreview, setNoPreview] = useState(false);
  const ratio = item.width && item.height ? `${item.width} / ${item.height}` : '4 / 3';
  const label = STATUS_LABEL[item.status];

  return (
    <article class="card" data-item={item.id}>
      <div
        class="media"
        style={{ aspectRatio: ratio }}
        onMouseEnter={() => item.kind === 'video' && setHover(true)}
        onMouseLeave={() => {
          setHover(false);
          setPlaying(false);
        }}
      >
        {broken ? (
          <div class="media-fallback">{stem(item.relPath)}</div>
        ) : (
          <img src={item.thumbUrl} alt="" loading="lazy" onError={() => setBroken(true)} />
        )}
        <a class="cover" href={routeFor(item.id)} aria-label={`Open ${item.title ?? stem(item.relPath)}`} />
        {hover && !noPreview && (
          <video
            class={playing ? 'preview on' : 'preview'}
            src={item.mediaUrl}
            muted
            loop
            autoPlay
            playsInline
            preload="auto"
            onPlaying={() => setPlaying(true)}
            onError={() => setNoPreview(true)}
          />
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
        <h2 class={item.title ? 'title' : 'title untitled'}>
          <a href={routeFor(item.id)}>{item.title ?? stem(item.relPath)}</a>
        </h2>
        {item.tags.length > 0 && (
          <ul class="tags clickable">
            {item.tags.slice(0, 4).map((t) => (
              <li key={t}>
                <button class={activeTags.includes(t) ? 'chip-btn on' : 'chip-btn'} aria-pressed={activeTags.includes(t)} title={`Filter by ${t}`} onClick={() => onTag(t)}>
                  {t}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
