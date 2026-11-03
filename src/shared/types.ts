export type ItemKind = 'image' | 'video';
export type ItemStatus = 'pending' | 'analysing' | 'analysed' | 'failed';

export type PaletteRole =
  | 'primary'
  | 'secondary'
  | 'accent'
  | 'background'
  | 'surface'
  | 'text'
  | 'muted'
  | 'border'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

export interface PaletteColor {
  hex: string;
  role: PaletteRole;
  name?: string;
}

/** What Claude Code returns for one item; matches src/analysis/schema.json. */
export interface Analysis {
  title: string;
  description: string;
  styleGuide: string;
  palette: PaletteColor[];
  keywords: string[];
  tags: string[];
}

export interface AnalysisProgress {
  running: boolean;
  done: number;
  failed: number;
  remaining: number;
}

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
  /** When the current analysis finished (ISO), if any. */
  analysedAt: string | null;
  thumbUrl: string;
  /** Original file, streamed with range support. */
  mediaUrl: string;
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
  /** Pending images that "Analyse pending" would send now. */
  analysable: number;
  /** Analysed items made with an older prompt; "Re-analyse" would improve them. */
  outdated: number;
  analysis: AnalysisProgress;
}

/** Full record for one item (detail view). */
export interface ItemDetail extends ItemView {
  /** True when the analysis came from an older prompt than the current one. */
  outdated: boolean;
  effective: Partial<Analysis>;
  ai: Partial<Analysis>;
  user: Partial<Analysis>;
}
