import type { ItemDetail, ItemView, StatusView } from '../shared/types.ts';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  status: () => request<StatusView>('/api/status'),
  items: () => request<ItemView[]>('/api/items'),
  item: (id: number) => request<ItemDetail>(`/api/items/${id}`),
  edit: (id: number, patch: Record<string, string | string[] | null>) =>
    request<ItemDetail>(`/api/items/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  rescan: () => request<{ started: boolean }>('/api/rescan', { method: 'POST' }),
  analyse: () => request<{ started: boolean }>('/api/analyse', { method: 'POST' }),
  reanalyse: (id: number) => request<{ started: boolean }>(`/api/items/${id}/reanalyse`, { method: 'POST' }),
  reanalyseOutdated: () => request<{ started: boolean; queued: number }>('/api/reanalyse-outdated', { method: 'POST' }),
  retryFailed: () => request<{ started: boolean; queued: number }>('/api/retry-failed', { method: 'POST' }),
  retry: (id: number) => request<{ started: boolean }>(`/api/items/${id}/retry`, { method: 'POST' }),
  setSourceFolder: (sourceFolder: string) =>
    request<StatusView>('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceFolder }),
    }),
};
