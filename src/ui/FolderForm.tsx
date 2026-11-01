import { useState } from 'preact/hooks';
import type { StatusView } from '../shared/types.ts';
import { api } from './api.ts';

interface Props {
  current: string | null;
  onSaved: (status: StatusView) => void;
  onCancel?: () => void;
}

export function FolderForm({ current, onSaved, onCancel }: Props) {
  const [value, setValue] = useState(current ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.setSourceFolder(value));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="setup" onSubmit={submit}>
      <p class="eyebrow">{current ? 'Source folder' : 'Welcome'}</p>
      <h2>{current ? 'Where should the library look?' : 'Point the library at your inspiration.'}</h2>
      <p class="muted">
        Images and videos in this folder (and its subfolders) become cards. The folder is only ever read; nothing in it is
        moved, renamed or changed.
      </p>
      <label class="field">
        <span>Folder path</span>
        <input
          type="text"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          placeholder="C:\Users\you\Pictures\inspiration"
          spellcheck={false}
          autofocus
        />
      </label>
      {error && <p class="form-error" role="alert">{error}</p>}
      <div class="actions">
        <button class="btn primary" type="submit" disabled={busy || !value.trim()}>
          {busy ? 'Checking…' : current ? 'Save and rescan' : 'Open library'}
        </button>
        {onCancel && (
          <button class="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
