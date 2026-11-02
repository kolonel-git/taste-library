import fs from 'node:fs/promises';
import path from 'node:path';
import type { ItemRow, Store } from '../server/db.ts';
import { extractKeyframes, type KeyframeMode } from './keyframes.ts';
import { execClaude, OutputError, parseClaudeOutput, type ClaudeExec } from './claude.ts';
import { analysisSchemaText, buildPrompt } from './prompt.ts';
import { resolveTags } from './tags.ts';
import { validateAnalysis } from './validate.ts';

export interface AnalyseDeps {
  store: Store;
  sourceFolder: string;
  /** App data dir; used as the working directory for Claude Code. */
  dataDir: string;
  exec?: ClaudeExec;
  concurrency?: number;
  model?: string | null;
  /** How video keyframes are chosen. Defaults: 6 evenly spaced frames. */
  keyframes?: { mode: KeyframeMode; count: number };
  /** Stop starting new items after this many failures in a row (e.g. not signed in). */
  maxConsecutiveFailures?: number;
  onProgress?: (e: ProgressEvent) => void;
  log?: (line: string) => void;
}

export type ProgressEvent =
  | { type: 'item'; id: number; status: 'analysing' | 'analysed' | 'failed'; error?: string }
  | { type: 'batch'; done: number; failed: number; remaining: number };

export interface BatchResult {
  analysed: number;
  failed: number;
  /** Pending items left because the run stopped early. */
  abortedWith: number;
}

const STALE_CLAIM_MS = 15 * 60_000;

/** Analyse one claimed item. Never throws: failures are recorded on the item. */
export async function analyseClaimed(deps: AnalyseDeps, row: ItemRow): Promise<'analysed' | 'failed' | 'dropped'> {
  const { store } = deps;
  const exec = deps.exec ?? execClaude;
  const abs = path.join(deps.sourceFolder, ...row.rel_path.split('/'));

  const fail = (message: string) => {
    store.markFailed(row.id, row.content_hash, message);
    deps.onProgress?.({ type: 'item', id: row.id, status: 'failed', error: message });
    deps.log?.(`failed ${row.rel_path}: ${message}`);
    return 'failed' as const;
  };

  try {
    await fs.access(abs);
  } catch {
    return fail('The file is no longer in the source folder.');
  }

  // Images go in as they are. Videos go in as keyframes made in the app data dir, so Claude Code
  // only needs to read that folder and never opens the original video.
  let files = [abs];
  let times: number[] | undefined;
  let addDirs = [deps.sourceFolder];
  if (row.kind === 'video') {
    try {
      const kf = await extractKeyframes({
        src: abs,
        framesRoot: path.join(deps.dataDir, 'frames'),
        id: row.id,
        contentHash: row.content_hash,
        durationS: row.duration_s,
        mode: deps.keyframes?.mode,
        count: deps.keyframes?.count,
      });
      files = kf.files;
      times = kf.times;
      addDirs = [path.join(deps.dataDir, 'frames')];
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  const vocabulary = store.tagVocabulary();
  const prompt = buildPrompt({ kind: row.kind, files, tags: vocabulary, times });
  let lastError = 'Analysis failed';

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const stdout = await exec({
        prompt,
        schema: analysisSchemaText,
        addDirs,
        cwd: deps.dataDir,
        model: deps.model,
      });
      const checked = validateAnalysis(parseClaudeOutput(stdout));
      if (!checked.ok) throw new OutputError(checked.error);

      const analysis = checked.value;
      const tags = resolveTags(vocabulary, analysis.tags);
      if (!store.saveAnalysis(row.id, row.content_hash, { ...analysis, tags }, tags)) {
        deps.log?.(`dropped stale result for ${row.rel_path} (file changed or removed meanwhile)`);
        return 'dropped';
      }
      deps.onProgress?.({ type: 'item', id: row.id, status: 'analysed' });
      return 'analysed';
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (!(err instanceof OutputError)) break; // only bad output is worth a second attempt
    }
  }
  return fail(lastError);
}

/**
 * Work through pending items (images and videos) until none are left. Items that become pending while
 * this runs (a retry, a rescan) are picked up too. Safe to run from two processes:
 * each item is claimed atomically.
 */
export async function analysePending(deps: AnalyseDeps): Promise<BatchResult> {
  const { store } = deps;
  const limit = Math.max(1, deps.concurrency ?? 2);
  const maxFails = deps.maxConsecutiveFailures ?? 3;
  store.releaseStaleClaims(STALE_CLAIM_MS);

  let analysed = 0;
  let failed = 0;
  let streak = 0;
  let stopped = false;

  const report = () => deps.onProgress?.({ type: 'batch', done: analysed, failed, remaining: store.countAnalysable() });

  const worker = async () => {
    while (!stopped) {
      const row = store.claimNext();
      if (!row) return;
      deps.onProgress?.({ type: 'item', id: row.id, status: 'analysing' });
      const started = Date.now();
      const result = await analyseClaimed(deps, row);
      if (result === 'analysed') {
        analysed++;
        streak = 0;
        deps.log?.(`analysed ${row.rel_path} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      } else if (result === 'failed') {
        failed++;
        if (++streak >= maxFails) stopped = true;
      }
      report();
    }
  };

  report();
  await Promise.all(Array.from({ length: limit }, worker));
  const abortedWith = stopped ? store.countAnalysable() : 0;
  if (stopped) deps.log?.(`stopped after ${maxFails} failures in a row; ${abortedWith} item(s) left pending`);
  report();
  return { analysed, failed, abortedWith };
}
