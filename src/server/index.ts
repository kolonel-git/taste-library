import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultDataDir, ensureDataDirs } from './config.ts';
import { openDb, Store } from './db.ts';
import { createApp } from './app.ts';

const PORT = Number(process.env.PORT ?? 4477);
const HOST = '127.0.0.1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const dataDir = defaultDataDir();
ensureDataDirs(dataDir);
const store = new Store(openDb(path.join(dataDir, 'library.db')));
const app = createApp({ store, dataDir, uiDir: path.join(root, 'dist') });

app.server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Is Taste Library already running? Set PORT=<number> to use another.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

app.server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Taste Library running at ${url}`);
  console.log(`Data folder: ${dataDir}`);
  if (!process.argv.includes('--no-open')) openBrowser(url);
  void app.refreshTools();
  if (app.hasSource()) void app.rescan();
});

function openBrowser(url: string) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true });
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}
