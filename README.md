# Taste Library

A local, visual library of UI and design inspiration built from a folder of images and videos on your machine. See [ROADMAP.md](ROADMAP.md) for the plan and [SPRINT_LOG.md](SPRINT_LOG.md) for progress.

## Run

Needs Node 24+, `ffmpeg` and `ffprobe` on PATH, and the Claude Code CLI (used from Sprint 2).

```bash
npm install
npm start
```

`npm start` builds the UI, starts the server on `http://localhost:4477` and opens it. On first launch, paste the path of your source folder.

| Command | What it does |
| --- | --- |
| `npm start` | Build UI, run server, open browser |
| `npm run server` | Run server only (no build, no browser) |
| `npm run dev:server` / `npm run dev:ui` | Watch mode: API on 4477, Vite UI with hot reload |
| `npm run analyse` | Scan, then analyse every pending item with Claude Code (what `/analyse-taste` runs). Add `-- --reanalyse` to redo older analyses |
| `npm run install-command` | Install `/analyse-taste` into `~/.claude/commands` so it works from any folder |
| `npm test` | Automated tests |
| `npm run typecheck` | TypeScript check |

## Where things live

- **Source folder:** read-only. Nothing is ever written, moved or renamed there.
- **App data:** `%APPDATA%\taste-library` (override with `TASTE_DATA_DIR`): `library.db`, `config.json`, `thumbs/`, `frames/`, `logs/`.
- **Samples:** `samples/` is a local copy of test media and is git-ignored.

## Analysis

Each pending item is sent to the Claude Code CLI (`claude -p`, with only the read-only `Read` tool; no other AI service or API key). The prompt and JSON schema live in `src/analysis/` (`prompt.md`, `schema.json`) and are shared by the in-app **Analyse pending** button and the terminal command, so both give the same output. Results are checked against the schema before saving. Failed items show **Analysis failed** with the reason on hover and a **Retry** button.

Run it from a terminal with `npm run analyse`, or from Claude Code with `/analyse-taste` (inside this project, or anywhere after `npm run install-command`).

Optional settings in `config.json` (in the app data folder): `concurrency` (1 to 6, default 2), `model` (a `claude --model` alias; default is Claude Code's own), `keyframeMode` (`even` default, or `scene`) and `keyframeCount` (2 to 12, default 6).

Videos are analysed as one item: ffmpeg takes keyframes into the app data folder (`frames/`), and those frames, not the original video, are what Claude Code reads. Video cards play a muted preview on hover.

Click any card to open it: full-size image or playable video, description, palette swatches (click to copy a hex), keywords and the style guide. **Copy everything**, **Copy style guide** and **Copy keywords** put Markdown or plain text on the clipboard. Esc closes, the arrow keys move between items, and the URL (`#/item/12`) can be bookmarked.

### Style prompt and older analyses

Each analysis includes a **style guide** written as a generic design system (principles, colour tokens, type scale, spacing, shape and elevation, a full component set, iconography, imagery, motion, voice, accessibility, do and don't) and a **style prompt**: a self-contained block you can paste into a new project so Claude or any other agent builds in that style. Parts the reference does not show are extrapolated and marked "(inferred)".

If you have analyses made with an earlier prompt, the header shows **Update N older**; the detail sheet has a **Re-analyse** button for a single item. From a terminal: `npm run analyse -- --reanalyse`. Hand edits are kept. A fuller analysis takes roughly a minute per item.
