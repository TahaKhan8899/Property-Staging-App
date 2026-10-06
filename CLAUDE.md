# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start both frontend (port 3000) and backend (port 3001) concurrently
npm run server     # Start only the Express backend on port 3001
npm run build      # Build frontend for production (Vite)
npm run preview    # Preview production build
npm test           # Vitest: server integration tests (temp DB + uploads), prompt-builder and system-prompt guard tests
npm run test:watch # Vitest in watch mode
```

**Before committing:** `npx tsc --noEmit -p tsconfig.json` and `npm test` must both pass. Tests never touch the real `database.sqlite` or `server/uploads` (they use `STAGING_DB_PATH` / `STAGING_UPLOADS_ROOT` temp paths) and never call Gemini. No linter is configured.

## Architecture

This is a full-stack property staging app where users upload room photos and use Google Gemini to generate AI-staged versions.

**Frontend**: React 19 + TypeScript on Vite (port 3000). All API calls go to `http://localhost:3001/api`. State is managed locally in `App.tsx` — there is no global state library.

**Backend**: Express 5 + better-sqlite3 (port 3001). Handles session/room CRUD, file uploads (Multer), image compression (Sharp), and proxies requests to the Gemini API. Database is WAL-mode SQLite at `./database.sqlite`.

**AI Integration**: All Gemini calls run on the server. `server/gemini.js` wraps `@google/genai`; `server/geminiRoutes.js` exposes `POST /api/rooms/:id/prompt`, `/refine-prompt`, `/render` (`{ candidates: 1..3, prompt?, referenceVersionId?, referenceMode? }`; `referenceMode` is `"reference"` (default) or `"text"`, which renders a linked room from its own photo without the reference image, or an array of those, one per candidate, whose length is the candidate count) and `/edit` (`{ instructions, rawPrompt?, intents?, baseVersionId?, referenceRoomId?, referenceVersionId?, referenceImage?, referenceLabel? }`; a reference is sent as Image 1 with an "Image 1 is a reference image" preamble; `referenceRoomId` may be the room itself when `referenceVersionId` names another of its versions); `/prompt` also takes `referenceVersionId` and `referenceMode: "text"` (designer prompt from the photo alone, even for a linked room). `PUT /api/rooms/:id/prompt` (`{ prompt, approve? }`) saves a hand-written prompt without touching `initialPrompt`. Version targeting never moves a room's current version; only saving a new version does. Each returns JSON, or streams Server-Sent Events (`thought`, `candidate_done`/`candidate_error` per render candidate, `done`, `error`) when the request sends `Accept: text/event-stream`; the UI uses SSE via `services/stagingApi.ts`, an agent or `curl` can use plain JSON. A busy room returns 409; render requires an approved prompt (or an explicit `prompt`). A multi-candidate render saves versions in candidate order once all candidates finish and leaves the lowest new version (candidate 1, or the first that succeeded) current. Every call writes an `api_calls` row server-side, and every saved image goes through `saveGeneratedBuffer` in `server/index.js` so it gets a version and a `promptSnapshot`. Pure helpers (prompt builders, stream parsing, cost math) are in `shared/gemini-core.js`; models, pricing, `2K`/`16:9` and system prompts are in `shared/constants.js` (re-exported by `constants.ts`) so server and client share them. Two models: one text model for prompts, one image model for renders and edits.

**File Storage**: Uploaded and generated images live under `server/uploads/<SessionName>/`:
- `original/` — user-uploaded room photos
- `staged/` — AI-generated images (versioned with numeric suffixes)
- `staged-compressed/` — Sharp-compressed JPEGs for download

## Key Data Flow

1. User creates a **Session** (maps to a named folder under `server/uploads/`)
2. User uploads images per room → stored in `original/`
3. Gemini text model analyzes the image and generates a staging prompt
4. User edits and approves the prompt
5. Gemini image model streams a 2K staged image → saved to `staged/` with version tracking
6. `ImageVersion` records in SQLite track version history with prompt snapshots

## Data Models

Defined in `types.ts`:
- **Session** — id, name, lastModified, status, sortOrder
- **RoomData** — roomType, customLabel, filePath, prompts, image states, versions
- **ImageVersion** — id, url, timestamp, description, versionNumber, promptSnapshot

Database schema (3 tables): `sessions`, `rooms`, `image_versions` — cascading deletes are configured so removing a session also removes its rooms.

## API Key

`GEMINI_API_KEY` in `.env.local`, loaded by the server at startup (`process.loadEnvFile`), or from the server's environment. The browser never sees it. `GET /api/health` reports `geminiKeyConfigured`; the UI shows a blocking notice when it is false. Tests never load `.env.local` and use an injected fake client (`setGeminiClientForTests`).

## Notable Details

- There is no `GET /api/sessions/:id`. Read a session with `GET /api/sessions` (list), `GET /api/sessions/:id/rooms` (rooms with prompts, `currentVersionId`, `referenceRoomId`, output fields), `GET /api/rooms/:id/versions` (versions with parsed `promptSnapshot`) and `GET /api/sessions/:id/usage`.
- Session renames cascade to both the DB and the `server/uploads/` folder via a dedicated API endpoint.
- The `services/db.ts` file is a thin fetch-based REST client — not IndexedDB (Dexie is imported but used only as a placeholder for future local caching).
- Sharp compression runs server-side on download, not on ingest.
