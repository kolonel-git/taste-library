import type { ItemView, StatusView } from '../shared/types.ts';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  status: () => request<StatusView>('/api/status'),
  items: () => request<ItemView[]>('/api/items'),
  rescan: () => request<{ started: boolean }>('/api/rescan', { method: 'POST' }),
  setSourceFolder: (sourceFolder: string) =>
    request<StatusView>('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceFolder }),
    }),
};
