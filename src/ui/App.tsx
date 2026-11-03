import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ItemView, StatusView, SyncSummary } from '../shared/types.ts';
import { api } from './api.ts';
import { Card } from './Card.tsx';
import { FolderForm } from './FolderForm.tsx';
import { Detail } from './Detail.tsx';
import { FilterBar } from './FilterBar.tsx';
import { parseRoute, routeFor } from '../shared/route.ts';
import { filterByTags, isSortKey, parseTagsParam, sortItems, tagCounts, toggleTag, withTagsParam, type SortKey } from '../shared/filter.ts';

function summarise(s: SyncSummary): string {
  const parts = [
    s.added && `${s.added} new`,
    s.changed && `${s.changed} changed`,
    s.deleted && `${s.deleted} removed`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Up to date';
}

export function App() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [items, setItems] = useState<ItemView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingFolder, setEditingFolder] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const lastSyncAt = useRef<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(() => parseRoute(location.hash));
  const [selected, setSelected] = useState<string[]>(() => parseTagsParam(location.search));
  const [sort, setSort] = useState<SortKey>(() => {
    try {
      const saved = localStorage.getItem('taste-library:sort');
      return isSortKey(saved) ? saved : 'newest';
    } catch {
      return 'newest';
    }
  });

  // The filter lives in the URL (?tags=a,b) so a refresh or a bookmark keeps it.
  const changeTags = useCallback((next: string[]) => {
    setSelected(next);
    history.replaceState(null, '', location.pathname + withTagsParam(location.search, next) + location.hash);
  }, []);
  const changeSort = useCallback((next: SortKey) => {
    setSort(next);
    try {
      localStorage.setItem('taste-library:sort', next);
    } catch {
      /* remembering the sort is a convenience only */
    }
  }, []);

  // The URL hash is the source of truth for which item is open (Back, refresh and links just work).
  useEffect(() => {
    const onHash = () => setOpenId(parseRoute(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const closeDetail = useCallback(() => {
    // Drop the hash without leaving a "closed" entry that Back would reopen.
    history.pushState(null, '', location.pathname + location.search);
    setOpenId(null);
  }, []);
  const goTo = useCallback((id: number) => {
    history.replaceState(null, '', routeFor(id));
    setOpenId(id);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([api.status(), api.items()]);
      setStatus(s);
      setItems(i);
      setLoadError(null);
      if (s.lastSync && s.lastSync.at !== lastSyncAt.current) {
        // Only announce scans that finish while this page is open, not one from before it loaded.
        if (lastSyncAt.current !== null) setToast(summarise(s.lastSync));
        lastSyncAt.current = s.lastSync.at;
      }
      return s;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The server pushes a "change" event whenever a scan or analysis moves.
  useEffect(() => {
    const events = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    events.addEventListener('change', () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 150);
    });
    return () => {
      clearTimeout(timer);
      events.close();
    };
  }, [refresh]);

  // Fallback poll: quick while work is running (also catches a terminal run), slow otherwise.
  const busy = status && (status.syncing || status.analysis.running || status.counts.analysing > 0);
  useEffect(() => {
    const t = setTimeout(() => void refresh(), busy ? 1500 : 8000);
    return () => clearTimeout(t);
  }, [status, busy, refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const rescan = async () => {
    try {
      await api.rescan();
      setStatus((s) => (s ? { ...s, syncing: true } : s));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  const analyse = async () => {
    try {
      await api.analyse();
      setStatus((s) => (s ? { ...s, analysis: { ...s.analysis, running: true } } : s));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  const reanalyse = async (id: number) => {
    try {
      await api.reanalyse(id);
      setToast('Queued for re-analysis');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  const reanalyseOutdated = async () => {
    const n = status?.outdated ?? 0;
    if (!window.confirm(`Re-analyse ${n} ${n === 1 ? 'item' : 'items'} with the current, fuller prompt?

This uses your Claude plan (roughly a minute per item). Hand edits are kept.`)) return;
    try {
      await api.reanalyseOutdated();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  const retryFailed = async () => {
    try {
      await api.retryFailed();
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  const retry = async (id: number) => {
    try {
      await api.retry(id);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!status) {
    return (
      <div class="shell">
        <header class="bar">
          <h1 class="wordmark">
            Taste <em>Library</em>
          </h1>
        </header>
        {loadError ? (
          <div class="banner" role="alert">
            <strong>Cannot reach the library server.</strong> {loadError} Is the app still running?
          </div>
        ) : (
          <main class="grid" aria-busy="true" aria-label="Loading the library">
            {[4 / 3, 1, 3 / 4, 4 / 3, 1, 4 / 3].map((r, i) => (
              <div class="card" key={i}>
                <div class="media skeleton-tile" style={{ aspectRatio: String(r) }} />
              </div>
            ))}
          </main>
        )}
      </div>
    );
  }

  const { analysis } = status;
  const analysing = analysis.running || status.counts.analysing > 0;
  const progress = analysis.done + analysis.failed;
  const total = progress + status.analysable + status.counts.analysing;

  const counts = tagCounts(items);
  const visible = sortItems(filterByTags(items, selected), sort);
  const filtering = selected.length > 0;

  const missing = (['ffmpeg', 'claude'] as const).filter((t) => !status.tools[t].ok);
  const needsFolder = !status.sourceFolder || editingFolder;

  return (
    <div class="shell">
      <header class="bar">
        <h1 class="wordmark">
          Taste <em>Library</em>
        </h1>
        <div class="bar-right">
          {status.syncing ? (
            <span class="state"><i class="pulse" /> Scanning…</span>
          ) : status.sourceFolder ? (
            <span class="state muted">
              {items.length} {items.length === 1 ? 'item' : 'items'}
              {status.counts.pending > 0 && ` · ${status.counts.pending} pending`}
            </span>
          ) : null}
          {status.sourceFolder && (
            <>
              <button class="chip" title="Change source folder" onClick={() => setEditingFolder(true)}>
                {status.sourceFolder}
              </button>
              <button class="btn" disabled={status.syncing} onClick={rescan}>
                Rescan
              </button>
              {status.counts.failed > 0 && !analysing && status.tools.claude.ok && (
                <button class="btn" onClick={retryFailed} title="Try every failed item again">
                  Retry {status.counts.failed} failed
                </button>
              )}
              {status.outdated > 0 && !analysing && status.tools.claude.ok && (
                <button class="btn" onClick={reanalyseOutdated} title="Redo older analyses with the fuller design-system prompt">
                  Update {status.outdated} older
                </button>
              )}
              <button
                class="btn primary"
                disabled={analysing || status.analysable === 0 || !status.tools.claude.ok}
                title={!status.tools.claude.ok ? 'Claude Code CLI not found' : undefined}
                onClick={analyse}
              >
                {analysing ? `Analysing ${Math.min(progress + 1, total)} of ${total}…` : `Analyse pending (${status.analysable})`}
              </button>
            </>
          )}
        </div>
      </header>

      {missing.map((t) => (
        <div class="banner" role="alert" key={t}>
          <strong>{t === 'claude' ? 'Claude Code' : 'ffmpeg'} not found.</strong> {status.tools[t].message}
        </div>
      ))}
      {analysis.running === false && analysis.failed > 0 && (
        <div class="banner" role="alert">
          <strong>{analysis.failed} {analysis.failed === 1 ? 'item' : 'items'} failed to analyse.</strong> Hover the badge on a
          card for the reason, then press Retry.
        </div>
      )}
      {status.syncError && (
        <div class="banner" role="alert">
          <strong>Scan failed.</strong> {status.syncError}
        </div>
      )}
      {loadError && (
        <div class="banner" role="alert">
          <strong>Lost contact with the server.</strong> {loadError}
        </div>
      )}

      {needsFolder ? (
        <FolderForm
          current={status.sourceFolder}
          onCancel={status.sourceFolder ? () => setEditingFolder(false) : undefined}
          onSaved={(s) => {
            setStatus(s);
            setEditingFolder(false);
            void refresh();
          }}
        />
      ) : items.length === 0 ? (
        <div class="center muted">
          {status.syncing ? 'Reading your folder…' : 'No images or videos found in this folder yet.'}
        </div>
      ) : (
        <>
          <FilterBar
            counts={counts}
            selected={selected}
            shown={visible.length}
            total={items.length}
            sort={sort}
            onToggle={(tag) => changeTags(toggleTag(selected, tag))}
            onClear={() => changeTags([])}
            onSort={changeSort}
          />
          {visible.length === 0 ? (
            <div class="center muted empty">
              <p>
                No item has {selected.length === 1 ? 'the tag' : 'all of these tags'}: <strong>{selected.join(', ')}</strong>
              </p>
              <button class="btn" onClick={() => changeTags([])}>
                Clear filter
              </button>
            </div>
          ) : (
            <main class="grid" aria-label={filtering ? 'Filtered library' : 'Library'}>
              {visible.map((item) => (
                <Card key={item.id} item={item} activeTags={selected} onTag={(tag) => changeTags(toggleTag(selected, tag))} onRetry={retry} />
              ))}
            </main>
          )}
        </>
      )}

      {openId !== null && items.length > 0 && (() => {
        const open = items.find((i) => i.id === openId);
        return open ? (
          <Detail
            item={open}
            ids={visible.map((i) => i.id)}
            vocabulary={counts.map((t) => t.name)}
            onClose={closeDetail}
            onGo={goTo}
            onRetry={retry}
            onReanalyse={reanalyse}
            onEdited={() => void refresh()}
            notify={setToast}
          />
        ) : (
          <div class="backdrop" onMouseDown={closeDetail}>
            <div class="sheet missing" role="dialog" aria-label="Item not found">
              <p>That item is no longer in the library.</p>
              <button class="btn primary" onClick={closeDetail}>Back to the library</button>
            </div>
          </div>
        );
      })()}

      {toast && <div class="toast" role="status">{toast}</div>}
    </div>
  );
}
