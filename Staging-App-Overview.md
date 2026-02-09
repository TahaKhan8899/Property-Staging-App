# WH Staging Assistant — Updated Product Overview

This document captures the current behavior of the WH Staging Assistant after multiple iterations beyond the original [Staging-PRD.txt](Staging-PRD.txt). It reflects what is implemented in the repository as of today, including server-side persistence, AI integrations, and reliability tooling that have been added since the MVP concept.

---

## 1. Purpose & Success

- **Problem:** The pre-app workflow required jumping between ChatGPT, Nano Banana Pro, and desktop organization tools to stage 4–5 rooms per unit (~60–70 minutes each).  
- **Goal:** Provide one pane of glass to upload unit photos, label rooms, auto-generate/edit prompts, produce 4K renders, and download deliverables.  
- **Success metric:** ≥50% reduction in per-unit staging time. Current solution introduces automated prompt generation, streamlined approvals, and one-click rendering, moving the process toward that target.

---

## 2. Current Workflow (End-to-End)

1. **Session setup:** App boots into a sidebar of persisted sessions. A new session can be created or an existing one renamed/deleted (`App.tsx:85-112`).  
2. **API-key gate:** An overlay blocks the UI until a Gemini API key is confirmed via AI Studio or a manual entry saved to localStorage (`components/ApiKeySelector.tsx:11-116`).  
3. **Image intake:** The “Add Rooms” palette uploads files per room type. Files are auto-renamed and stored in `server/uploads/<session>/original` with sequential numbering (e.g., `Bedroom 2.jpg`) (`server/index.js:305-375`).  
4. **Room cards:** Each upload produces a `RoomCard` with original preview, prompt workspace, action footer, and staged output once available (`components/RoomCard.tsx`).  
5. **Prompt generation:** Clicking **Generate Prompt** invokes Gemini 3 Pro (text model) with the designer system prompt plus optional “initial thoughts” jot sheet. Output becomes editable text with reset/regenerate/refine tools and approval gating (`components/RoomCard.tsx:550-637`).  
6. **Render:** When a prompt is approved, **Generate Staged Image (4K)** calls the Nano Banana Pro equivalent (`gemini-3-pro-image-preview`) via streaming, surfaces interim thinking/images, then persists the resulting JPEG and version metadata (`components/RoomCard.tsx:133-199`, `services/geminiService.ts:208-330`, `server/index.js:381-451`).  
7. **Review & iteration:** Users can edit renders inline, upload replacements, hop across version history, compare original vs staged in a full-modal view, and download 4K or server-side-compressed copies (`components/RoomCard.tsx:203-701`, `components/ImageCompareModal.tsx`).  
8. **Delivery:** Staged files live under `/uploads/<Session>/staged`. The server can emit compressed JPGs on demand via Sharp (`server/index.js:657-717`). Manual downloads open in a new tab for immediate saving.

---

## 3. Feature Map vs Original PRD

| Theme | PRD Expectation | Current Implementation |
| --- | --- | --- |
| Sessions/Units | Single in-memory session per run | Persistent SQLite-backed session list with rename/delete, automatic folder renames, and auto-create on first launch (`App.tsx`, `server/index.js:118-271`) |
| Image upload | Manual upload through UI, session-scoped | Drag-to-upload per room type with sanitized naming and folder structure; server enforces unique numbering per type (`server/index.js:305-375`) |
| Prompting | Generate once, edit, approve | Adds initial-thoughts textbox, structured designer system prompt (12-point rubric), regenerate/reset + AI-powered refine, and approval state that locks textarea (`components/RoomCard.tsx:109-578`, `constants.ts:1-94`) |
| AI Models | Gemini 3 Pro + Nano Banana Pro | Implemented via `@google/genai` SDK with model constants, manual API key capture, progress streaming, and exponential backoff for 503s (`services/geminiService.ts:1-330`) |
| Rendering | One-click 4K | Supports 4K/16:9 default rendering, inline progress narration, interim image previews, and auto-JPEG conversion before persistence (`components/RoomCard.tsx:133-199`, `services/geminiService.ts:208-330`) |
| Review UI | Side-by-side original vs staged | Adds compare modal with keyboard toggles, downloadable compressed copies, version navigation, edit instructions, external upload with versioning, and delete confirmations (`components/RoomCard.tsx:203-701`, `components/ImageCompareModal.tsx`) |
| Storage | In-memory MVP | Local SQLite (`server/db.js`) + filesystem hierarchy `/server/uploads/<Session>/{original,staged,staged-compressed}` with cascading cleanup and recorded version metadata |
| Extras beyond PRD | N/A | Version history, render editing, streaming progress, manual staged uploads, session rename propagation, API key overlay, compressed downloads, confirm-to-delete guard, stats per session, Dexie placeholder if needed later |

---

## 4. Detailed Feature Notes

### Sessions & Asset Management
- Session list is persisted in SQLite with `lastModified` timestamps powering the sidebar sort (`server/index.js:118-271`).  
- Renaming a session moves its folder and rewrites every `rooms.filePath`, `rooms.generatedImageUrl`, and `image_versions.url` entry so previously generated files remain valid (`server/index.js:143-227`).  
- Deleting a session cascades to DB and filesystem removal to prevent orphaned uploads (`server/index.js:253-271`).  
- Stats at the top of the canvas surface total rooms/prompts/renders to help track progress per unit (`App.tsx:157-161`).

### Prompt Workflow Enhancements
- Each card includes an “Initial Thoughts” sketchpad saved on the room entity so Gemini can blend client instructions into the prompt template (`components/RoomCard.tsx:592-610`).  
- Refinement uses Gemini Pro to rewrite an existing prompt from user feedback without resetting the entire card (`components/RoomCard.tsx:109-123`).  
- Reset brings back the last AI output stored as `initialPrompt` for easy backtracking (`components/RoomCard.tsx:125-131`).  
- Approval locks the textarea and gates render actions, ensuring Nano Banana Pro is only triggered on vetted instructions (`components/RoomCard.tsx:100-105`, `640-657`).  
- The designer system prompt codifies brand styling rules, per-room guidance, equipment constraints, and example prompts in a single constant for maintainability (`constants.ts:1-94`).

### Image Generation, Editing, and Delivery
- Streaming progress displays Gemini “thoughts” and interim images in both generate and edit flows so the user sees if the model is stuck before final output arrives (`components/RoomCard.tsx:133-199`, `467-526`).  
- Exponential backoff with retry guards 503 errors when hitting `gemini-3-pro-image-preview`, and each render is time-boxed to five minutes (`services/geminiService.ts:208-330`).  
- Every render (auto or manual upload) creates an `image_versions` row, enabling previous-version restores, version navigation UI, and descriptions describing what changed (`components/RoomCard.tsx:203-241`, `server/index.js:381-520`).  
- Users can upload staged assets from other editors (e.g., Canva), which are versioned exactly like AI renders (`server/index.js:453-525`, `components/RoomCard.tsx:220-241`).  
- The compare modal offers full-screen, keyboard-friendly before/after toggling to inspect details before delivery (`components/ImageCompareModal.tsx:10-110`).  
- Download controls include original 4K (opens new tab) and server-compressed JPEGs built with Sharp for lightweight review sharing (`components/RoomCard.tsx:243-431`, `server/index.js:657-717`).

### Reliability & Guardrails
- API keys can be pulled from Vite env vars, localStorage, or AI Studio’s `window.aistudio` bridge to match Gemini billing models (`components/ApiKeySelector.tsx`, `services/geminiService.ts:42-50`).  
- Upload naming sanitizes both session names and room types, ensuring directories stay filesystem safe and consistent even when renamed later (`server/index.js:22-92`, `305-375`).  
- Room type changes trigger filesystem renames so “Bedroom 1” can convert to “Living Room 3” without manual cleanup (`server/index.js:528-610`).  
- Delete buttons include a confirm-to-delete toggle that times out to avoid accidental asset drops (`components/RoomCard.tsx:263-341`).  
- Server exposes `/api/health` for quick smoke checks and uses WAL-mode SQLite for concurrent reads (`server/index.js:111-114`, `server/db.js:1-52`).

### Recent Enhancements from Git History
- `57d16e1`: Added the compare modal and richer version navigation UI.  
- `5e3899f`, `509a2c8`: Introduced compressed download flow and Sharp dependency.  
- `73dab22`: Delivered image editing + versioning, enabling the edit textbox + Apply Edits CTA.  
- `fa2514a`: Added prompt refinement, initial-thoughts capture, and stricter stage guidelines.  
- `27295c3` & `d39883f`: Streaming progress with interim images plus exponential backoff for unstable image generation.  
- `2fc558b`: Manual staged uploads + delete confirmations.  
- `36dcf73`: Session rename cascade to keep DB/filesystem synchronized.  
These commits show the app has matured beyond an MVP script into a resilient operator console.

---

## 5. Architecture & Data Flow

### Frontend
- **Stack:** React 19 + TypeScript served by Vite; Tailwind is loaded via CDN in `index.html`.  
- **State sources:** Local component state for UI transitions, server for canonical sessions/rooms, and localStorage for the Gemini API key.  
- **Key components:**  
  - `App.tsx` orchestrates session CRUD, room fetches, upload triggers, and gating overlays.  
  - `RoomCard.tsx` encapsulates each room’s full lifecycle, including progress states, prompt editing, downloads, uploads, and compare launching.  
  - `ApiKeySelector.tsx` and `ImageCompareModal.tsx` handle cross-cutting overlays.  
- **Services:** `services/db.ts` wraps the REST API, centralizing `fetch` calls and URL normalization; `services/geminiService.ts` abstracts AI calls.

### Backend & Storage
- **API:** Express server on port 3001 with CORS + JSON body parsing; routes cover sessions, rooms, file uploads, generated-image persistence, versioning, and compressed downloads (`server/index.js`).  
- **Database:** SQLite via `better-sqlite3` with `sessions`, `rooms`, and `image_versions` tables and WAL mode for reliability (`server/db.js`).  
- **Filesystem:** Under `server/uploads/<Session>/{original,staged,staged-compressed}`. Multer stores temp uploads before they’re renamed into session directories, and Sharp produces compressed JPGs on demand.  
- **Versioning:** Each generated or uploaded staged image writes a version row with description and timestamp, enabling `GET /api/rooms/:id/versions` and restore endpoints.  
- **Compression route:** `/api/rooms/:id/download-compressed` regenerates or reuses a `staged-compressed` file and redirects to the static asset, so the UI can simply `window.open` the link.

### AI Integration
- **Models:** `gemini-3-pro-preview` for prompt/prompt refinements and `gemini-3-pro-image-preview` for staging & edits (constants defined in `constants.ts`).  
- **Safety:** Each request instantiates a `GoogleGenAI` client with the latest API key, uses streaming to surface progress, and retries 503s with exponential backoff (`services/geminiService.ts:52-459`).  
- **Prompt template:** The user prompt template enforces architectural constraints (“KEEP ALL ARCHITECTURE…”), brand palette, and contextual user notes to maximize fidelity.  
- **Editing:** Edit instructions emphasize no structural deviation, using the same streaming architecture as the initial render.

---

## 6. Data Model Snapshot

| Entity | Key Fields | Notes |
| --- | --- | --- |
| `sessions` | `id`, `name`, `lastModified` | Drives sidebar list and folder naming; cascade delete removes associated rooms (`server/db.js:19-41`) |
| `rooms` | `roomType`, `customLabel`, `filePath`, `generatedPrompt`, `initialPrompt`, prompt/image flags, `generatedImageUrl`, `currentVersionId` | Mirrors `RoomData` in the frontend (`types.ts:19-42`) |
| `image_versions` | `roomId`, `url`, `timestamp`, `description`, `versionNumber` | Power history navigation, restore endpoint, and metadata shown in UI |

Front-end `RoomData` extends this with runtime-only fields (File object, previewUrl, UI states).

---

## 7. Operational Notes

- **Dev workflow:** `npm run dev` starts both the Express server (`npm run server`) and Vite UI concurrently (`package.json`).  
- **API key setup:** Provide `VITE_GEMINI_API_KEY` in env, or enter it via the overlay; the key is stored in `localStorage.gemini_api_key`.  
- **Assets/DB location:** SQLite DB lives at `/database.sqlite`; uploads remain under `/server/uploads`, which is `.gitignore`d.  
- **Dependencies:**  
  - Runtime: `@google/genai`, `express`, `multer`, `sharp`, `better-sqlite3`, `react`, `dexie` (future local caching), etc.  
  - Dev: `vite`, `@vitejs/plugin-react`, `typescript`.  
- **Browser support:** Tailwind loaded via CDN plus Inter font ensures consistent styling without a custom CSS build step.

---

## 8. Open Opportunities

1. **ZIP export:** PRD still lists “Download all as ZIP”; current server exposes single-file downloads only.  
2. **Session sync/backup:** Everything remains local to the desktop, so cross-device collaboration and cloud persistence are future work.  
3. **QA workflows:** No automated QA checklist or approval pipeline beyond manual review states.  
4. **Style presets:** Only WH Property styling exists; preset switching hasn’t been implemented in `constants.ts`.  
5. **Access control:** App assumes a trusted single operator; no auth or roles.  
6. **Resumable uploads / drag-and-drop multi-select:** Current UI opens a native file picker per room type; batching remains a future enhancement.

These align with the “Nice-to-Haves” and “Non-Goals” from the original PRD and help prioritize next iterations.

---

This overview should serve as the living spec for the current code. Use it to onboard collaborators, scope QA, or plan upcoming enhancements without rereading the entire codebase. Updates should be made whenever notable features land.
