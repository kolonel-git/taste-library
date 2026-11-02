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
| `npm run analyse` | Scan, then analyse every pending image with Claude Code (what `/analyse-taste` runs) |
| `npm run install-command` | Install `/analyse-taste` into `~/.claude/commands` so it works from any folder |
| `npm test` | Automated tests |
| `npm run typecheck` | TypeScript check |

## Where things live

- **Source folder:** read-only. Nothing is ever written, moved or renamed there.
- **App data:** `%APPDATA%\taste-library` (override with `TASTE_DATA_DIR`): `library.db`, `config.json`, `thumbs/`, `frames/`, `logs/`.
- **Samples:** `samples/` is a local copy of test media and is git-ignored.

## Analysis

Each pending image is sent to the Claude Code CLI (`claude -p`, with only the read-only `Read` tool; no other AI service or API key). The prompt and JSON schema live in `src/analysis/` (`prompt.md`, `schema.json`) and are shared by the in-app **Analyse pending** button and the terminal command, so both give the same output. Results are checked against the schema before saving. Failed items show **Analysis failed** with the reason on hover and a **Retry** button.

Run it from a terminal with `npm run analyse`, or from Claude Code with `/analyse-taste` (inside this project, or anywhere after `npm run install-command`).

Optional settings in `config.json` (in the app data folder): `concurrency` (1 to 6, default 2) and `model` (a `claude --model` alias; default is Claude Code's own).
