import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { ItemDetail, ItemView } from '../shared/types.ts';
import {
  descriptionText,
  everythingText,
  keywordsText,
  paletteText,
  styleGuideText,
} from '../shared/copytext.ts';
import { renderMarkdown } from '../shared/markdown.ts';
import { neighbours } from '../shared/route.ts';
import { normaliseTag } from '../analysis/tags.ts';
import { api } from './api.ts';
import { copyText } from './clipboard.ts';

interface Props {
  item: ItemView;
  ids: number[];
  /** Every tag in the library, for autocomplete while editing tags. */
  vocabulary: string[];
  onClose: () => void;
  onGo: (id: number) => void;
  onRetry: (id: number) => void;
  onReanalyse: (id: number) => void;
  /** Called after an edit is saved so the grid can refresh. */
  onEdited: () => void;
  notify: (message: string) => void;
}

/** Copies text and reports whether it worked (the caller flashes its own button). */
type Copier = (text: string, label: string) => Promise<boolean>;

type Field = 'title' | 'tags' | 'description' | 'keywords' | 'styleGuide';
type Draft = string | string[];

const STATUS_NOTE: Record<string, string> = {
  pending: 'Not analysed yet. Use “Analyse pending” to generate the style guide.',
  analysing: 'Being analysed now. This page fills in when it finishes.',
};

const FOCUSABLE = 'a[href], button:not([disabled]), input, textarea, select, video[controls], [tabindex]:not([tabindex="-1"])';
const FLASH_MS = 800;
const VIEW_KEY = 'taste-library:style-view';
const FIELD_LABEL: Record<Field, string> = {
  title: 'title',
  tags: 'tags',
  description: 'description',
  keywords: 'keywords',
  styleGuide: 'style guide',
};

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

function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10.8 2.6l2.6 2.6M2.5 13.5l.6-2.9 7.7-7.7 2.3 2.3-7.7 7.7z" />
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

function PencilButton({ field, onEdit }: { field: Field; onEdit: (f: Field) => void }) {
  return (
    <button class="copy-icon" aria-label={`Edit ${FIELD_LABEL[field]}`} title={`Edit ${FIELD_LABEL[field]}`} onClick={() => onEdit(field)}>
      <PencilIcon />
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

function EditedMark({ edited, canRevert, onRevert }: { edited: boolean; canRevert: boolean; onRevert: () => void }) {
  if (!edited) return null;
  return (
    <span class="edited-wrap">
      <span class="edited">Edited</span>
      <button class="link" onClick={onRevert} title="Throw away your edit and show the AI version again">
        {canRevert ? 'Revert to AI' : 'Remove edit'}
      </button>
    </span>
  );
}

function Section({
  id,
  title,
  text,
  copyLabel,
  copy,
  badge,
  extra,
  children,
}: {
  id: string;
  title: string;
  text?: string;
  copyLabel?: string;
  copy: Copier;
  badge?: ComponentChildren;
  extra?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="sec" aria-labelledby={`h-${id}`}>
      <div class="sec-head">
        <div class="sec-title">
          <h3 id={`h-${id}`}>{title}</h3>
          {badge}
        </div>
        <div class="sec-tools">
          {extra}
          {text && <CopyIconButton label={copyLabel ?? title.toLowerCase()} text={text} copy={copy} />}
        </div>
      </div>
      {children}
    </section>
  );
}

function EditorActions({ saving, error, hint, onSave, onCancel }: { saving: boolean; error: string | null; hint: string; onSave: () => void; onCancel: () => void }) {
  return (
    <div class="editor-actions">
      {error && <p class="form-error" role="alert">{error}</p>}
      <div class="row">
        <button class="btn primary small" disabled={saving} onClick={onSave}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button class="btn small" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
        <span class="muted hint">{hint}</span>
      </div>
    </div>
  );
}

/** Single-line or multi-line text. Ctrl+Enter (or Enter, for one line) saves; Esc cancels. */
function TextEditor({
  value,
  onInput,
  onSave,
  onCancel,
  single,
  mono,
  label,
  saving,
  error,
}: {
  value: string;
  onInput: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  single?: boolean;
  mono?: boolean;
  label: string;
  saving: boolean;
  error: string | null;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && (single || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSave();
    }
  };
  return (
    <div class="editor">
      {single ? (
        <input ref={ref} class="edit-input" aria-label={`Edit ${label}`} value={value} maxLength={120} onInput={(e) => onInput((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
      ) : (
        <textarea
          ref={ref}
          class={mono ? 'edit-area mono' : 'edit-area'}
          aria-label={`Edit ${label}`}
          value={value}
          rows={Math.min(Math.max(value.split('\n').length + 1, 6), 22)}
          onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKey}
        />
      )}
      <EditorActions saving={saving} error={error} hint={single ? 'Enter saves, Esc cancels' : 'Ctrl+Enter saves, Esc cancels'} onSave={onSave} onCancel={onCancel} />
    </div>
  );
}

/** Chip editor for tags and keywords: Enter or comma adds, Backspace on an empty box removes the last. */
function ListEditor({
  items,
  onItems,
  pending,
  onPending,
  normalise,
  suggestions,
  label,
  placeholder,
  onSave,
  onCancel,
  saving,
  error,
}: {
  items: string[];
  onItems: (v: string[]) => void;
  pending: string;
  onPending: (v: string) => void;
  normalise: (v: string) => string;
  suggestions?: string[];
  label: string;
  placeholder: string;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const listId = `list-${label}`;

  const add = (raw: string) => {
    const next = [...items];
    for (const part of raw.split(',')) {
      const v = normalise(part);
      if (v && !next.some((x) => x.toLowerCase() === v.toLowerCase())) next.push(v);
    }
    onItems(next);
    onPending('');
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (pending.trim()) add(pending);
      else onSave();
    } else if (e.key === ',') {
      e.preventDefault();
      if (pending.trim()) add(pending);
    } else if (e.key === 'Backspace' && !pending && items.length) {
      onItems(items.slice(0, -1));
    }
  };

  return (
    <div class="editor">
      <div class="chips-edit" onClick={() => ref.current?.focus()}>
        {items.map((t) => (
          <span class="echip" key={t}>
            {t}
            <button aria-label={`Remove ${t}`} onClick={() => onItems(items.filter((x) => x !== t))}>
              ×
            </button>
          </span>
        ))}
        <input
          ref={ref}
          aria-label={`Add ${label}`}
          list={suggestions ? listId : undefined}
          placeholder={items.length ? '' : placeholder}
          value={pending}
          onInput={(e) => onPending((e.target as HTMLInputElement).value)}
          onKeyDown={onKey}
          onBlur={() => pending.trim() && add(pending)}
        />
        {suggestions && (
          <datalist id={listId}>
            {suggestions.filter((s) => !items.includes(s)).map((s) => (
              <option value={s} key={s} />
            ))}
          </datalist>
        )}
      </div>
      <EditorActions saving={saving} error={error} hint="Enter adds, Backspace removes, Enter on an empty box saves" onSave={onSave} onCancel={onCancel} />
    </div>
  );
}

function readView(): boolean {
  try {
    return localStorage.getItem(VIEW_KEY) === 'raw';
  } catch {
    return false;
  }
}

const collapseSpaces = (v: string) => v.trim().replace(/\s+/g, ' ');

export function Detail({ item, ids, vocabulary, onClose, onGo, onRetry, onReanalyse, onEdited, notify }: Props) {
  const [loaded, setLoaded] = useState<ItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mediaBroken, setMediaBroken] = useState(false);
  const [raw, setRaw] = useState(readView);
  const [editing, setEditing] = useState<Field | null>(null);
  const [draft, setDraft] = useState<Draft>('');
  const [pending, setPending] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const original = useRef<Draft>('');
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
  }, [item.id, item.status, item.thumbUrl]);

  useEffect(() => {
    setMediaBroken(false);
    setEditing(null);
    setEditError(null);
  }, [item.id]);

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

  // ---- editing ----

  const isDirty = () => editing !== null && (pending.trim() !== '' || JSON.stringify(draft) !== JSON.stringify(original.current));
  const discardOk = () => !isDirty() || window.confirm('Discard your unsaved changes?');
  const guard = (fn: () => void) => () => {
    if (discardOk()) fn();
  };

  const startEdit = (field: Field) => {
    if (!detail || !discardOk()) return;
    const value: Draft = field === 'tags' ? [...detail.tags] : field === 'keywords' ? [...(detail.effective.keywords ?? [])] : (detail.effective[field] ?? '');
    original.current = value;
    setDraft(value);
    setPending('');
    setEditError(null);
    setEditing(field);
  };

  const cancelEdit = () => {
    if (!discardOk()) return;
    setEditing(null);
    setEditError(null);
  };

  const send = async (patch: Record<string, string | string[] | null>) => {
    setSaving(true);
    setEditError(null);
    try {
      const next = await api.edit(item.id, patch);
      setLoaded(next);
      setEditing(null);
      onEdited();
      return true;
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    let value: string | string[] = draft;
    if (Array.isArray(draft) && pending.trim()) {
      const extra = (editing === 'tags' ? normaliseTag(pending) : collapseSpaces(pending)).trim();
      if (extra && !draft.some((x) => x.toLowerCase() === extra.toLowerCase())) value = [...draft, extra];
    }
    if (await send({ [editing]: value })) notify('Saved');
  };

  const revert = async (field: Field) => {
    if (!window.confirm(`Replace your edited ${FIELD_LABEL[field]} with the AI version?`)) return;
    if (await send({ [field]: null })) notify(`Reverted ${FIELD_LABEL[field]}`);
  };

  // Latest handlers for the one-time keyboard listener below.
  const latest = useRef({ onClose, onGo, pos, editing, cancelEdit, guard });
  latest.current = { onClose, onGo, pos, editing, cancelEdit, guard };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { onClose: close, onGo: go, pos: p, editing: busy, cancelEdit: cancel, guard: guarded } = latest.current;
      const t = e.target as HTMLElement | null;
      const typing = t && ['INPUT', 'TEXTAREA', 'SELECT', 'VIDEO'].includes(t.tagName);
      const plain = !e.altKey && !e.ctrlKey && !e.metaKey;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (busy) cancel();
        else close();
      } else if (!typing && plain && e.key === 'ArrowLeft' && p.prev !== null) {
        e.preventDefault();
        guarded(() => go(p.prev as number))();
      } else if (!typing && plain && e.key === 'ArrowRight' && p.next !== null) {
        e.preventDefault();
        guarded(() => go(p.next as number))();
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
  }, []);

  const e = detail?.effective ?? {};
  const hasAnalysis = Boolean(detail && Object.keys(detail.ai).length > 0);
  // A failed re-analysis keeps the earlier result, so keep showing it under the failure note.
  const analysed = (item.status === 'analysed' || item.status === 'failed') && hasAnalysis;
  const guideHtml = useMemo(() => (e.styleGuide ? renderMarkdown(e.styleGuide) : ''), [e.styleGuide]);

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

  const isEdited = (f: Field) => detail?.user[f] !== undefined;
  const aiHas = (f: Field) => detail?.ai[f] !== undefined;
  const mark = (f: Field) => <EditedMark edited={isEdited(f)} canRevert={aiHas(f)} onRevert={() => revert(f)} />;
  const pencil = (f: Field) => (detail && editing !== f ? <PencilButton field={f} onEdit={startEdit} /> : null);

  const name = detail?.effective.title ?? item.title ?? item.relPath.split('/').pop() ?? 'Untitled';
  const tags = detail?.tags ?? item.tags;
  const guideText = detail ? styleGuideText(detail) : '';

  const textEditor = (field: Field, opts: { single?: boolean; mono?: boolean } = {}) => (
    <TextEditor
      value={draft as string}
      onInput={setDraft}
      onSave={saveEdit}
      onCancel={cancelEdit}
      single={opts.single}
      mono={opts.mono}
      label={FIELD_LABEL[field]}
      saving={saving}
      error={editError}
    />
  );

  return (
    <div class="backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && guard(onClose)()}>
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
            <button class="icon" aria-label="Previous item" disabled={pos.prev === null} onClick={guard(() => pos.prev !== null && onGo(pos.prev))}>
              ←
            </button>
            <button class="icon" aria-label="Next item" disabled={pos.next === null} onClick={guard(() => pos.next !== null && onGo(pos.next))}>
              →
            </button>
            <button class="icon close" aria-label="Close" onClick={guard(onClose)}>
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
            {editing === 'title' ? (
              textEditor('title', { single: true })
            ) : (
              <div class="title-row">
                <h2 class="sheet-title">{name}</h2>
                {pencil('title')}
              </div>
            )}
            <p class="file muted">
              {item.relPath} {mark('title')}
            </p>

            {editing === 'tags' ? (
              <ListEditor
                items={draft as string[]}
                onItems={setDraft}
                pending={pending}
                onPending={setPending}
                normalise={normaliseTag}
                suggestions={vocabulary}
                label="tags"
                placeholder="Add a tag"
                onSave={saveEdit}
                onCancel={cancelEdit}
                saving={saving}
                error={editError}
              />
            ) : (
              <div class="tags-row">
                {tags.length > 0 ? (
                  <ul class="tags clickable" aria-label="Tags">
                    {tags.map((t) => (
                      <ChipButton key={t} text={t} copy={copy} />
                    ))}
                  </ul>
                ) : (
                  <span class="muted small-note">No tags</span>
                )}
                {pencil('tags')}
                {mark('tags')}
              </div>
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
                This was analysed with an earlier version of the prompt. Re-analyse for the latest style guide and a shorter description. Your edits are kept.
              </p>
            )}

            {!detail && item.status !== 'pending' && item.status !== 'analysing' && !error && (
              <div class="skeleton" aria-hidden="true">
                <i style={{ width: '34%' }} />
                <i />
                <i />
                <i style={{ width: '78%' }} />
                <i style={{ width: '56%' }} />
              </div>
            )}

            {analysed && detail && (
              <>
                <Section
                  id="description"
                  title="Description"
                  text={descriptionText(detail) || undefined}
                  copy={copy}
                  badge={mark('description')}
                  extra={pencil('description')}
                >
                  {editing === 'description' ? textEditor('description') : e.description ? <p class="desc">{e.description}</p> : <p class="muted small-note">No description.</p>}
                </Section>

                {e.palette && e.palette.length > 0 && (
                  <Section id="palette" title="Palette" text={paletteText(detail)} copy={copy}>
                    <ul class="swatches">
                      {e.palette.map((c) => (
                        <Swatch key={`${c.hex}-${c.role}`} hex={c.hex.toUpperCase()} role={c.role} name={c.name} copy={copy} />
                      ))}
                    </ul>
                  </Section>
                )}

                <Section
                  id="keywords"
                  title="Keywords"
                  text={keywordsText(detail) || undefined}
                  copy={copy}
                  badge={mark('keywords')}
                  extra={pencil('keywords')}
                >
                  {editing === 'keywords' ? (
                    <ListEditor
                      items={draft as string[]}
                      onItems={setDraft}
                      pending={pending}
                      onPending={setPending}
                      normalise={collapseSpaces}
                      label="keywords"
                      placeholder="Add a keyword"
                      onSave={saveEdit}
                      onCancel={cancelEdit}
                      saving={saving}
                      error={editError}
                    />
                  ) : e.keywords && e.keywords.length > 0 ? (
                    <ul class="tags clickable kw" aria-label="Keywords">
                      {e.keywords.map((k) => (
                        <ChipButton key={k} text={k} copy={copy} />
                      ))}
                    </ul>
                  ) : (
                    <p class="muted small-note">No keywords.</p>
                  )}
                </Section>

                <Section
                  id="style"
                  title="Style guide"
                  text={guideText || undefined}
                  copy={copy}
                  badge={mark('styleGuide')}
                  extra={pencil('styleGuide')}
                >
                  {editing !== 'styleGuide' && guideText && (
                    <div class="style-bar">
                      <div class="seg" role="group" aria-label="How to show it">
                        <button class={!raw ? 'on' : ''} aria-pressed={!raw} onClick={() => setView(false)}>
                          Preview
                        </button>
                        <button class={raw ? 'on' : ''} aria-pressed={raw} onClick={() => setView(true)}>
                          Raw
                        </button>
                      </div>
                    </div>
                  )}

                  {editing === 'styleGuide' ? (
                    textEditor('styleGuide', { mono: true })
                  ) : !guideText ? (
                    <p class="note">The style guide is empty.</p>
                  ) : raw ? (
                    <pre class="raw" tabindex={0} aria-label="Style guide, raw Markdown">
                      {guideText}
                    </pre>
                  ) : (
                    <div class="guide" dangerouslySetInnerHTML={{ __html: guideHtml }} />
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
