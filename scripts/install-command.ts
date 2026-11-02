/**
 * Installs /analyse-taste into ~/.claude/commands so it works from any folder.
 * The installed copy changes into this project before running the analyser.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(os.homedir(), '.claude', 'commands', 'analyse-taste.md');
const projectPath = root.replace(/\\/g, '/');

const body = `---
description: Scan the Taste Library source folder and analyse pending items
allowed-tools: Bash(npm --prefix ${projectPath} run analyse:*)
---

Analyse the pending items in the Taste Library. Wait for the command to finish (it can take a few minutes):

!\`npm --prefix "${projectPath}" run analyse --silent\`

Report the result in two or three lines: how many items were scanned as new, how many were analysed, and how many failed. If any failed, say the reason shown above and that they can be retried in the app. Do not do anything else.
`;

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, body);
console.log(`Installed ${target}`);
