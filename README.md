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
| `npm test` | Automated tests |
| `npm run typecheck` | TypeScript check |

## Where things live

- **Source folder:** read-only. Nothing is ever written, moved or renamed there.
- **App data:** `%APPDATA%\taste-library` (override with `TASTE_DATA_DIR`): `library.db`, `config.json`, `thumbs/`, `frames/`, `logs/`.
- **Samples:** `samples/` is a local copy of test media and is git-ignored.
