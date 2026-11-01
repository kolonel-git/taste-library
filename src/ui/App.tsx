import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ItemView, StatusView, SyncSummary } from '../shared/types.ts';
import { api } from './api.ts';
import { Card } from './Card.tsx';
import { FolderForm } from './FolderForm.tsx';

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

  const refresh = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([api.status(), api.items()]);
      setStatus(s);
      setItems(i);
      setLoadError(null);
      if (s.lastSync && s.lastSync.at !== lastSyncAt.current) {
        if (lastSyncAt.current !== null || s.lastSync.added || s.lastSync.changed || s.lastSync.deleted) {
          setToast(summarise(s.lastSync));
        }
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

  // Poll quickly while a scan runs, slowly otherwise.
  useEffect(() => {
    const t = setTimeout(() => void refresh(), status?.syncing ? 600 : 8000);
    return () => clearTimeout(t);
  }, [status, refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
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

  if (!status) {
    return <div class="center muted">{loadError ?? 'Loading…'}</div>;
  }

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
            </>
          )}
        </div>
      </header>

      {missing.map((t) => (
        <div class="banner" role="alert" key={t}>
          <strong>{t === 'claude' ? 'Claude Code' : 'ffmpeg'} not found.</strong> {status.tools[t].message}
        </div>
      ))}
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
        <main class="grid">
          {items.map((item) => (
            <Card key={item.id} item={item} />
          ))}
        </main>
      )}

      {toast && <div class="toast" role="status">{toast}</div>}
    </div>
  );
}
