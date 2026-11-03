# Taste Library — Roadmap (v1)

A local, visual library of UI and design inspiration, built from a folder of
images and videos. Claude Code (headless) analyses each item into a title,
description, style guide, palette, keywords and tags.

Status: **v1 built (Sprints 1 to 5). See SPRINT_LOG.md.**

---

## 1. Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | **Node 26 + TypeScript** (native type stripping, no build step for the server) | Already installed. Spawning `claude` and `ffmpeg` is trivial with `child_process`. One language front to back. |
| Server | **`node:http`** (thin router, ~100 lines) | Handful of JSON endpoints, static files, a media stream with range support and one SSE stream. A framework adds nothing here. |
| Storage | **`node:sqlite`** (built into Node) | Zero install, transactional, safe if the app and the slash command touch the DB at the same time (WAL mode). |
| UI | **Vite + Preact + TypeScript**, hand-written CSS | Small (3 kB runtime), component model for the grid / detail / editor, no UI kit so the design is ours. |
| Media | **ffmpeg / ffprobe** | Thumbnails for every format (incl. WEBP/GIF), video keyframes, durations. No `sharp` needed. |
| AI | **`claude -p … --output-format json --json-schema <schema>`** | Headless, structured output validated by the CLI, then re-checked by us. No API keys. |
| Tests | **`node:test`** | Built in. Unit tests for scanner, hashing, change detection, storage, schema validation, merge rules. |

**Runtime dependencies:** `preact` only. Dev: `vite`, `@preact/preset-vite`,
`typescript`, `ajv` (schema validation in tests and before save).

**Shape of the app:** a local web app. `npm start` checks for `ffmpeg` and
`claude`, scans the folder, starts the server on `localhost:4477` and opens the
browser. No Electron/Tauri: more weight for no real gain on a single-user tool.

### Architecture

```
            ┌──────────────── Browser (Preact UI) ────────────────┐
            │ Grid · Tag filter · Detail/editor · Settings        │
            └──────────────▲───────────────────┬──────────────────┘
                     SSE (status)        JSON API / media
            ┌──────────────┴───────────────────▼──────────────────┐
            │ node:http server                                    │
            │  scanner ─ change detector ─ thumbnailer (ffmpeg)   │
            │  analysis queue ──► analyser core ──► claude -p     │
            └──────┬──────────────────────────────────┬───────────┘
                   │                                  │
     Source folder (read-only)        App data dir (%APPDATA%\taste-library)
                                        library.db · config.json
                                        thumbs/ · frames/ · logs/

  Terminal: /analyse-taste ──► npm run analyse ──► same analyser core
```

- **`src/analysis/`** is the single shared place for `prompt.md`,
  `schema.json` and the analyser core. The in-app button and the slash command
  both call it, so output is identical.
- **Source folder is read-only.** The app only reads and hashes files there.
  Every generated file lives in the app data directory.
- **Concurrency:** items are claimed atomically (`pending → analysing`) in
  SQLite, so the app and the terminal command never analyse the same item twice.
  Two analyses run in parallel by default (configurable).

---

## 2. Data model (SQLite)

```sql
items (
  id            INTEGER PRIMARY KEY,
  rel_path      TEXT UNIQUE NOT NULL,   -- relative to source folder
  kind          TEXT NOT NULL,          -- 'image' | 'video'
  size          INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,          -- sha256
  width INTEGER, height INTEGER, duration_s REAL,
  status        TEXT NOT NULL,          -- pending | analysing | analysed | failed
  error         TEXT,                   -- last failure message
  ai_json       TEXT,                   -- last valid analysis (schema below)
  user_json     TEXT,                   -- hand edits: only fields the user changed
  analysed_hash TEXT,                   -- content_hash the ai_json belongs to
  added_at, updated_at, analysed_at
)
tags      (id, name UNIQUE)             -- normalised vocabulary
item_tags (item_id, tag_id, source)     -- source: 'ai' | 'user'
settings  -- kept in config.json: sourceFolder, concurrency, keyframes, model
```

**Effective value of any field = `user_json[field] ?? ai_json[field]`.**
Re-analysis only ever replaces `ai_json`, so hand edits always win (stories 4, 12).

**Change detection on launch** (and on "Rescan"):

1. Walk the folder recursively. Unsupported extensions are skipped and logged.
2. Path not in DB → **new** (hash it, thumbnail it, status `pending`).
3. Path in DB, size and mtime unchanged → **unchanged** (no hashing; fast).
4. Size or mtime changed → re-hash. Hash differs → **changed**: status `pending`,
   new thumbnail, `user_json` kept. Hash same → just update mtime.
5. Path in DB but not on disk → **deleted**: row, tags links, thumbs and frames removed.

A rename is therefore a delete plus a new file (story 3, as specified).

Formats: images `png jpg jpeg webp gif`, videos `mp4 mov webm`.

---

## 3. Analysis JSON schema

Passed to `claude --json-schema` and re-validated with `ajv` before saving.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["title", "description", "styleGuide", "palette", "keywords", "tags"],
  "properties": {
    "title":       { "type": "string", "minLength": 2, "maxLength": 60 },
    "description": { "type": "string", "minLength": 80 },
    "styleGuide":  {
      "type": "string",
      "description": "Markdown with sections: Colour, Typography, Layout & grid, Spacing, Components & patterns, Iconography, Imagery, Texture & depth, Mood"
    },
    "palette": {
      "type": "array", "minItems": 2, "maxItems": 10,
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["hex", "role"],
        "properties": {
          "hex":  { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
          "role": { "enum": ["primary", "secondary", "accent", "background", "surface", "text", "muted", "border"] },
          "name": { "type": "string" }
        }
      }
    },
    "keywords": { "type": "array", "minItems": 5, "maxItems": 20, "items": { "type": "string" } },
    "tags":     { "type": "array", "minItems": 2, "maxItems": 6,  "items": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" } }
  }
}
```

- **Tag vocabulary:** the prompt includes the current tag list and asks Claude
  to reuse existing tags. On save, tags are lower-cased, kebab-cased and
  matched against existing tags (plural/singular and simple-alias folding), so
  `Dark Mode`, `dark-modes` and `darkmode` collapse into `dark-mode`.
- **Videos:** 6 keyframes, evenly spaced (configurable; scene-change mode as an
  option), all passed in one `claude -p` call and analysed as one item.
- **Failures** (non-zero exit, timeout, bad JSON, schema mismatch) set status
  `failed` with the reason. "Retry" sets it back to `pending`.

---

## 4. Sprints

Each sprint ends with a review in `SPRINT_LOG.md` and a stop for approval.

### Sprint 1 — Library foundation
**Goal:** the folder becomes a visible library, before any AI.
**Stories:** 1, 2, 3, (4: changed files go back to pending)
**Tasks:** project scaffold, config + settings screen (source folder), startup
check for `ffmpeg`/`claude`, scanner + change detection, SQLite store,
thumbnails, grid of "Pending analysis" cards, Rescan button.
**Tests:** scanner, hashing, new/changed/deleted/rename detection, read-only
guarantee, unsupported-format skipping, storage.
**Deliverable:** `npm start` opens a grid of your images and videos as
pending cards; add/delete a file, rescan, see it change.

### Sprint 2 — Analysis engine (images)
**Goal:** pending images become analysed items.
**Stories:** 4, 5, 6, 7
**Tasks:** `prompt.md` + `schema.json`, analyser core around `claude -p`,
validation, tag normalisation, queue with atomic claiming, "Analyse pending"
button with live progress (SSE), failure state + retry, `/analyse-taste`
slash command + `npm run analyse`, user-edit merge rule.
**Tests:** schema validation (good/bad fixtures), tag normalisation, merge
rule, queue claiming, failure handling with a stubbed `claude`.
**Deliverable:** click "Analyse pending" (or run `/analyse-taste`) and watch
cards fill in with titles and tags.

### Sprint 3 — Video
**Goal:** videos are first-class items.
**Stories:** 8, 9 (hover preview)
**Tasks:** ffprobe metadata, keyframe extraction (even / scene-change),
multi-frame analysis, media endpoint with range requests, hover-to-preview on cards.
**Tests:** keyframe timestamps, frame cache cleanup on change/delete.
**Deliverable:** drop in an MP4, it gets analysed from its keyframes and
previews on hover.

### Sprint 4 — Detail view & reuse
**Goal:** each item becomes a usable style guide.
**Stories:** 10, 13, 14
**Tasks:** expanded detail view (full media, video playback, description,
rendered style guide, palette, keywords), copy style guide / keywords /
everything, swatches that copy hex, keyboard navigation (←/→, Esc).
**Deliverable:** open any item and paste its style guide into another tool.

### Sprint 5 — Editing, filtering & polish
**Goal:** the library is yours to curate.
**Stories:** 11, 12 (and 9 polish)
**Tasks:** inline editing of every field with "edited" markers and
"revert to AI" per field, tag editor with autocomplete from the vocabulary,
multi-tag filter (match all), empty/loading/error states, design pass.
**Tests:** edit persistence across re-analysis, filter queries.
**Deliverable:** full v1. End-to-end run with real images and at least one video.

---

## 5. Design direction (UI)

Gallery, not dashboard. Near-black neutral canvas so the media carries the
colour; one restrained accent. Masonry-style grid that respects each item's
aspect ratio, generous gutters, quiet typography (one grotesk, tight tracking,
small caps for metadata). Detail view as a full-height sheet: media left,
guide right. Motion only where it explains state (pending shimmer, analysis
progress). Light theme follows the system setting.

---

## 6. Decisions made by default (change any)

- App data in `%APPDATA%\taste-library` (XDG / `~/Library` on other OSes).
- Source folder chosen on first launch in the UI; no hard-coded path.
- Scan on launch + manual Rescan. Live folder watching is a later nice-to-have.
- Subfolders are included; their names are not used as tags in v1.
- Slash command lives in the project's `.claude/commands/`; an optional
  install step can copy it to `~/.claude/commands` so it works from anywhere.
- Tag filter uses "match all selected tags".
- Out of scope (per brief): free-text search, sync, sharing, mobile.
