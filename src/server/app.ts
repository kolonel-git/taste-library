import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ItemRow, Store } from './db.ts';
import type { AnalysisProgress, ItemDetail, ItemView, StatusView, SyncSummary } from '../shared/types.ts';
import { analysePending, type ProgressEvent } from '../analysis/analyse.ts';
import { effectiveFields, parseJson } from '../analysis/merge.ts';
import { ANALYSIS_VERSION } from '../analysis/prompt.ts';
import { loadConfig, saveConfig, validateSourceFolder } from './config.ts';
import { syncLibrary } from './sync.ts';
import { makeThumb, thumbFile } from './media.ts';
import { mediaType, parseRange } from './range.ts';
import { checkTools } from './tools.ts';
import type { ClaudeExec } from '../analysis/claude.ts';

export interface AppOptions {
  store: Store;
  dataDir: string;
  uiDir: string;
  /** Test seams: replace the real `claude` runner and tool check. */
  exec?: ClaudeExec;
  checkTools?: typeof checkTools;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

class BadRequest extends Error {}

export function createApp(opts: AppOptions) {
  const { store, dataDir, uiDir } = opts;
  let config = loadConfig(dataDir);
  let tools = { ffmpeg: { ok: false }, claude: { ok: false } } as StatusView['tools'];
  let syncing = false;
  let lastSync: SyncSummary | null = null;
  let syncError: string | null = null;
  const thumbJobs = new Map<string, Promise<void>>();
  const logFile = path.join(dataDir, 'logs', 'scan.log');
  const analysisLogFile = path.join(dataDir, 'logs', 'analysis.log');
  let analysis: AnalysisProgress = { running: false, done: 0, failed: 0, remaining: 0 };
  const clients = new Set<http.ServerResponse>();

  const write = (file: string) => (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    fsp.appendFile(file, stamped + '\n').catch(() => {});
  };
  const log = write(logFile);
  const analysisLog = write(analysisLogFile);

  /** Tell open pages something changed; they refetch. */
  function broadcast() {
    for (const res of clients) res.write('event: change\ndata: {}\n\n');
  }

  async function startAnalysis(): Promise<boolean> {
    if (analysis.running || !config.sourceFolder) return false;
    analysis = { running: true, done: 0, failed: 0, remaining: store.countAnalysable() };
    broadcast();
    const onProgress = (e: ProgressEvent) => {
      if (e.type === 'batch') analysis = { ...analysis, done: e.done, failed: e.failed, remaining: e.remaining };
      broadcast();
    };
    try {
      await analysePending({
        store,
        sourceFolder: config.sourceFolder,
        dataDir,
        concurrency: config.concurrency,
        model: config.model,
        exec: opts.exec,
        keyframes: { mode: config.keyframeMode, count: config.keyframeCount },
        onProgress,
        log: analysisLog,
      });
    } catch (err) {
      analysisLog(`ERROR analysis run: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      analysis = { ...analysis, running: false, remaining: store.countAnalysable() };
      broadcast();
    }
    return true;
  }

  async function refreshTools() {
    tools = await (opts.checkTools ?? checkTools)();
    for (const [name, t] of Object.entries(tools)) if (!t.ok) log(`WARNING ${name}: ${t.message}`);
  }

  async function rescan(): Promise<void> {
    if (syncing || !config.sourceFolder) return;
    syncing = true;
    syncError = null;
    try {
      lastSync = await syncLibrary({ store, sourceFolder: config.sourceFolder, dataDir, log });
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
      log(`ERROR sync: ${syncError}`);
    } finally {
      syncing = false;
      broadcast();
    }
  }

  function status(): StatusView {
    return {
      sourceFolder: config.sourceFolder,
      syncing,
      lastSync,
      syncError,
      tools,
      counts: store.countsByStatus(),
      analysable: store.countAnalysable(),
      outdated: store.countOutdated(ANALYSIS_VERSION),
      analysis,
    };
  }

  function view(row: ItemRow): ItemView {
    return {
      id: row.id,
      relPath: row.rel_path,
      kind: row.kind,
      status: row.status,
      title: effectiveFields(row.ai_json, row.user_json).title ?? null,
      tags: store.tagsFor(row.id),
      width: row.width,
      height: row.height,
      durationS: row.duration_s,
      error: row.error,
      thumbUrl: `/thumb/${row.id}?v=${row.content_hash.slice(0, 12)}`,
      mediaUrl: `/media/${row.id}?v=${row.content_hash.slice(0, 12)}`,
    };
  }

  const items = (): ItemView[] => store.allItems().map(view);

  function detail(row: ItemRow): ItemDetail {
    return {
      ...view(row),
      outdated: row.status === 'analysed' && row.analysis_version < ANALYSIS_VERSION,
      effective: effectiveFields(row.ai_json, row.user_json),
      ai: parseJson(row.ai_json),
      user: parseJson(row.user_json),
    };
  }

  async function serveThumb(id: number, res: http.ServerResponse) {
    const row = store.getItem(id);
    if (!row || !config.sourceFolder) return send(res, 404, { error: 'not found' });
    const out = thumbFile(dataDir, row.id, row.content_hash);
    try {
      await fsp.access(out);
    } catch {
      let job = thumbJobs.get(out);
      if (!job) {
        const src = path.join(config.sourceFolder, ...row.rel_path.split('/'));
        job = makeThumb(src, out, row.kind, row.duration_s).finally(() => thumbJobs.delete(out));
        thumbJobs.set(out, job);
      }
      try {
        await job;
      } catch (err) {
        log(`thumbnail failed for ${row.rel_path}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
        return send(res, 404, { error: 'thumbnail failed' });
      }
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' });
    fs.createReadStream(out).pipe(res);
  }

  /** Stream an original (read-only) with range support, so videos can seek and preview. */
  async function serveMedia(id: number, req: http.IncomingMessage, res: http.ServerResponse) {
    const row = store.getItem(id);
    if (!row || !config.sourceFolder) return send(res, 404, { error: 'not found' });
    const file = path.join(config.sourceFolder, ...row.rel_path.split('/'));
    if (path.relative(config.sourceFolder, file).startsWith('..')) return send(res, 403, { error: 'forbidden' });
    let size: number;
    try {
      size = (await fsp.stat(file)).size;
    } catch {
      return send(res, 404, { error: 'file is no longer in the source folder' });
    }
    const range = parseRange(req.headers.range, size);
    const base = { 'content-type': mediaType(path.extname(file)), 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
    if (range === 'invalid') {
      res.writeHead(416, { ...base, 'content-range': `bytes */${size}` });
      return res.end();
    }
    const stream = range
      ? (res.writeHead(206, { ...base, 'content-length': range.end - range.start + 1, 'content-range': `bytes ${range.start}-${range.end}/${size}` }),
        fs.createReadStream(file, { start: range.start, end: range.end }))
      : (res.writeHead(200, { ...base, 'content-length': size }), fs.createReadStream(file));
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  async function serveStatic(urlPath: string, res: http.ServerResponse) {
    const rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
    let file = path.join(uiDir, rel);
    if (path.relative(uiDir, file).startsWith('..')) return send(res, 403, { error: 'forbidden' });
    try {
      if (!(await fsp.stat(file)).isFile()) throw new Error('not a file');
    } catch {
      file = path.join(uiDir, 'index.html');
    }
    try {
      const body = await fsp.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      send(res, 503, { error: 'UI not built yet. Run "npm run build".' });
    }
  }

  function send(res: http.ServerResponse, code: number, body: unknown) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function readJson(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw new Error('body too large');
      chunks.push(c);
    }
    try {
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      throw new BadRequest('Request body is not valid JSON.');
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;
      // The server only ever listens on loopback; also refuse cross-site writes.
      if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        return send(res, 403, { error: 'cross-origin request refused' });
      }

      if (req.method === 'GET' && p === '/api/status') return send(res, 200, status());
      if (req.method === 'GET' && p === '/api/items') return send(res, 200, items());
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      const one = p.match(/^\/api\/items\/(\d+)$/);
      if (req.method === 'GET' && one) {
        const row = store.getItem(Number(one[1]));
        return row ? send(res, 200, detail(row)) : send(res, 404, { error: 'not found' });
      }
      const retry = p.match(/^\/api\/items\/(\d+)\/retry$/);
      if (req.method === 'POST' && retry) {
        if (!store.retry(Number(retry[1]))) return send(res, 409, { error: 'Only failed items can be retried.' });
        broadcast();
        if (tools.claude.ok) void startAnalysis();
        return send(res, 202, { started: tools.claude.ok });
      }
      const again = p.match(/^\/api\/items\/(\d+)\/reanalyse$/);
      if (req.method === 'POST' && again) {
        if (!tools.claude.ok) return send(res, 400, { error: tools.claude.message ?? 'Claude Code CLI not found.' });
        if (store.requeue(ANALYSIS_VERSION, Number(again[1])) === 0) return send(res, 409, { error: 'Only analysed items can be re-analysed.' });
        broadcast();
        void startAnalysis();
        return send(res, 202, { started: true });
      }
      if (req.method === 'POST' && p === '/api/retry-failed') {
        if (!tools.claude.ok) return send(res, 400, { error: tools.claude.message ?? 'Claude Code CLI not found.' });
        const queued = store.retryAllFailed();
        broadcast();
        if (queued > 0) void startAnalysis();
        return send(res, 202, { started: queued > 0, queued });
      }
      if (req.method === 'POST' && p === '/api/reanalyse-outdated') {
        if (!tools.claude.ok) return send(res, 400, { error: tools.claude.message ?? 'Claude Code CLI not found.' });
        const queued = store.requeue(ANALYSIS_VERSION);
        broadcast();
        if (queued > 0) void startAnalysis();
        return send(res, 202, { started: queued > 0, queued });
      }
      if (req.method === 'POST' && p === '/api/analyse') {
        if (!config.sourceFolder) return send(res, 400, { error: 'No source folder set.' });
        if (!tools.claude.ok) return send(res, 400, { error: tools.claude.message ?? 'Claude Code CLI not found.' });
        if (analysis.running) return send(res, 202, { started: false, running: true });
        void startAnalysis();
        return send(res, 202, { started: true });
      }
      if (req.method === 'POST' && p === '/api/rescan') {
        if (!config.sourceFolder) return send(res, 400, { error: 'No source folder set.' });
        if (!syncing) void rescan();
        return send(res, 202, { started: true });
      }
      if (req.method === 'PUT' && p === '/api/settings') {
        const body = await readJson(req);
        if (typeof body.sourceFolder !== 'string') return send(res, 400, { error: 'sourceFolder is required.' });
        if (syncing) return send(res, 409, { error: 'A scan is running. Try again in a moment.' });
        let folder: string;
        try {
          folder = validateSourceFolder(body.sourceFolder, dataDir);
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        config = { ...config, sourceFolder: folder };
        saveConfig(dataDir, config);
        void rescan();
        return send(res, 200, status());
      }
      const thumb = p.match(/^\/thumb\/(\d+)$/);
      if (req.method === 'GET' && thumb) return serveThumb(Number(thumb[1]), res);
      const media = p.match(/^\/media\/(\d+)$/);
      if (req.method === 'GET' && media) return serveMedia(Number(media[1]), req, res);
      if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(p, res);
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, err instanceof BadRequest ? 400 : 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref();
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
  });

  return { server, rescan, refreshTools, log, hasSource: () => Boolean(config.sourceFolder) };
}
