export type ItemKind = 'image' | 'video';
export type ItemStatus = 'pending' | 'analysing' | 'analysed' | 'failed';

/** An item as the UI sees it: effective values (hand edits over AI output). */
export interface ItemView {
  id: number;
  relPath: string;
  kind: ItemKind;
  status: ItemStatus;
  title: string | null;
  tags: string[];
  width: number | null;
  height: number | null;
  durationS: number | null;
  error: string | null;
  thumbUrl: string;
}

export interface SyncSummary {
  added: number;
  changed: number;
  deleted: number;
  unchanged: number;
  skipped: number;
  at: string;
}

export interface ToolCheck {
  ok: boolean;
  version?: string;
  message?: string;
}

export interface StatusView {
  sourceFolder: string | null;
  syncing: boolean;
  lastSync: SyncSummary | null;
  syncError: string | null;
  tools: { ffmpeg: ToolCheck; claude: ToolCheck };
  counts: Record<ItemStatus, number>;
}
