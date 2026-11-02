import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export interface Config {
  sourceFolder: string | null;
  /** Parallel `claude -p` runs. Edit config.json to change. */
  concurrency: number;
  /** Optional model alias passed to `claude --model`; null uses Claude Code's default. */
  model: string | null;
}

export function defaultDataDir(): string {
  if (process.env.TASTE_DATA_DIR) return path.resolve(process.env.TASTE_DATA_DIR);
  const home = homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'taste-library');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'taste-library');
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'taste-library');
}

export function ensureDataDirs(dataDir: string): void {
  for (const sub of ['', 'thumbs', 'frames', 'logs']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
}

export function loadConfig(dataDir: string): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    return {
      sourceFolder: typeof raw.sourceFolder === 'string' ? raw.sourceFolder : null,
      concurrency: Number.isInteger(raw.concurrency) && raw.concurrency >= 1 && raw.concurrency <= 6 ? raw.concurrency : 2,
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null,
    };
  } catch {
    return { sourceFolder: null, concurrency: 2, model: null };
  }
}

export function saveConfig(dataDir: string, config: Config): void {
  const file = path.join(dataDir, 'config.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, file);
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Returns the resolved folder, or throws an Error with a user-facing message. */
export function validateSourceFolder(input: string, dataDir: string): string {
  const folder = path.resolve(input.trim().replace(/^"(.*)"$/, '$1'));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(folder);
  } catch {
    throw new Error(`Folder not found: ${folder}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${folder}`);
  if (isInside(folder, dataDir) || isInside(dataDir, folder)) {
    throw new Error('The source folder cannot contain, or sit inside, the app data folder.');
  }
  return folder;
}
