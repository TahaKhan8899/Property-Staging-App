# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start both frontend (port 3000) and backend (port 3001) concurrently
npm run server     # Start only the Express backend on port 3001
npm run build      # Build frontend for production (Vite)
npm run preview    # Preview production build
```

No linting or test commands are configured — the project has no test framework.

## Architecture

This is a full-stack property staging app where users upload room photos and use Google Gemini to generate AI-staged versions.

**Frontend**: React 19 + TypeScript on Vite (port 3000). All API calls go to `http://localhost:3001/api`. State is managed locally in `App.tsx` — there is no global state library.

**Backend**: Express 5 + better-sqlite3 (port 3001). Handles session/room CRUD, file uploads (Multer), image compression (Sharp), and proxies requests to the Gemini API. Database is WAL-mode SQLite at `./database.sqlite`.

**AI Integration**: `services/geminiService.ts` wraps `@google/genai`. Two Gemini models are used — one for prompt generation (text) and one for image generation (image). Model names and the image resolution constant (`2K`) are in `constants.ts`. Image generation streams interim results back to the frontend.

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

The Gemini API key comes from (in priority order): `window.aistudio` bridge (AI Studio), `localStorage.gemini_api_key`, or the `VITE_GEMINI_API_KEY` env var from `.env.local`. The backend also reads `GEMINI_API_KEY` from environment for server-side calls.

## Notable Details

- Session renames cascade to both the DB and the `server/uploads/` folder via a dedicated API endpoint.
- The `services/db.ts` file is a thin fetch-based REST client — not IndexedDB (Dexie is imported but used only as a placeholder for future local caching).
- `vite.config.ts` explicitly exposes `API_KEY` and `GEMINI_API_KEY` as globals via `define`.
- Sharp compression runs server-side on download, not on ingest.
