import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ItemRow, Store } from './db.ts';
import type { ItemView, StatusView, SyncSummary } from '../shared/types.ts';
import { loadConfig, saveConfig, validateSourceFolder } from './config.ts';
import { syncLibrary } from './sync.ts';
import { makeThumb, thumbFile } from './media.ts';
import { checkTools } from './tools.ts';

export interface AppOptions {
  store: Store;
  dataDir: string;
  uiDir: string;
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

function effective(row: ItemRow): { title: string | null } {
  const user = row.user_json ? JSON.parse(row.user_json) : {};
  const ai = row.ai_json ? JSON.parse(row.ai_json) : {};
  return { title: user.title ?? ai.title ?? null };
}

export function createApp(opts: AppOptions) {
  const { store, dataDir, uiDir } = opts;
  let config = loadConfig(dataDir);
  let tools = { ffmpeg: { ok: false }, claude: { ok: false } } as StatusView['tools'];
  let syncing = false;
  let lastSync: SyncSummary | null = null;
  let syncError: string | null = null;
  const thumbJobs = new Map<string, Promise<void>>();
  const logFile = path.join(dataDir, 'logs', 'scan.log');

  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    fsp.appendFile(logFile, stamped + '\n').catch(() => {});
  };

  async function refreshTools() {
    tools = await checkTools();
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
    };
  }

  function items(): ItemView[] {
    return store.allItems().map((row) => ({
      id: row.id,
      relPath: row.rel_path,
      kind: row.kind,
      status: row.status,
      title: effective(row).title,
      tags: store.tagsFor(row.id),
      width: row.width,
      height: row.height,
      durationS: row.duration_s,
      error: row.error,
      thumbUrl: `/thumb/${row.id}?v=${row.content_hash.slice(0, 12)}`,
    }));
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
      if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(p, res);
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, err instanceof BadRequest ? 400 : 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return { server, rescan, refreshTools, log, hasSource: () => Boolean(config.sourceFolder) };
}
