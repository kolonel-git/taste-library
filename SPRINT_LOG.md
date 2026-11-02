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

## Sprint 2 — Analysis engine (images)

**Goal:** pending images become analysed items, from the app and from the terminal.
**Stories:** 4 (re-analyse on change, hand edits kept), 5 (Analyse pending button), 6 (terminal command), 7 (title, description, style guide, palette, keywords, tags).

### Planning

| # | Task | Acceptance criteria |
| --- | --- | --- |
| 1 | Probe headless Claude Code | Confirm how to pass an image, get schema-checked JSON, keep the run cheap and read-only |
| 2 | Shared prompt + schema | One `prompt.md` and one `schema.json` under `src/analysis/`, used by both entry points |
| 3 | Validation + tag vocabulary | Output is checked with ajv before saving. Tags are normalised to kebab-case and mapped onto existing tags (plural, hyphen and case variants collapse) |
| 4 | Analyser + queue | Items are claimed atomically (`pending` to `analysing`), so the app and a terminal run never double up. Configurable parallelism. Stale claims from a crash are released. A result for a file that changed mid-run is dropped, not saved |
| 5 | Failure handling | Bad output gets one automatic retry; anything else fails straight away. Failed items show the reason and a Retry button. A run stops after 3 failures in a row (e.g. not signed in) and leaves the rest pending |
| 6 | Hand edits win | Re-analysis replaces only AI output and AI tag links. `user_json` and user tags are untouched |
| 7 | App: button, live progress, retry | "Analyse pending (N)" with progress. Cards update live over server-sent events. Per-card Retry |
| 8 | Terminal: `npm run analyse` + `/analyse-taste` | Scans first (so new files are found without opening the app), then analyses. Same analyser and output as the button |
| 9 | Tests with a stubbed `claude` | Schema fixtures, tags, merge rule, queue claiming, concurrency, failure and stale-result paths |
| 10 | End-to-end with real samples | All pending sample images analysed by the real CLI; one forced failure and retry |

### Review

**Built**
- `src/analysis/`: `prompt.md`, `schema.json`, prompt builder, ajv validation, tag normalising, merge rule (hand edit over AI), `claude -p` runner and the analyser/queue. Shared by the app and the CLI.
- Claude Code runs headless with only the `Read` tool, the source folder added read-only, no session saved, no slash commands, MCP or user settings loaded, and the prompt sent on stdin. Structured output comes back in `structured_output` and is validated again by us.
- Store: atomic claim, stale-claim release, stale-result guard, tag vocabulary with pruning (migration 2 adds `claimed_at`).
- API: `POST /api/analyse`, `POST /api/items/:id/retry`, `GET /api/items/:id` (full effective / AI / user record, for the Sprint 4 detail view), `GET /api/events` (server-sent events).
- UI: Analyse pending button with live "Analysing 3 of 8", cards fill in with title and tags as they finish, "Analysing…" and "Analysis failed" badges, Retry, failure banner.
- Terminal: `npm run analyse` and `.claude/commands/analyse-taste.md`; `npm run install-command` copies the slash command to `~/.claude/commands` for use from any folder.

**Try it**
```bash
npm start
```
Click **Analyse pending**. Or from a terminal: `npm run analyse`. Or inside Claude Code in this folder: `/analyse-taste`. (`npm run install-command` once, to use it from any folder. It writes one file into your `~/.claude/commands`; I did not run it.)

**Test results**
- `npm test`: 64 of 64 pass (36 new): schema good/bad fixtures, tag folding, hand-edit merge, prompt, CLI output parsing, queue claiming across two runners, concurrency cap, retry and failure paths, stale results, user edits kept on re-analysis, source folder untouched.
- `npm run typecheck`, `npm run build`: clean.
- Real run, terminal: `npm run analyse` scanned 9 files and analysed all 8 images with the real Claude Code CLI, 0 failed, 99 s total at 2 in parallel (about 20 to 30 s each). The video stayed pending, as planned for Sprint 3.
- Real output check: every item got a title, ~3 kB style guide with all nine sections, 7 to 8 palette colours with roles, 12 to 14 keywords and 3 to 5 tags. Tag reuse worked: 12 tags across 8 items (`web-app` on 7, `dashboard` on 6, `dark-mode` on 4) with no near-duplicates.
- Real failure and retry, in the UI: set an invalid model, Analyse failed with the CLI's own message on the card, fixed the setting, clicked Retry, the card went to "Analysing…" then filled in.
- Slash command: its body is the same `npm run analyse` the terminal run used. I did not trigger `/analyse-taste` itself from inside this session.

**Known issues**
- Videos stay "Pending analysis" until Sprint 3. The button count only includes images.
- A run stops after 3 failures in a row; the rest stay pending until you press the button again.
- The terminal command and the app can both scan at the same moment; the second one could hit a database conflict and report an error. Rare, retry fixes it.
- The "N failed" banner only counts failures from the current app session; failed cards stay marked after a restart.
- No UI yet to see the full analysis (Sprint 4); `GET /api/items/:id` returns it.
- Cost and rate limits: each analysis is one Claude Code call on your own plan. I did not measure cost per image; a trimmed probe call was about $0.03, and an untrimmed default call about $0.10, which is why the runner strips tools, settings and hooks.

**Decisions and trade-offs**
- The terminal command scans before analysing. Otherwise, new files would only become pending after opening the app, which defeats story 6.
- One automatic retry only for malformed output. Timeouts and CLI errors fail immediately, to avoid paying twice for the same problem.
- Tags are tidied before validation, so "Dark Mode" is accepted rather than failing the whole item. Everything else must match the schema exactly.
- Parallelism defaults to 2. Raise it in `config.json` if your plan allows.
- Re-analysis keeps the old AI result until the new one lands, so a card never goes blank mid-run.
- Removing an AI tag by hand is a Sprint 5 question (user tag edits are designed to sit alongside AI tags; the schema already tracks `source`).

**Needs your decision before Sprint 3:** none blocking.

## Sprint 3 — Video

**Goal:** videos are first-class items: analysed from keyframes, playable, previewed on hover.
**Stories:** 8 (keyframes analysed together as one item), 9 (video cards preview on hover).

### Planning

| # | Task | Acceptance criteria |
| --- | --- | --- |
| 1 | Keyframe extraction | 6 frames by default, evenly spaced (mid-point of each sixth), via ffmpeg into `frames/<id>-<hash>/`. Optional `scene` mode picks scene changes and falls back to even spacing when the clip has fewer than 3 cuts. Frames are cached and reused on retry |
| 2 | Cache hygiene | Frames are removed when a video changes or is deleted, same as thumbnails |
| 3 | Video through the shared analyser | Same prompt, schema, validation and queue as images. Frames go to one `claude -p` call, with their timestamps, and come back as one item. Style guide gets an extra Motion section. Videos count in "Analyse pending" and in the terminal command |
| 4 | Media endpoint | `GET /media/:id` streams the original with HTTP range support (seeking works), correct content types, read-only |
| 5 | Hover preview | Video cards play a muted looping preview on hover, fall back to the thumbnail if it can't play, and stop on leave |
| 6 | Tests | Timestamps, extraction, cache reuse and cleanup, scene fallback, range parsing, video analysis through a stubbed `claude` |
| 7 | End-to-end | Sample mp4 analysed by the real CLI, previews on hover in the browser |

### Review

**Built**
- `src/analysis/keyframes.ts`: picks keyframe times (evenly spaced by default, or scene changes), extracts them with ffmpeg into `frames/<id>-<hash>/` in the app data folder, reuses a finished set on retry, and cleans up. A missing duration or a broken file fails the item with a clear reason and leaves no half-made folder.
- Videos go through the same prompt, schema, validation, queue and retry as images. The prompt lists every frame with its timestamp, treats them as one piece, and asks for an extra `### Motion` section in the style guide. Claude Code is only given the frames folder, so it never opens the original video.
- "Analyse pending" and `npm run analyse` now include videos.
- `GET /media/:id` streams the original with range support (206 / 416 handled, correct content types), read-only. It also feeds Sprint 4's full-size view.
- Hover preview: video cards play a muted, looping preview over the thumbnail, fade in once playing, stop and unmount on leave, and quietly fall back to the thumbnail if the file can't play.
- Frames are removed when a video changes or is deleted, same as thumbnails.

**Try it**
```bash
npm start
```
Rescan, click **Analyse pending**, then hover the video card.

**Test results**
- `npm test`: 75 of 75 pass (11 new): timestamp maths, extraction and cache reuse, scene detection on a clip with real cuts, fallback to even spacing on a clip with none, failure cleanup, frame cleanup on change and delete, a video analysed through the stubbed `claude` as one call with five timed frames and the original not exposed, range parsing, prompt wording.
- `npm run typecheck`, `npm run build`: clean.
- Real run: `npm run analyse` on all 9 samples (8 images and the 5 s mp4), 9 analysed, 0 failed, 116 s. The video took 32 s. Result: "Peach Isometric Rental Listing", tags `web-app, real-estate, isometric-3d, warm-neutral, motion`. The description tracks what changes across the six frames (the 3D room slowly rotates and scales up while the UI chrome stays fixed), and the Motion section gives duration, easing and a suggested `cubic-bezier`.
- Range requests checked with curl against the real file: full 200, `bytes=0-99` gives 206 with the right `content-range`, a suffix range works, an out-of-range request gives 416, an unknown id gives 404. A 100-byte slice matched the file byte for byte.
- Browser: hovering the video card mounts a muted, looping, playing `<video>` (readyState 4, time advancing); moving away unmounts it.

**Known issues**
- Preview loads the whole file on hover. Fine for short clips on localhost; a very large video would take a moment before it starts, and the thumbnail shows until it does.
- Scene mode needs at least 2 real cuts, otherwise it uses even spacing (the item records which it used in `frames.json`). The default stays even.
- Very long videos get the same 6 frames, so a long edit is described more coarsely. Raise `keyframeCount` in `config.json` (max 12).
- No audio is analysed, only the picture.
- Full-size video playback and the detail view arrive in Sprint 4.

**Decisions and trade-offs**
- Even spacing is the default: it is predictable and fast (6 frames in about 1.3 s), and scene detection costs a full pass over the file.
- Frames are 1280 px wide JPEGs (about 95 kB each), a balance between detail and what Claude Code needs.
- Frames are kept after analysis so Retry doesn't redo ffmpeg work; they are deleted when the video changes or goes away.
- Hover preview uses the original file rather than a generated proxy clip. No extra files to make or clean, at the cost of larger downloads for big videos.

**Needs your decision before Sprint 4:** none blocking.
