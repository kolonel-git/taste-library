import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { ItemDetail, ItemView } from '../shared/types.ts';
import {
  descriptionText,
  everythingText,
  keywordsText,
  paletteText,
  styleGuideText,
  stylePromptText,
} from '../shared/copytext.ts';
import { renderMarkdown } from '../shared/markdown.ts';
import { neighbours } from '../shared/route.ts';
import { api } from './api.ts';
import { copyText } from './clipboard.ts';

interface Props {
  item: ItemView;
  ids: number[];
  onClose: () => void;
  onGo: (id: number) => void;
  onRetry: (id: number) => void;
  onReanalyse: (id: number) => void;
  notify: (message: string) => void;
}

const STATUS_NOTE: Record<string, string> = {
  pending: 'Not analysed yet. Use “Analyse pending” to generate the style guide.',
  analysing: 'Being analysed now. This page fills in when it finishes.',
};

const FOCUSABLE = 'a[href], button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

function CopyIcon({ done }: { done: boolean }) {
  return done ? (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 8.5l3.2 3.2L13 4.5" />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.8" />
      <path d="M10.5 3.2V3.1a1.6 1.6 0 0 0-1.6-1.6H3.6A1.6 1.6 0 0 0 2 3.1v5.3a1.6 1.6 0 0 0 1.6 1.6h.1" />
    </svg>
  );
}

export function Detail({ item, ids, onClose, onGo, onRetry, onReanalyse, notify }: Props) {
  const [loaded, setLoaded] = useState<ItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mediaBroken, setMediaBroken] = useState(false);
  const [justCopied, setJustCopied] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const pos = neighbours(ids, item.id);
  // Never show or copy the previous item's record while the next one is loading.
  const detail = loaded && loaded.id === item.id ? loaded : null;

  // Reload the full record when the item changes or finishes analysing.
  useEffect(() => {
    let live = true;
    setError(null);
    api
      .item(item.id)
      .then((d) => live && setLoaded(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [item.id, item.status, item.title, item.thumbUrl]);

  useEffect(() => setMediaBroken(false), [item.id]);

  // Lock page scroll while open; put focus inside; restore it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    sheet.current?.querySelector<HTMLElement>('.close')?.focus();
    return () => {
      document.body.style.overflow = '';
      const card = document.querySelector<HTMLElement>(`[data-item="${item.id}"] a.cover`);
      (card ?? opener)?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard: Esc, arrows, and a focus trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && ['INPUT', 'TEXTAREA', 'SELECT', 'VIDEO'].includes(t.tagName);
      const plain = !e.altKey && !e.ctrlKey && !e.metaKey;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (!typing && plain && e.key === 'ArrowLeft' && pos.prev !== null) {
        e.preventDefault();
        onGo(pos.prev);
      } else if (!typing && plain && e.key === 'ArrowRight' && pos.next !== null) {
        e.preventDefault();
        onGo(pos.next);
      } else if (e.key === 'Tab' && sheet.current) {
        const nodes = [...sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement;
        if (!sheet.current.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onGo, pos.prev, pos.next]);

  const e = detail?.effective ?? {};
  const analysed = item.status === 'analysed' && detail !== null && Boolean(e.styleGuide);
  const guideHtml = useMemo(() => (e.styleGuide ? renderMarkdown(e.styleGuide) : ''), [e.styleGuide]);

  const copy = async (key: string, text: string, label: string) => {
    const ok = await copyText(text);
    notify(ok ? `Copied ${label}` : 'Could not copy. Select the text and copy it by hand.');
    if (ok) {
      setJustCopied(key);
      setTimeout(() => setJustCopied((k) => (k === key ? null : k)), 1500);
    }
  };

  /** Section heading with a copy icon at its right-hand end. */
  const section = (id: string, title: string, text: string | undefined, children: ComponentChildren) => (
    <section class="sec" aria-labelledby={`h-${id}`} key={id}>
      <div class="sec-head">
        <h3 id={`h-${id}`}>{title}</h3>
        {text && (
          <button class="copy-icon" aria-label={`Copy ${title.toLowerCase()}`} title={`Copy ${title.toLowerCase()}`} onClick={() => copy(id, text, title.toLowerCase())}>
            <CopyIcon done={justCopied === id} />
          </button>
        )}
      </div>
      {children}
    </section>
  );

  /** Tag or keyword: click to copy its text. */
  const chip = (text: string, kind: string) => (
    <li key={text}>
      <button class="chip-btn" title={`Copy “${text}”`} onClick={() => copy(`${kind}-${text}`, text, `“${text}”`)}>
        {justCopied === `${kind}-${text}` ? 'Copied' : text}
      </button>
    </li>
  );

  const name = detail?.effective.title ?? item.title ?? item.relPath.split('/').pop() ?? 'Untitled';

  return (
    <div class="backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={name} ref={sheet}>
        <header class="sheet-bar">
          <span class="muted pos">{pos.index >= 0 ? `${pos.index + 1} of ${pos.total}` : ''}</span>
          <div class="sheet-nav">
            {analysed && detail && (
              <>
                <button
                  class="icon"
                  aria-label="Copy everything"
                  title="Copy everything (all sections as Markdown)"
                  onClick={() => copy('all', everythingText(detail), 'everything')}
                >
                  <CopyIcon done={justCopied === 'all'} />
                </button>
                <button class="btn small" onClick={() => onReanalyse(item.id)} title="Run the analysis again. Your edits are kept.">
                  Re-analyse
                </button>
              </>
            )}
            <button class="icon" aria-label="Previous item" disabled={pos.prev === null} onClick={() => pos.prev !== null && onGo(pos.prev)}>
              ←
            </button>
            <button class="icon" aria-label="Next item" disabled={pos.next === null} onClick={() => pos.next !== null && onGo(pos.next)}>
              →
            </button>
            <button class="icon close" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        <div class="sheet-body">
          <section class="stage" key={item.id}>
            {mediaBroken ? (
              <p class="muted stage-msg">The original file is no longer in the source folder.</p>
            ) : item.kind === 'video' ? (
              <video src={item.mediaUrl} poster={item.thumbUrl} controls playsInline preload="metadata" onError={() => setMediaBroken(true)} />
            ) : (
              <img src={item.mediaUrl} alt={name} onError={() => setMediaBroken(true)} />
            )}
          </section>

          <section class="info">
            <h2 class="sheet-title">{name}</h2>
            <p class="file muted">{item.relPath}</p>
            {item.tags.length > 0 && (
              <ul class="tags clickable" aria-label="Tags">
                {item.tags.map((t) => chip(t, 'tag'))}
              </ul>
            )}

            {error && <p class="form-error" role="alert">{error}</p>}

            {STATUS_NOTE[item.status] && <p class="note">{STATUS_NOTE[item.status]}</p>}
            {item.status === 'failed' && (
              <div class="note bad">
                <p>
                  <strong>Analysis failed.</strong> {item.error}
                </p>
                <button class="btn" onClick={() => onRetry(item.id)}>
                  Retry
                </button>
              </div>
            )}

            {analysed && detail?.outdated && (
              <p class="note">
                This was analysed with an earlier version of the prompt. Re-analyse for the fuller design system and a style prompt.
              </p>
            )}

            {analysed && detail && (
              <>
                {e.description && section('description', 'Description', descriptionText(detail), <p class="desc">{e.description}</p>)}

                {e.palette &&
                  e.palette.length > 0 &&
                  section(
                    'palette',
                    'Palette',
                    paletteText(detail),
                    <ul class="swatches">
                      {e.palette.map((c) => {
                        const hex = c.hex.toUpperCase();
                        const key = `hex-${hex}-${c.role}`;
                        return (
                          <li key={key}>
                            <button class="swatch" aria-label={`Copy ${hex}, ${c.role}`} onClick={() => copy(key, hex, hex)}>
                              <span class="chip-color" style={{ background: hex }} />
                              <span class="hex">{justCopied === key ? 'Copied' : hex}</span>
                              <span class="role">{c.role}</span>
                              {c.name && <span class="cname">{c.name}</span>}
                            </button>
                          </li>
                        );
                      })}
                    </ul>,
                  )}

                {e.keywords &&
                  e.keywords.length > 0 &&
                  section(
                    'keywords',
                    'Keywords',
                    keywordsText(detail),
                    <ul class="tags clickable kw" aria-label="Keywords">
                      {e.keywords.map((k) => chip(k, 'kw'))}
                    </ul>,
                  )}

                {guideHtml && section('guide', 'Style guide', styleGuideText(detail), <div class="guide" dangerouslySetInnerHTML={{ __html: guideHtml }} />)}

                {e.stylePrompt
                  ? section(
                      'prompt',
                      'Style prompt',
                      stylePromptText(detail),
                      <>
                        <p class="muted prompt-hint">Paste this into a new project to have Claude or any other agent build in this style.</p>
                        <pre class="prompt">{e.stylePrompt}</pre>
                      </>,
                    )
                  : section('prompt', 'Style prompt', undefined, <p class="note">No style prompt yet. Re-analyse this item to generate one.</p>)}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
