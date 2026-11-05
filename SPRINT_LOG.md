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

## Sprint 4 — Detail view & reuse

**Goal:** open any card and get a page you can lift styles from. Everything copies in one click.
**Stories:** 10 (expanded detail view), 13 (copy style guide / keywords / everything), 14 (swatches copy hex).

### Planning

| # | Task | Acceptance criteria |
| --- | --- | --- |
| 1 | Detail sheet and routing | Click opens a full-height sheet over the grid. Esc, backdrop and close button close it. Left/right arrows step through items in grid order. URL hash (`#/item/12`) restores it on refresh and works with Back. Focus is trapped while open and returned to the card on close |
| 2 | Media panel | Images full size. Videos play with controls and can seek. A missing file shows a clear message |
| 3 | Style guide rendering | Headings, lists, bold and inline code render. Raw text is HTML-escaped (it is AI output) |
| 4 | Swatches | Show hex, role and name. Click or keyboard copies the hex, with visible confirmation |
| 5 | Copy actions | Copy style guide, Copy keywords, Copy everything put the right text on the clipboard. Fallback if the clipboard API is refused |
| 6 | Unanalysed items | Pending, analysing and failed items open too, with status, media and Retry, no guide |
| 7 | Responsive and themes | Desktop two-column, phone stacked, dark and light |
| 8 | Tests | Copy text, markdown rendering and escaping, route parsing, prev/next at the ends, detail and media routes over HTTP |
| 9 | Manual check | Real analysed samples in the browser: image and video, each copy button read back from the clipboard, swatch copy, keyboard, light theme, phone width |

### Review

**Built**
- Detail sheet: click any card (or its title) to open a full-height sheet over the grid. Media on the left, content on the right, stacked on a phone. Esc, the backdrop and the close button close it; the left and right arrows (and on-screen buttons) step through items in grid order and stop at the ends. Page scroll is locked while open, focus is kept inside, and focus returns to the card on close.
- URL routing: `#/item/12` opens the sheet, survives a refresh, and works with Back and shared links. Cards are real links, so middle-click and keyboard activation work. An id that no longer exists shows a short message instead of a blank page.
- Media: images at full size, videos with controls (poster is the thumbnail), seeking works through the range endpoint. A missing original shows a clear message.
- Content: title, file path, tags, description, palette swatches (hex, role, name), keywords, and the style guide rendered as formatted text.
- Copy: **Copy everything** (Markdown: title, tags, description, palette list, keywords, style guide), **Copy style guide** (the raw Markdown only), **Copy keywords** (comma list). Clicking a swatch copies its uppercase hex. Each gives a toast and the button or swatch briefly reads "Copied". If the browser refuses the clipboard API, a hidden-textarea fallback is used.
- Unanalysed items open too: pending and analysing items show a note, failed items show the error and a Retry button.
- Safe rendering: a small in-house Markdown renderer (`src/shared/markdown.ts`) escapes everything first, since the text comes from a model.
- The sheet only ever shows or copies the record that matches the open item, never the previous one while the next loads.

**Try it**
```bash
npm start
```
Click any analysed card, press **Copy everything**, and paste into another tool. Use ← / → to flip through, Esc to close.

**Test results**
- `npm test`: 87 of 87 pass (12 new): Markdown rendering and escaping (script and image injection, quotes, wrapped list items, Windows line endings), the three copy formats including hand-edited values and missing parts, route parsing, prev/next at both ends and for an unknown id, and over real HTTP: `GET /api/items/:id` (effective vs AI vs user values, 404) and `GET /media/:id` (full, 206 range, 416, 404 for an unknown id and for a file deleted from disk).
- `npm run typecheck`, `npm run build`: clean.
- Browser, on a copy of your real library (all 9 analysed): opened an image item and the video item at desktop width, and an image at phone width in the light theme. The style guide renders as headed sections with bullets. All four copy payloads were captured at the clipboard call and checked: Copy everything has all five parts in order, Copy style guide starts at `### Colour` and has no title or palette, Copy keywords is the comma list, a swatch copies `#F5A623`. ← and → moved 8 of 9 to 9 of 9 and the next button disabled at the end. The video played and seeked to 3 s. A page refresh on `#/item/5` restored the sheet. Esc closed it, unlocked scrolling and put focus back on that card's link.

**Known issues**
- The preview pane inside the desktop app denies clipboard permission, so there the async clipboard API threw and the textarea fallback ran, reporting success. I could not read the real clipboard back from that pane. The copied text is verified, and the fallback path is exercised, but I did not paste into another app or test in a normal browser window. Worth a quick paste on your side.
- Closing the sheet adds a history entry (Back from the closed state reopens the item). Deliberate, to avoid trapping Back.
- Only the inline hex codes inside the style guide text are plain text; they do not have swatches or click-to-copy.
- Editing is Sprint 5, so the sheet is read-only for now.

**Decisions and trade-offs**
- Sheet over the grid, rather than a separate page, so scroll position and (Sprint 5) filters are kept.
- Small in-house Markdown renderer rather than a library: the guide uses a fixed set of formatting, so no new dependency.
- "Copy everything" is Markdown with the palette as a list (`- #0E0E10: background (Ink)`), so it pastes cleanly into a brief or another model.
- Hex codes copy uppercase, as stored.
- `.impeccable/config.json` is a new file in the repo. The design checker flagged an intentional `<img src=x onerror=...>` string in the escaping test as a broken image. I added a narrow ignore for that one test file only. You can delete the file if you would rather not keep it; the warning would come back.

**Needs your decision before Sprint 5:** none blocking.

### Follow-up tweaks (requested after review)

**Asked for**
1. Every tag and keyword copies its text on click.
2. A new **Style prompt** section under the style guide: the whole style guide reformatted as a paste-ready instruction for Claude or any other agent, with a copy icon at the top right.
3. Remove the copy buttons at the top; put a copy icon in each section instead.
4. Make the style guide generic and universal, so it can become a whole design system, not just the elements visible in the image.

**Done**
- **Chips:** tags and keywords in the detail sheet are buttons. Click copies the text and shows a toast and a brief "Copied". Tags on the grid cards are still plain; Sprint 5 uses them as filters.
- **Section copy icons:** Description, Palette (one `#HEX: role (name)` line per colour), Keywords, Style guide and Style prompt each have a copy icon at the top right of the section. The three top buttons are gone. A single small "copy everything" icon stays in the sheet's top bar (all sections as Markdown), because story 13 asks for an everything copy.
- **Style prompt:** a new `stylePrompt` field in the analysis schema, written by the model as a standalone brief (starts "Use the following design system for everything you build in this project.", imperative rules with tokens, never mentions the reference, ends by telling the agent to extrapolate consistently). It is also in "Copy everything".
- **Generic design system:** the prompt now asks for 13 fixed sections (Design principles, Colour, Typography, Layout & grid, Spacing & sizing, Shape borders & elevation, Components, Iconography, Imagery & illustration, Motion, Content & voice, Accessibility, Do and don't). It must generalise rather than describe the image, use tokens (hex, px, weights, durations, easing, radii, shadows), and cover a full component set (buttons, inputs, selects, switches, tabs, tables, modals, toasts, navigation, charts and so on) by extrapolation, marking anything not seen as "(inferred)". Palette roles gained success, warning, danger and info. The description field stays a literal description of the image (story 7).
- **Re-analysing older items:** analyses record which prompt version made them (migration 3, existing ones are version 1, new ones version 2). The header shows "Update N older" (with a confirmation, since it uses your Claude plan), the sheet has a per-item "Re-analyse", and `npm run analyse -- --reanalyse` does it from a terminal. The old result stays until the new one lands, and hand edits are never touched. Nothing is re-analysed automatically.

**Test results**
- `npm test`: 102 of 102 pass (15 new): prompt asks for every section in order, for extrapolation and for a standalone prompt; schema requires `stylePrompt` and rejects a thin guide; per-section copy text; "Copy everything" ends with the style prompt; version tracking, requeue rules and hand edits kept; re-analyse routes over HTTP with a stubbed runner, including the missing-CLI refusal.
- Real run on a copy of your library: re-analysed the weather image and the video with the real CLI. Both came back at version 2 with all 13 headings in order, about 9 to 10 k characters of style guide (was about 3 k), 19 to 21 "(inferred)" marks, 10 palette colours including semantic roles, and a 740 to 790 word style prompt. The components section covers buttons through toasts with sizes, states and hex values even though the image shows only some. The style prompt does not refer to the image; the only hits for words like "photo" or "frame" were genuine rules (for example "dark photo scrims", "32 outer frame").
- Browser: five section icons present, top buttons gone. A real click on the style prompt icon gave "Copied style prompt" and the icon turned into a tick; a real click on a tag gave Copied "dark-mode". Captured payloads: tag text, keyword text, description, palette lines, keywords, style guide starting at `### Design principles`, style prompt starting at "Use the following design system…", and the everything copy with the five sections in order.

**Things to know**
- **Time and usage:** a fuller analysis is slower and longer. About 56 s for the image and 62 s for the video, against about 25 s before. Re-analysing all 9 items at 2 in parallel is roughly 5 minutes of your Claude plan. That is why "Update N older" asks first.
- **Style may carry the source's subject:** because it is derived from one reference, the prompt can keep domain flavour (the weather sample's prompt talks about "rain blue" and "heat orange" as colour meanings). It is generic in structure and covers unseen components, but it is still your reference's language.
- **Programmatic clicks:** in the preview pane, a script-made click cannot copy (no user gesture); real clicks work. Not an app issue.
- Only 2 of your 9 items were re-analysed, and only in my scratch copy. Your real library still shows "Update 9 older" until you choose to run it.

### Detail view polish (after merge of Sprint 4)

**Asked for:** shorter and smaller description (about 200 to 300 words); the "Copied" flash must not change a button's size and should be shorter; style guide and style prompt as two switchable views under one heading with a Raw Markdown view; six colours per palette row.

**Done**
- **Description:** the prompt now asks for 200 to 300 words in two short paragraphs of plain prose (schema allows up to 2,600 characters so a long answer is not thrown away). Text is 13 px with preserved paragraph breaks. This applies to new analyses; existing descriptions are unchanged, and the prompt version was not bumped, so nothing shows as "older".
- **Copy feedback:** every copy button flashes for 0.8 s (was 1.5 s) and keeps its exact size. Tags and keywords are locked to their own width while they read "Copied" (a tick if the chip is too narrow for the word); the icon buttons swap the icon for a tick in the same 30 px box; swatches already sit in a fixed grid. Measured on a real click: chip 101.6 x 25.6 px before, during and after. The toast also stays up for 2.2 s instead of 4 s.
- **Style section:** one "Style" heading. Two switches: **Style guide / Style prompt**, and **Preview / Raw**. Preview shows the formatted text; Raw shows the Markdown in a monospace, selectable block. The copy icon at the top right copies whichever document is open (always the raw Markdown), and its label says which. The Preview / Raw choice is remembered. Style prompts are now requested as Markdown (`##` headings, bullet lists) so Preview renders them properly; older prompts are plain text and still read fine.
- **Palette:** six colours per row at desktop width (10 colours show as 6 + 4); three per row on a phone. Swatches are slightly smaller with tighter type so six fit.
- **Also fixed (found while checking your library copy):** a failed re-analysis used to hide the earlier good result in the sheet. The sheet now keeps showing it beneath the failure note. A new **Retry N failed** button in the header (and `POST /api/retry-failed`) retries every failed item at once, so you do not have to press Retry on each card after signing in again.

**Test results:** 108 of 108 pass (6 new: description length, Markdown prompt, retry-all-failed, a failed re-analysis keeps the earlier result). Browser at 1280 px: six swatches per row, chip size unchanged while flashing, both documents switch, Raw persists across a reload, and the copy icon's payload is the style guide (9,191 characters, starts `### Design principles`) or the style prompt (4,411 characters, starts "Use the following design system…") depending on the tab.

**Known issues**
- Your real library copy showed 8 failed and 1 analysed. That is the expired Claude Code login (see below), not data loss: the earlier results are still stored and the sheet shows them again after this change. Sign in with `claude auth login`, then press **Retry 8 failed**.
- The preview pane in the desktop app reports a zero-width window until it is resized, which tripped the phone breakpoint during testing; in a normal browser window the layout is as described.

## Sprint 5 — Curate and polish

**Goal:** the library is yours to curate. Filter by tags, edit any field, and edits are never overwritten.
**Stories:** 11 (filter by one or more tags), 12 (edit title, tags, description, style guide, keywords; saved locally; never overwritten by a later analysis), plus story 9 polish and the final end-to-end check.

### Planning

| # | Task | Acceptance criteria |
| --- | --- | --- |
| 1 | Filter and sort logic | Tag counts, match-all filtering, sort (Newest, A to Z, Recently analysed) as pure, tested functions. Filter lives in the URL (`?tags=a,b`) and survives a refresh |
| 2 | Filter bar, grid wiring | Select, deselect and clear tags. "N of M" count and a clear empty state. Grid-card tags toggle filters. Sheet arrows follow the filtered list |
| 3 | Edit validation and `PATCH /api/items/:id` | Only title, tags, description, keywords, style guide and style prompt are editable. Types and sizes are checked, tags normalised onto the existing vocabulary. A value saves it; `null` reverts to the AI version. Bad input gets a clear 400 |
| 4 | Edits are never overwritten | Re-analysis replaces AI output only. An edited field, and an edited tag list, stay exactly as set. Tag tables stay in sync and orphan tags are pruned |
| 5 | Edit UI in the sheet | Pencil per field, Save / Cancel (Ctrl+Enter saves, Esc cancels), tag and keyword chip editors with autocomplete for tags, "Edited" marker with Revert to AI, guard against losing unsaved text |
| 6 | Polish | Loading skeletons, empty and error states, keyboard and focus pass, visual pass at desktop and phone width, dark and light |
| 7 | Tests | Filter and sort logic, tag normalisation on edit, PATCH validation, revert, edits surviving re-analysis, tag sync |
| 8 | End-to-end | All 14 stories walked through with real samples and the video, plus a clean-install run (`npm ci`, test, build) from a copy of the project |

### Review

**Built**
- **Filter by tags (story 11):** a bar under the header lists every tag with its count (most used first; first 14 shown, "Show all" for the rest). Select one or more tags to see only items that carry all of them. Tags on grid cards toggle the same filter. "N of M" tally, **Clear filter**, and a clear empty state ("No item has all of these tags…"). The selection lives in the URL (`?tags=a,b`, other parameters kept), so refresh and bookmarks keep it. The sheet's arrows and "2 of 3" counter follow the filtered list.
- **Sort:** Newest first (default), A to Z (case- and number-aware: "Item 9" before "Item 10"), Recently analysed. The choice is remembered.
- **Edit (story 12):** a pencil on the title, tags, description, keywords, and the open style document (guide or prompt). One editor at a time; Enter saves a title, Ctrl+Enter saves long text, Esc cancels, Save and Cancel buttons. Tags and keywords use a chip editor (Enter or comma adds, Backspace removes, Enter on an empty box saves; tags autocomplete from the library vocabulary and are tidied to kebab-case). Fields you changed show **Edited** and **Revert to AI** (**Remove edit** if there is no AI version). Unsaved text is protected: closing, stepping to another item, or switching document asks first. Unanalysed items can be named and tagged too.
- **Edits are never overwritten:** `PATCH /api/items/:id` validates and stores edits apart from the AI result (`user_json`). A re-analysis replaces only the AI side, and an edited tag list is left alone (reverting tags shows the newest AI tags). Tag tables stay in sync and unused tags are pruned.
- **Polish (story 9):** shimmering placeholder cards while the library loads and a clear message if the server cannot be reached, a loading skeleton in the sheet, a "no matches" state, keyboard support throughout (chips and filters are real buttons with pressed states, Esc cancels an edit before it closes the sheet), tab trapping includes the editors.
- Extra API: items now carry `analysedAt` (for the sort).

**Try it**
```bash
npm start
```
Click tags in the bar to filter. Open any card, press a pencil, change something, Save. Press **Re-analyse** (or **Update N older**) and watch your edit survive.

**Test results**
- `npm test`: 126 of 126 pass (18 new): tag counts and match-all filtering, URL round-trip, sort rules, edit validation (every field, limits, normalisation onto the vocabulary), store edits and revert, tag sync and pruning, edits surviving re-analysis, and PATCH over HTTP (success, 400 messages, 404, malformed JSON, cross-origin refusal). One Sprint 2 test was updated to the new "an edited tag list is yours" rule.
- Typecheck and build clean. **Clean-install check:** copied the project without `node_modules`, `.git`, `dist` or samples to a temp folder, ran `npm ci`, typecheck, tests (126 of 126) and build, then started the server from that copy: UI served, ffmpeg and Claude Code detected, first-run state shown.
- **Real end-to-end** on a copy of your library with the real CLI (your login works again):
  - Story 1 and 2: copied a new image into the source folder, pressed Rescan, got a pending card.
  - Story 5 and 7: Analyse pending ran the real CLI (50 s): "Earthly Pollen Atlas", tags reused from the library vocabulary.
  - Story 4: edited its title, changed the file's bytes, rescan: back to pending, title "My Atlas" kept, earlier AI result kept until the new one lands.
  - Story 3: deleted the file, rescan: item and its thumbnails gone.
  - Story 11: selecting dark-mode then dashboard gave "3 of 9", URL `?tags=dark-mode,dashboard`, survived a reload; the sheet counter read "1 of 3", "2 of 3"; a nonexistent tag showed the empty state with the chip still clearable; A to Z order verified.
  - Story 12: edited title (grid, sheet and API all show it), tags ("Fresh Tag" became `fresh-tag`, "Dashboards" folded into the existing `dashboard`, the new tag appeared in the filter bar with a count), and description (Ctrl+Enter). The unsaved-changes guard asked before Next and kept my text when I declined. Then a real re-analysis of that edited item: the AI title, description (276 words, inside the 200 to 300 target) and style prompt all changed, while my title, my five tags and my description were identical afterwards. Revert to AI on the description restored the AI text and left the other two edits.
  - Stories 8 to 10, 13 and 14 were verified in Sprints 3 and 4 and re-checked here (video card, detail sheet, copy buttons, swatches, six per row).

**Known issues**
- The "Retry 7 failed" button in your real library is still showing from before you signed in again; press it and those 7 re-run (about 8 minutes at 2 in parallel). They still show their earlier results in the meantime.
- Editing the palette is not supported (not in the story list). Palette colours always show the AI's.
- Tags are replaced as a whole when you edit them: after editing, new AI tags from a later analysis do not merge in until you revert. That is the "your edit wins" rule applied to tags.
- Native browser autocomplete (`datalist`) is used for tag suggestions, so its look follows the browser.
- Not covered by automated tests: the React/Preact components themselves (no browser test runner in the project). The logic is tested and the UI was exercised by hand in a real browser, as listed above.
- Still no free-text search, cloud sync, sharing or mobile app (out of scope for v1), and no live folder watching: Rescan or relaunch picks up changes.

**Decisions and trade-offs**
- Editing tags replaces the AI list wholesale (field-level "your edit wins"), the simplest rule that can never be overwritten by accident.
- Filter matches **all** selected tags (as in the roadmap).
- Per-field Save and Cancel rather than autosave, so a half-typed style guide is never stored.
- Filter and sort run in the browser over the full list. Fine at personal-library sizes; the API already returns everything in one request.
- `datalist` and small hand-written components rather than a UI library, to keep dependencies at one runtime package (`preact`) plus `ajv`.

**v1 status:** all 14 user stories are built, tested and checked against real samples including a video. Roadmap deliverables for Sprints 1 to 5 are done.

### Tidy-up after Sprint 5

**Asked for:** remove the extra border around each tag in the filter bar; drop one of style guide or style prompt, since they show the same thing; cut descriptions to 150 to 200 words.

**Done**
- **Filter-bar tags:** each tag sat inside a bordered list item as well as having its own border. The extra border and padding on the list item are gone; each tag now has a single outline.
- **One style document:** I kept the **style guide** and dropped the **style prompt**. The guide is the complete design system, so nothing is lost, and removing the second document means shorter analyses and a simpler Style section (heading "Style guide", with just Preview and Raw). To keep the one thing the prompt did, the guide now opens with "Use the following design system for everything you build in this project." and ends with the "where this is silent, extrapolate" line, and must not mention the reference image, so it pastes straight into a new project. The schema, prompt, copy text, edit rules and tests no longer have a style prompt. "Copy everything" is now description, palette, keywords and style guide.
- **Description:** the prompt asks for 150 to 200 words in one or two plain paragraphs (schema allows up to 2,000 characters so a slightly long answer is not thrown away).
- **Prompt version 3:** because the prompt changed, your 9 existing analyses now show **Update 9 older** in the header. Nothing is re-run on its own. Until you re-analyse them (all at once with that button, or one at a time with **Re-analyse** in the sheet) they keep their old, longer descriptions and the old separate prompt is simply no longer shown. Your edits are kept either way.

**Test results:** 126 of 126 pass, typecheck and build clean. Real check on a copy of your library: re-analysed the weather item with the real CLI (55 s). Result: description 194 words in one paragraph, guide opens with the instruction line and ends with the extrapolation line, 13 sections, 11 k characters, no style prompt field, no mention of the image. In the browser the sheet shows Description, Palette, Keywords and Style guide (Preview or Raw), the filter chips measure a single 1 px outline with the list item at 0, and the old items show the "analysed with an earlier version" note.

**Known issues:** none new. The previous review's note about the 7 failed retries no longer applies; they are all analysed in your library.

## v1 sign-off

**Closed:** Taste Library v1 accepted by the product owner after Sprint 5 (merged as PR #6).

- All 14 user stories built, tested (126 of 126) and checked end to end against a real library, including video.
- Roadmap deliverables for Sprints 1 to 5 are done. No open defects.
- Left for later (not in v1): live folder watching, free-text search, subfolder names as tags, global slash-command install, bulk edits and tag rename or merge, library export or import. A v2 backlog will be pitched before any work starts.
