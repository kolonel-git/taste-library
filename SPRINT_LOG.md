# Sprint Log

## Sprint 1 — Library foundation

**Goal:** the folder becomes a visible library, before any AI.
**Stories:** 1 (scan on launch), 2 (pending cards), 3 (deleted/renamed files), 4 (changed files go back to pending, hand edits kept).

### Planning

| # | Task | Acceptance criteria |
| --- | --- | --- |
| 1 | Scaffold: TypeScript, Vite + Preact, `node:test`, scripts | `npm test`, `npm run typecheck`, `npm start` all run |
| 2 | Config + app data dir | Data dir is `%APPDATA%\taste-library` (override via `TASTE_DATA_DIR`). Source folder is stored in `config.json`, never hard-coded. Folder inside the data dir (or the reverse) is rejected |
| 3 | Startup tool check | Missing `ffmpeg` or `claude` shows a clear banner in the UI and a message in the terminal. App still opens |
| 4 | SQLite store | Schema from the roadmap, WAL mode, versioned migration. CRUD covered by tests |
| 5 | Scanner | Recursive walk; png/jpg/jpeg/webp/gif and mp4/mov/webm accepted; everything else skipped and logged; relative `/` paths; deterministic order |
| 6 | Change detection | New, changed, touched (mtime only), deleted and unchanged are told apart. Unchanged files are not re-hashed. Rename = delete + new. Hand edits (`user_json`) survive a change |
| 7 | Sync | One pass applies the diff in a transaction. A missing or unreadable source folder never wipes the library. Source folder is never written to (tested) |
| 8 | Probe + thumbnails | ffprobe gives width, height, duration. Thumbnails are made lazily by ffmpeg into the data dir, named by content hash so they refresh when a file changes |
| 9 | HTTP server + API | `/api/status`, `/api/items`, `/api/rescan`, `/api/settings`, `/thumb/:id`, static UI. Binds to `127.0.0.1` only |
| 10 | UI: setup, grid, rescan | First run asks for the source folder. Grid of cards keeps each item's aspect ratio. New files show "Pending analysis". Rescan button shows progress and a result summary |
| 11 | Tests + manual run | Automated tests pass. Manual: copy sample in, add / edit / delete / rename a file, rescan, see each change |

### Review

**Built**
- Scaffold: TypeScript (Node runs it directly, no server build step), Vite + Preact UI, `node:test`.
- Config and app data dir. Source folder is set in the UI, saved to `config.json`, and rejected if it contains or sits inside the data dir.
- SQLite store (built-in `node:sqlite`, WAL) with the roadmap schema, including the tag tables used from Sprint 2.
- Scanner, change detection and sync: new / changed / touched / deleted / unchanged. Unchanged files are not re-hashed. A rename is a delete plus a new item.
- ffprobe for dimensions and duration. Thumbnails are made lazily on first view and named by content hash, so they refresh when a file changes and are removed when it is deleted.
- Local HTTP server (loopback only) with `/api/status`, `/api/items`, `/api/rescan`, `/api/settings`, `/thumb/:id` and the built UI.
- UI: first-run folder form, masonry-style grid that keeps each item's aspect ratio, "Pending analysis" badges, video badge with duration, Rescan with a result toast, banners for missing `ffmpeg` / `claude` and scan errors. Dark by default, light follows the system.

**Try it**
```bash
npm install
npm start
```
Paste your source folder when asked. `samples/` holds a copy of your UI-UX Inspo set (8 webp, 1 mp4) if you want to point at that first.

**Test results**
- `npm test`: 28 of 28 pass (scanner, change detection, store, sync, config validation, ffprobe / thumbnails against generated real media).
- `npm run typecheck` and `npm run build`: clean.
- Manual, with the 9 sample files: all 9 appeared as pending cards with correct aspect ratios and the video showed `0:05`. Then, on a scratch copy: added a file, added a `.txt`, deleted a file, renamed a file and edited a file's bytes. One rescan reported `+2 new, 1 changed, 2 removed, 6 unchanged, 1 skipped` and the grid matched. The `.txt` was logged to `logs/scan.log`. A bad folder path and a malformed request body return clear errors. Checked at desktop and phone width.
- The "source folder is never written to" rule has its own test (before/after snapshot of files, sizes and times).

**Known issues**
- Hand-edit preservation on a changed file is covered by storage and sync tests, but there is no UI to edit yet (Sprint 5).
- The server answers a malformed JSON body with 400 only after a restart of any server started before that fix; nothing to do on a fresh `npm start`.
- No live folder watching: changes show up on launch or when you press Rescan.
- Hovering a video card does not preview yet (Sprint 3).

**Decisions and trade-offs**
- Plain text input for the folder path. Browsers cannot hand a server a real folder path, and a native picker would need an OS-specific shim.
- Scan runs in the background and the UI polls, so the page loads instantly even on a big first hash.
- `ffprobe` reports a fake duration for still images, so duration is stored for videos only. It also reports 0x0 for corrupt files, which would break the aspect ratio, so non-positive sizes are stored as unknown.
- Newest-added first in the grid. Within one scan that is reverse path order, which looks arbitrary. Say if you want a sort option or A-Z.
- Thumbnails are 720 px wide JPEGs.

**Needs your decision before Sprint 2:** none blocking.
