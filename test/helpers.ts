import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(prefix = 'taste-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function write(root: string, rel: string, content: string | Buffer = rel): string {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Path -> "size:mtime:contents-hash-ish" for every file and folder under root. */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      const st = fs.statSync(abs);
      out[rel] = e.isDirectory() ? `dir:${st.mtimeMs}` : `${st.size}:${st.mtimeMs}:${fs.readFileSync(abs).toString('base64')}`;
      if (e.isDirectory()) walk(abs);
    }
  };
  walk(root);
  return out;
}
