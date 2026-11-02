/**
 * Terminal entry point, also behind the /analyse-taste slash command.
 * Scans the source folder, then analyses every pending image with Claude Code.
 * Uses the same analyser as the app's "Analyse pending" button.
 *
 *   npm run analyse            scan, then analyse
 *   npm run analyse -- --no-scan
 */
import path from 'node:path';
import { analysePending } from '../analysis/analyse.ts';
import { defaultDataDir, ensureDataDirs, loadConfig } from '../server/config.ts';
import { openDb, Store } from '../server/db.ts';
import { syncLibrary } from '../server/sync.ts';
import { checkTools } from '../server/tools.ts';

const skipScan = process.argv.includes('--no-scan');
const dataDir = defaultDataDir();
ensureDataDirs(dataDir);
const config = loadConfig(dataDir);

if (!config.sourceFolder) {
  console.error('No source folder set. Start the app once (npm start) and choose your folder.');
  process.exit(2);
}

const tools = await checkTools();
if (!tools.claude.ok) {
  console.error(tools.claude.message);
  process.exit(2);
}

const store = new Store(openDb(path.join(dataDir, 'library.db')));

if (!skipScan) {
  try {
    const s = await syncLibrary({ store, sourceFolder: config.sourceFolder, dataDir });
    console.log(`Scanned ${config.sourceFolder}: ${s.added} new, ${s.changed} changed, ${s.deleted} removed, ${s.unchanged} unchanged.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
}

const waiting = store.countAnalysable();
if (waiting === 0) {
  console.log('Nothing pending. All images are analysed.');
  process.exit(0);
}
console.log(`Analysing ${waiting} pending image${waiting === 1 ? '' : 's'} with Claude Code (${config.concurrency} at a time)…`);

const result = await analysePending({
  store,
  sourceFolder: config.sourceFolder,
  dataDir,
  concurrency: config.concurrency,
  model: config.model,
  log: (line) => console.log(`  ${line}`),
});

console.log(`Done: ${result.analysed} analysed, ${result.failed} failed${result.abortedWith ? `, ${result.abortedWith} left pending` : ''}.`);
if (result.failed > 0) console.log('Failed items can be retried from the app, or by running this command again after retrying them there.');
process.exit(result.failed > 0 ? 1 : 0);
