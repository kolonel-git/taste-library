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

/** Copies text and reports whether it worked (the caller flashes its own button). */
type Copier = (text: string, label: string) => Promise<boolean>;

const STATUS_NOTE: Record<string, string> = {
  pending: 'Not analysed yet. Use “Analyse pending” to generate the style guide.',
  analysing: 'Being analysed now. This page fills in when it finishes.',
};

const FOCUSABLE = 'a[href], button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';
const FLASH_MS = 800;
const VIEW_KEY = 'taste-library:style-view';

/** `on` is true for a short moment after `flash()`. */
function useFlash(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    on,
    () => {
      setOn(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setOn(false), FLASH_MS);
    },
  ];
}

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

/** Icon button that turns into a tick for a moment. Same size either way. */
function CopyIconButton({ label, text, copy, className = 'copy-icon' }: { label: string; text: string; copy: Copier; className?: string }) {
  const [on, flash] = useFlash();
  return (
    <button
      class={className}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      onClick={async () => (await copy(text, label)) && flash()}
    >
      <CopyIcon done={on} />
    </button>
  );
}

/** Tag or keyword: click to copy. Shows "Copied" briefly while keeping its original width. */
function ChipButton({ text, copy }: { text: string; copy: Copier }) {
  const [on, flash] = useFlash();
  const ref = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(0);
  return (
    <li>
      <button
        ref={ref}
        class="chip-btn"
        style={on && width ? { width: `${width}px` } : undefined}
        title={`Copy “${text}”`}
        onClick={async () => {
          const w = ref.current?.getBoundingClientRect().width ?? 0;
          if (await copy(text, `“${text}”`)) {
            setWidth(w);
            flash();
          }
        }}
      >
        {on ? (width && width < 62 ? '✓' : 'Copied') : text}
      </button>
    </li>
  );
}

function Swatch({ hex, role, name, copy }: { hex: string; role: string; name?: string; copy: Copier }) {
  const [on, flash] = useFlash();
  return (
    <li>
      <button class="swatch" aria-label={`Copy ${hex}, ${role}`} onClick={async () => (await copy(hex, hex)) && flash()}>
        <span class="chip-color" style={{ background: hex }} />
        <span class="hex">{on ? 'Copied' : hex}</span>
        <span class="role">{role}</span>
        {name && <span class="cname" title={name}>{name}</span>}
      </button>
    </li>
  );
}

function Section({ id, title, text, copyLabel, copy, children }: { id: string; title: string; text?: string; copyLabel?: string; copy: Copier; children: ComponentChildren }) {
  return (
    <section class="sec" aria-labelledby={`h-${id}`}>
      <div class="sec-head">
        <h3 id={`h-${id}`}>{title}</h3>
        {text && <CopyIconButton label={copyLabel ?? title.toLowerCase()} text={text} copy={copy} />}
      </div>
      {children}
    </section>
  );
}

function readView(): boolean {
  try {
    return localStorage.getItem(VIEW_KEY) === 'raw';
  } catch {
    return false;
  }
}

export function Detail({ item, ids, onClose, onGo, onRetry, onReanalyse, notify }: Props) {
  const [loaded, setLoaded] = useState<ItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mediaBroken, setMediaBroken] = useState(false);
  const [doc, setDoc] = useState<'guide' | 'prompt'>('guide');
  const [raw, setRaw] = useState(readView);
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
  // A failed re-analysis keeps the earlier result, so keep showing it under the failure note.
  const analysed = (item.status === 'analysed' || item.status === 'failed') && detail !== null && Boolean(e.styleGuide);
  const guideHtml = useMemo(() => (e.styleGuide ? renderMarkdown(e.styleGuide) : ''), [e.styleGuide]);
  const promptHtml = useMemo(() => (e.stylePrompt ? renderMarkdown(e.stylePrompt) : ''), [e.stylePrompt]);

  const copy: Copier = async (text, label) => {
    const ok = await copyText(text);
    notify(ok ? `Copied ${label}` : 'Could not copy. Select the text and copy it by hand.');
    return ok;
  };

  const setView = (isRaw: boolean) => {
    setRaw(isRaw);
    try {
      localStorage.setItem(VIEW_KEY, isRaw ? 'raw' : 'preview');
    } catch {
      /* remembering the choice is a convenience only */
    }
  };

  const name = detail?.effective.title ?? item.title ?? item.relPath.split('/').pop() ?? 'Untitled';
  const showingGuide = doc === 'guide';
  const docText = detail ? (showingGuide ? styleGuideText(detail) : stylePromptText(detail)) : '';
  const docLabel = showingGuide ? 'style guide' : 'style prompt';

  return (
    <div class="backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={name} ref={sheet}>
        <header class="sheet-bar">
          <span class="muted pos">{pos.index >= 0 ? `${pos.index + 1} of ${pos.total}` : ''}</span>
          <div class="sheet-nav">
            {analysed && detail && (
              <>
                <CopyIconButton label="everything" text={everythingText(detail)} copy={copy} className="icon" />
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
                {item.tags.map((t) => (
                  <ChipButton key={t} text={t} copy={copy} />
                ))}
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

            {item.status === 'analysed' && detail?.outdated && (
              <p class="note">
                This was analysed with an earlier version of the prompt. Re-analyse for the fuller design system and a style prompt.
              </p>
            )}

            {analysed && detail && (
              <>
                {e.description && (
                  <Section id="description" title="Description" text={descriptionText(detail)} copy={copy}>
                    <p class="desc">{e.description}</p>
                  </Section>
                )}

                {e.palette && e.palette.length > 0 && (
                  <Section id="palette" title="Palette" text={paletteText(detail)} copy={copy}>
                    <ul class="swatches">
                      {e.palette.map((c) => (
                        <Swatch key={`${c.hex}-${c.role}`} hex={c.hex.toUpperCase()} role={c.role} name={c.name} copy={copy} />
                      ))}
                    </ul>
                  </Section>
                )}

                {e.keywords && e.keywords.length > 0 && (
                  <Section id="keywords" title="Keywords" text={keywordsText(detail)} copy={copy}>
                    <ul class="tags clickable kw" aria-label="Keywords">
                      {e.keywords.map((k) => (
                        <ChipButton key={k} text={k} copy={copy} />
                      ))}
                    </ul>
                  </Section>
                )}

                <Section id="style" title="Style" text={docText || undefined} copyLabel={docLabel} copy={copy}>
                  <div class="style-bar">
                    <div class="seg" role="group" aria-label="Which document">
                      <button class={showingGuide ? 'on' : ''} aria-pressed={showingGuide} onClick={() => setDoc('guide')}>
                        Style guide
                      </button>
                      <button class={!showingGuide ? 'on' : ''} aria-pressed={!showingGuide} onClick={() => setDoc('prompt')}>
                        Style prompt
                      </button>
                    </div>
                    <div class="seg" role="group" aria-label="How to show it">
                      <button class={!raw ? 'on' : ''} aria-pressed={!raw} onClick={() => setView(false)}>
                        Preview
                      </button>
                      <button class={raw ? 'on' : ''} aria-pressed={raw} onClick={() => setView(true)}>
                        Raw
                      </button>
                    </div>
                  </div>

                  {!showingGuide && <p class="muted prompt-hint">Paste this into a new project to have Claude or any other agent build in this style.</p>}

                  {!docText ? (
                    <p class="note">No style prompt yet. Re-analyse this item to generate one.</p>
                  ) : raw ? (
                    <pre class="raw" tabindex={0} aria-label={`${docLabel}, raw Markdown`}>
                      {docText}
                    </pre>
                  ) : (
                    <div class="guide" dangerouslySetInnerHTML={{ __html: showingGuide ? guideHtml : promptHtml }} />
                  )}
                </Section>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
