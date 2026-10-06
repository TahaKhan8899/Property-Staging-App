# WH Staging Assistant: Workflow Optimization Implementation Plan

**Status:** approved by Taha on 2026-10-06. Ready to implement.
**Repo state this plan was written against:** `main` at `8e5d4c4` (after the usage-logging and prompt-rule commits of Oct 5).
**Audience:** the AI coding agent implementing this, plus Taha as reviewer.

---

## 0. How to use this document

- Work through the items **in order, one item per commit**, on a feature branch. Each item has its own acceptance criteria and a manual test. Stop after each item so Taha can review before the next.
- Read `CLAUDE.md` first. It describes the stack, ports, folders and data flow.
- Before coding an item, open the files it names and confirm the line anchors. They were correct at `8e5d4c4` and will drift as items land.
- Item 0 adds a test suite. Until it lands, the gate for every commit is: `npx tsc --noEmit -p tsconfig.json` passes (it passes today), `npm run dev` starts, and the item's manual test passes. After item 0, `npm test` is added to that gate, and every later item that touches a server route or a prompt builder must add or extend a test.
- Do **not** bundle unrelated refactors into an item. Do **not** build anything in section 7 (rejected ideas).

---

## 1. Context the implementer needs

### The business
- Solo operator (Taha) virtually stages apartment photos for one client (Arthur, WH Property Group). $70 per floor plan, 5 to 7 final images, one consolidated revision round. 13 floor plans are queued.
- Target: **under 60 minutes of Taha's time per floor-plan set, all-in**. The last batch ran about **4 hours per set** and about **$11 of Gemini API per set**.
- Taha's time is the bottleneck, not API cost. One extra Nano Banana Pro render costs $0.134. If it saves one 3-minute human loop it has paid for itself. Rule for every item: **spend API to buy minutes; cut API only where it costs no minutes.** Soft budget: keep a set under about $10 of API.

### Where the 4 hours go (from the 497 and 504-101 sets)
| Phase | Minutes per set | Driver |
|---|---|---|
| First pass | 60 | About 19 generations, roughly 6 min of human work per card |
| Self-polish | 45 | Human QA plus Canva color passes |
| Client revision round | 70 | Taste rules that were not in the system prompt (now partly fixed) |
| Final edits and delivery | 49 | More edits, manual zipping |

- The Feb 2026 process ran about 41 min per set with about 3 image versions per room. The current batch ran about 8 versions per room. Generation speed did not change; iteration count did.
- Per set: about 26 edits, about 41 image calls, about 12 Canva re-uploads. Edits were 65% of image calls.
- Reference-angle rooms (same room, other camera angle, staged from an anchor render) averaged 7 image calls per room versus 3 to 5 for normal rooms. One kitchen took 16 versions, 11 of them full regenerations, from perspective drift.
- Three mechanisms cause the extra versions:
  1. Every edit regenerates the whole frame, so a drape edit silently changes shelf color and wall art, which costs another edit.
  2. Each generation is one dice roll. A sectional took 8 tries.
  3. Writing a precise edit prompt means leaving the app for a separate Claude chat: screenshot, describe, copy the prompt back.

### The app today (read `CLAUDE.md`, then these)
- Frontend `App.tsx` (sessions, sidebar, stats, usage readout), `components/RoomCard.tsx` (the entire per-room loop), `components/ImageCompareModal.tsx`, `components/PromptViewerModal.tsx`.
- `services/geminiService.ts`: `generateStagingPrompt` (L132), `generateReferenceAnglePrompt` (L223), `refinePrompt` (L270), `generateStagedImage` (L315), `editGeneratedImage` (L457). Every call logs usage via `recordApiCall` (L94) into the `api_calls` table. **Any new Gemini call must do the same.**
- `services/db.ts`: thin REST client. `ApiCallLog.kind` union (L200) must be extended for any new call kind.
- `server/index.js`: Express routes. Output folder helpers `getOutputDir` (L130), `getRoomOutputFileName`, `removeRoomOutputFile` (L140). Compressed download route (L845) uses `sharp().jpeg({ quality: 50, mozjpeg: true })`.
- `server/db.js`: schema plus try/catch `ALTER TABLE` migrations. Add new columns the same way.
- `constants.ts`: models (`gemini-3.1-pro-preview` text, `gemini-3-pro-image` image), `MODEL_PRICING`, `DESIGNER_SYSTEM_PROMPT`, `REFERENCE_ANGLE_SYSTEM_PROMPT`, `IMAGE_RESOLUTION = '2K'`, `IMAGE_ASPECT_RATIO = '16:9'`.
- `types.ts`: `RoomData` already has `referenceRoomId`, `outputSourcePath`; `PromptSnapshot` already has `editInstruction`, `rawPrompt`, `notes`, `source`.
- Files: `server/uploads/<Session>/{original,staged,staged-compressed,output}/`.
- Every saved image is an `image_versions` row with a `promptSnapshot`. Keep that invariant.
- The installed `@google/genai` is 1.33.0. `GenerateContentConfig` exposes `seed` and `candidateCount`; `ImageConfig` has **no mask input**. Multi-candidate must be done with parallel requests, not `candidateCount` (unverified on image models).

---

## 2. Hard constraints (do not relitigate)

1. Aspect ratio stays **16:9**, resolution stays **2K**, for all deliverable renders.
2. Image generation stays on **Gemini Nano Banana Pro** (`gemini-3-pro-image`), except the explicit Flash latency test in item 3.3.
3. **No image-editing controls in the app**: no color, lighting, exposure or crop tools. The Canva color pass stays outside the app. No pixel diff or region accept/reject overlay (rejected: tone shifts between generations make it unreliable).
4. **Do not add rules to `REFERENCE_ANGLE_SYSTEM_PROMPT`.** Fix reference-angle problems mechanically (candidates, references), not with more prompt text.
5. Prompt rules must not be overfit to one example. Any standing-item rule must carry "where it makes natural sense and the space is not overcrowded" or equivalent, never a bare "always".
6. Single operator, local app. No auth, no cloud, no multi-user.
7. Every Gemini call is logged through `recordApiCall`. Every saved image gets a `promptSnapshot`.
8. File and folder names go through `sanitizeName` in `server/index.js`.

---

## 3. Batch 1: build before set 504-102

### 0. Regression test suite (build first)

**Goal.** Give every later agent a `npm test` that catches the class of bug that has already bitten this repo twice: commits `9bb1c53` (duplicate room names broke Download Compressed) and `51718e3` (wrong next room number). Nothing in the UI and nothing that calls Gemini. Target run time under 10 seconds.

**Scope.**
- **Vitest**, since the project is on Vite. Add `"test": "vitest run"` and `"test:watch": "vitest"` to `package.json`. Add `npm test` to the commit gate in `CLAUDE.md`.
- **Server integration tests** (`server/__tests__/`), run with `supertest` against the Express app, a temp SQLite file and a temp uploads folder per test file. Cover, in this order of value:
  1. Upload naming: `POST /api/rooms` picks the next unused number per room type, including after a delete and after a room-type change.
  2. Room-type rename (`PATCH /api/rooms/:id` with `roomType`) renames the original and staged files and updates `filePath` and `generatedImageUrl`.
  3. Versioning: `POST /api/rooms/:id/generated` writes `<base>_vN.jpg`, inserts the `image_versions` row with the prompt snapshot, updates `currentVersionId`; the backfill path for a room with an image but no versions creates version 1 first.
  4. `POST /api/rooms/:id/upload-staged` behaves like a generated save with description "Uploaded external image".
  5. Restore: `POST /api/rooms/:id/versions/:versionId/restore` sets the room's current URL and id; unknown version returns 404.
  6. Output folder: add, re-add after a version change (old file removed, new copied), remove, and two rooms with the same base name get ` (2)`.
  7. Compressed download: two rooms named `Kitchen 3` get `Kitchen 3_compressed.jpg` and `Kitchen 3 (2)_compressed.jpg`; the output is a smaller JPEG; a restored older version is recompressed, not served from cache.
  8. Session rename (`PATCH /api/sessions/:id` with `name`) moves the folder and rewrites every `rooms.filePath`, `rooms.generatedImageUrl` and `image_versions.url`.
  9. Session delete cascades rooms, versions and the folder; `api_calls` rows survive.
  10. Usage: `POST /api/usage` resolves session from room; `GET /api/sessions/:id/usage` totals and groups correctly.
  Use tiny real JPEGs generated with Sharp in a `beforeAll`, not fixtures checked into git.
- **Prompt-shape unit tests** (`services/__tests__/`). These need the builders extracted into pure functions first (see refactor below). Assert:
  1. `buildEditPrompt(instructions)` contains the user text, the "Keep everything else IDENTICAL" block, and the closing "Do not add any new objects" sentence.
  2. With `rawPrompt: true` the text is passed through untouched (needed by item 1.3).
  3. Parts ordering: with a reference, parts are `[reference image, target image, text]`; without, `[target image, text]` (needed by items 1.2 and 1.4).
  4. `guessMimeType` handles `.png`, `.jpg`, query strings and `File` objects.
  5. Stream parsing: given fake chunks with a thought image, a final image and a `usageMetadata` chunk, the parser returns the final image, reports the thought image through `onProgress`, and captures usage.
  6. `recordApiCall` cost math: given a usage object with image and text modalities, the computed `costUsd` matches `MODEL_PRICING`.
- **System prompt guard tests** (`constants.test.ts`). `DESIGNER_SYSTEM_PROMPT` contains the "CAMERA ANGLE AND PERSPECTIVE LOCK" section and the three all-caps lock phrases. Every line in the room guidelines that contains "always" or "Always" also contains a qualifier such as "where it makes", "if", "unless" or "when" (constraint 5). `REFERENCE_ANGLE_SYSTEM_PROMPT` is byte-identical to a stored snapshot, so any change to it is a deliberate, reviewed act (constraint 4).

**Refactor required, kept minimal.**
- `server/db.js` (L9): read the database path from `process.env.STAGING_DB_PATH`, defaulting to the current `../database.sqlite`.
- `server/index.js`: replace the six `path.join(__dirname, 'uploads')` uses (L78, L115, L174, L186, L885 and any others) with one `UPLOADS_ROOT` constant read from `process.env.STAGING_UPLOADS_ROOT`, defaulting to the current folder. Move `app.listen` (L981) into a new `server/start.js` and `export default app` from `server/index.js`. Update the `server` script in `package.json` to run `server/start.js`. Behavior with no env vars set must be unchanged.
- `services/geminiService.ts`: extract `buildEditPrompt`, `buildImageParts`, and a `collectImageFromStream(stream, onProgress)` helper, and export them. The exported Gemini functions keep their signatures and call these. `fileToGenerativePart` stays as is; tests pass data URLs or `File` objects.
- Vitest config: `environment: 'node'` for server and service tests. `fileToGenerativePart` uses `FileReader`, so tests that need it should run in the `jsdom` environment via a per-file `// @vitest-environment jsdom` comment, or pass pre-encoded base64 and avoid it.

**Not in scope.** React component tests, Playwright, any test that hits the Gemini API, coverage thresholds.

**Acceptance.**
- `npm test` passes in under 10 seconds on a clean checkout with no `.env.local`.
- `npm run dev` and `npm run server` behave exactly as before, same DB file, same uploads folder, same port.
- Deleting the database and uploads from a test run leaves the real `database.sqlite` and `server/uploads` untouched (tests only ever use temp paths).
- `CLAUDE.md` lists `npm test` under Commands and in a new "Before committing" line alongside `tsc`.

**Manual test.** Run `npm test` twice in a row; both green. Start the app, upload one room, confirm the file lands in `server/uploads/<Session>/original/` as before.

---

### 1.1 Zip export (staged and compressed)

**Goal.** One click downloads the finished set as two zips, replacing the manual download-and-zip done twice per delivery. Saves about 10 min per set.

**Design.**
- Server route `GET /api/sessions/:id/export?variant=staged|compressed`.
  - `staged`: streams every file in `output/` for the session, unchanged.
  - `compressed`: for each file in `output/`, run the same Sharp settings as the download-compressed route (`quality: 50, mozjpeg: true`) into the zip entry. Same file names as `output/`. Extract the Sharp call into a shared helper so both routes stay identical.
  - Zip file name: `<sanitized session name> - Staged.zip` or `<sanitized session name> - Compressed.zip`, via `Content-Disposition`.
  - Empty `output/` returns 404 with `{ error: 'No images in output' }`.
  - Use the `archiver` package (add to `dependencies`). Stream to the response; do not write zips to disk.
- Client: add `getSessionExportUrl(sessionId, variant)` to `services/db.ts`. In the `App.tsx` session header, add two buttons, "Download Staged ZIP" and "Download Compressed ZIP", with a count "N images in output". Disable when the count is 0. Open via `window.open` like the existing compressed download.
- Show a small warning in that header when any room has a stale output (`room.outputSourcePath` set but not equal to the current version; the card already computes `hasStaleOutput`). Lift that helper or recompute in `App.tsx`.

**Tests to add (item 0 suite).** Export route: both variants list exactly the output files, compressed entries are smaller, 404 on empty output, zip file name uses the sanitized session name.

**Acceptance.**
- Both zips contain exactly the files in `output/`, same names, nothing else.
- Compressed entries are smaller than staged entries and visually match the existing per-image compressed download.
- Buttons disabled with 0 output images; stale warning appears when a room's current version differs from its output copy.

**Manual test.** Add 2 rooms to output, download both zips, unzip, compare file lists and sizes. Navigate one room to an older version, confirm the stale warning.

---

### 1.1b Server-side Gemini routes (added 2026-10-06 by Taha)

**Goal.** Every Gemini call runs today in the browser (`services/geminiService.ts`: API key from `localStorage`, JPEG conversion on a `<canvas>`). Express only stores files. Move the calls behind server routes so the UI and an AI agent (a Claude Code session or skill such as a future `/stage-set <folder>`) drive the same endpoints, renders survive a closed tab, and items 1.2 to 2.2 are built once, server-side. Without this, those items are reachable only by browser automation.

**Design.**
- New server module `server/gemini.js` (or `.ts` via a shared build-free import) holding the call logic. Reuse the pure builders extracted in item 0 (`buildEditPrompt`, `buildImageParts`, `collectImageFromStream`, `computeCallCost`); move them to a module both client tests and server can import, with no browser APIs.
- API key: `GEMINI_API_KEY` from the server environment (`.env.local`, already read). The browser key paths stay only as long as the client still calls Gemini directly during the migration, then are removed.
- Routes, each logging to `api_calls` server-side with the same kinds and cost math, and saving images through the existing versioning code path (shared function, not an internal HTTP call), so every saved image still gets a `promptSnapshot`:
  - `POST /api/rooms/:id/prompt` `{ userComments? }` → writes `initialPrompt` and `generatedPrompt`; uses `generateReferenceAnglePrompt` when the room has `referenceRoomId`.
  - `POST /api/rooms/:id/refine-prompt` `{ feedback }`.
  - `POST /api/rooms/:id/render` `{ candidates?: 1..3 }` → renders from the approved prompt (and the reference room's current image when set); returns the new versions.
  - `POST /api/rooms/:id/edit` `{ instructions, rawPrompt?, referenceRoomId? }`.
- Final image: re-encode to JPEG with Sharp (quality 90, white background flatten) instead of the client canvas.
- Progress: each long route streams Server-Sent Events (`thought` text, interim image data URL, `done` with the saved version, `error`) when the request sends `Accept: text/event-stream`; otherwise it waits and returns JSON. The UI uses SSE; an agent can use plain JSON.
- Client: `RoomCard` switches to these routes. Behavior and UI stay the same (interim thoughts and previews still shown).
- Concurrency: per-room in-flight guard so a second render on the same room returns 409 instead of racing version numbers.

**Tests to add.** Inject a fake Gemini client into `server/gemini.js` (no network): prompt route writes both prompt columns; render with `candidates: 3` saves versions 1 to 3 and logs three `generate` rows; edit with `rawPrompt` sends the text untouched; SSE emits `thought`, `done`; 409 on concurrent render; missing `GEMINI_API_KEY` returns a clear 500.

**Acceptance.**
- With the browser's `localStorage` key cleared, prompt, render and edit all work from the UI.
- `curl` can run prompt → approve (`PATCH`) → render → edit for a room and get saved versions back.
- `api_calls` rows and costs match what the client logged before for the same calls.
- Closing the tab mid-render still saves the version.

**Manual test.** Stage one room end to end in the UI. Then do the same room with `curl` only.

**Order.** Items 1.2, 1.3, 1.4, 2.1 detection, 2.2 and 3.2 are implemented on these routes, not in `geminiService.ts`.

---

### 1.2 Reference image on edits

**Goal.** An edit can carry a second image: the anchor angle of the same room, or a photo of a specific piece, so "exactly that sectional" lands in one try instead of eight. Saves 15 to 25 min per set.

**Design.**
- `editGeneratedImage(generatedImageUrl, editInstructions, onProgress, roomId, referenceFileOrUrl?)` in `services/geminiService.ts` (L457). When the reference is present, send it as the first `inlineData` part, the current render second, then the text. Without it, the request must be byte-for-byte what it is today.
- When a reference is present, prepend to the edit prompt:
  > "Image 1 is a reference image. Image 2 is the image to edit. Generate image 2 exactly the same, but make the following specific edits only. Where an edit below refers to the reference, match the furniture or decor from image 1 as closely as possible in style, color and material, placed correctly for image 2's perspective."
  Then the existing instruction and keep list. Keep the existing wording otherwise.
- UI in the `RoomCard` edit panel (the `isEditingMode` block): a "Reference for this edit" row with a dropdown of staged sibling rooms (reuse the `referenceOptions` prop, pre-selected to `room.referenceRoomId` when set) and an "Upload photo" option that opens a file input. Show a thumbnail of the chosen reference. The uploaded file lives in component state only and is cleared after the edit; it is **not** persisted in Batch 1.
- Snapshot: `buildPromptSnapshot('edit', { editInstruction, notes: 'Edit reference: <sibling label or file name>' })`.
- Log kind stays `edit`.

**Tests to add.** `buildImageParts` with and without a reference; `buildEditPrompt` with a reference prepends the "Image 1 is a reference image" sentence and without it is unchanged from the stored expectation.

**Acceptance.**
- Edit with no reference: identical request shape and behavior to today.
- Edit with a sibling reference: two image parts then text, in that order; version saved with the reference note in its snapshot.
- Edit with an uploaded photo: same, using the file's real MIME type.

**Manual test.** On a 2-angle room, edit the dependent angle with the anchor as reference and ask to match the sofa. Open View Prompt on the new version and confirm the note.

---

### 1.3 Edit composer (precise edit prompts written inside the app)

**Goal.** Replace the external Claude chat loop. Taha types short intents; the app writes the full precise edit prompt from the actual images, in the shape he already uses; he reviews and applies. Saves 30 to 45 min per set. Also replaces Opus's "edit queue" idea: several intents become one numbered prompt and one image call.

**Design.**
- New constant `EDIT_COMPOSER_SYSTEM_PROMPT` in `constants.ts`. The output must have this fixed shape, and nothing else:
  1. One opening sentence locking camera, framing, perspective, crop and lighting to image 2.
  2. "Keep exactly as they are:" followed by a bulleted list of every visible item in **this** image: architecture and fixtures (from the original photo, image 1) and all furniture and decor (from the current render, image 2), each with color, material and position in the frame. Only items actually visible; never invented.
  3. "Changes:" a numbered list, one number per intent, each literal and anchored to a position in the frame ("the sofa along the right wall"). When an intent names a specific piece, specify exactly that piece.
  4. One closing sentence: "Make no other changes. Do not add, remove, move, recolor or restyle anything not listed under Changes."
  Rules inside the system prompt: output only the prompt; no headings beyond the two labels; no design advice; never add items the user did not ask for; never weaken the lock.
- New function `composeEditPrompt(currentRenderUrl, originalUrl, intents, roomType, lastEditInstruction | undefined, roomId)` in `services/geminiService.ts`, on `MODEL_TEXT_ANALYSIS`. Parts: original photo, current render, text. Log with kind `compose_edit` (extend the `ApiCallLog.kind` union in `services/db.ts` and the comment in `server/db.js`).
- `editGeneratedImage` must **not** wrap a composed prompt in the generic template again. Add an options argument, for example `{ rawPrompt: true }`, that sends the text as-is. The snapshot for a composed edit stores `editInstruction` = the user's intents, `rawPrompt` = the composed prompt, `source: 'edit-composed'`.
- UI in the edit panel: two tabs, "Compose" (default) and "Quick". Compose: textarea for intents, one per line; button "Write prompt"; the composed prompt appears in an editable textarea with "Apply" and "Rewrite". Quick is today's behavior. The reference picker from item 1.2 applies to both tabs. If a reference is attached, pass that fact into the composer so the Changes list can say "match the sectional in the reference image".

**Tests to add.** `rawPrompt: true` bypasses the template; the composer request's parts are `[original, current render, text]`; `EDIT_COMPOSER_SYSTEM_PROMPT` contains the two labels "Keep exactly as they are:" and "Changes:" and the closing sentence.

**Acceptance.**
- Composed prompt has the four parts in order; number of Changes equals number of non-empty intent lines.
- Keep list names only items visible in the images (spot-check 3 renders).
- Applying produces a version whose snapshot has `source: 'edit-composed'`, the intents, and the raw prompt.
- `api_calls` shows a `compose_edit` row and an `edit` row for one composed edit.

**Manual test.** On a staged living room, intents: "replace the sofa with a light-beige L-sectional along the right wall" and "remove the bistro table". Confirm the prompt lists the rug, art, lamps and plants under Keep, has exactly 2 Changes, and the render changes only those.

---

### 1.4 Parallel candidates for reference-angle rooms

**Goal.** Reference-angle rooms miss most often (7 calls per room). Fire 3 renders at once and pick one, so a room needs 1 to 2 rounds instead of 5 to 7 serial tries. Default stays 1 candidate for normal rooms. Expected: same or lower cost per room, far fewer human rounds.

**Design.**
- `RoomCard` gets a candidate selector (1, 2, 3) next to Generate Staged Image. Default: 3 when a reference room is selected, 1 otherwise. Show "≈ $0.13 per candidate" next to it.
- `handleGenerateImage` (L209) runs N calls to the unchanged `generateStagedImage` via `Promise.allSettled`, in parallel. Each success is saved with `saveGeneratedImage(room.id, img, 'Candidate k of N', snapshot)` with `notes` including the candidate index. Failures do not block the others; show "2 of 3 succeeded" if any fail.
- After completion, show a candidate strip (thumbnails of the N new versions) above the result. Clicking one calls the existing restore endpoint and sets it current. The strip hides once the user navigates away or edits.
- Progress: reuse `progressThought`; show "Generating 3 candidates, 1 finished" style text. Interim images from the first stream are fine to display.
- Use parallel requests, not `candidateCount`.
- Not for edits in Batch 1.

**Tests to add.** Saving three candidates in quick succession yields version numbers 1, 2, 3 with no collisions in file names (server test, three parallel `POST /generated` calls).

**Acceptance.**
- With N=3, three `image_versions` rows and three `generate` rows in `api_calls` appear for the room.
- Picking a candidate sets it current; version navigation still works across all versions.
- N=1 behaves exactly like today.

**Manual test.** Stage a dependent angle with a reference at N=3, pick the best, edit it, confirm the strip hides and versions are 4.

---

### 1.5 Measure prompt editing before approval (no new storage)

**Goal.** Decide later whether the prompt approval gate can go. The data already exists: `rooms.initialPrompt` is the generated prompt and `rooms.generatedPrompt` is what was approved (manual edits and AI refine both change it).

**Design.**
- Add to the `/api/sessions/:id/usage` response: `promptsApproved` and `promptsEdited` = count of rooms with `isPromptApproved = 1` and `generatedPrompt != initialPrompt`.
- Show "Prompts edited before approval: 4 of 7" in the session header next to the spend readout.

**Acceptance.** Counts match a manual SQL check. No schema change.

---

## 4. Batch 2: build before set 504-201

### 2.1 Same-room angle detection with floor plan, user-confirmed

**Goal.** Find which uploaded photos are the same room from different angles and propose anchor and dependent pairings, so reference setup is automatic. Taha is skeptical of accuracy, so this is **propose and confirm**, never auto-apply. A floor plan image, when Arthur sends one, is the main accuracy lever.

**Design.**
- Session-level optional upload "Floor plan" stored at `server/uploads/<Session>/reference/floorplan.<ext>`, new column `sessions.floorPlanPath`.
- Button "Detect same-room angles" in the session header. New service `detectSameRoomGroups(originals[], floorPlanUrl | undefined, sessionId)` on `MODEL_TEXT_ANALYSIS` with structured JSON output (`responseMimeType: 'application/json'` and a `responseSchema`): `groups: [{ anchorRoomId, dependentRoomIds[], reason, confidence }]`. The anchor is the widest or most furniture-defining view, usually the living room. Log kind `detect_angles`.
- UI: a proposal panel listing groups with thumbnails and confidence. Per group: "Apply" sets `referenceRoomId` on dependents via the existing PATCH; "Dismiss" does nothing. Nothing is written until Apply.

**Acceptance.** Proposals render; Apply sets `referenceRoomId`; Dismiss changes nothing; rooms with no groups show "No same-room pairs found".

---

### 2.2 Anchor cascade

**Goal.** When an anchor render changes, dependent angles are flagged and can be re-derived in one click instead of redoing each by hand. Only matters on open-plan sets; cheap to build now that 2.1 exists.

**Design.**
- New column `rooms.referenceVersionId`: the anchor version used for the dependent's last generation. Set in `handleGenerateImage` when a reference is used (the `ReferenceOption` already carries `currentVersionId`).
- A dependent is stale when its anchor's `currentVersionId` differs from `referenceVersionId`. Show a banner on the card: "Anchor changed since this render" with a button "Re-derive". Re-derive runs `generateReferenceAnglePrompt` with the new anchor, auto-approves that prompt, and renders with the card's candidate count (default 3).
- Session header: "Re-derive all stale (N)" runs the above for every stale dependent in parallel.

**Acceptance.** Change an anchor's current version; dependents show the banner; Re-derive produces new versions with the new anchor noted in the snapshot; banner clears.

---

## 5. Batch 3: build before set 504-202, each gated on data from the earlier sets

### 3.1 Keyboard review mode
Full-screen, one room at a time, built on `ImageCompareModal`. Keys: Space toggles original and staged; Left and Right move versions; A adds to output and advances; E opens the edit composer for that room; Esc exits. Shows version count and whether the room is in output.

### 3.2 Narrow architecture QA, flags only
A Dec 2025 broad "critique this image" QA hallucinated and was abandoned. This is narrower and advisory. New service `checkArchitecture(originalUrl, stagedUrl, roomId)` on `MODEL_TEXT_ANALYSIS` with a JSON schema: counts in both images for windows, doors, outlets, vents, ceiling lights, sinks, cabinets; `countertopChanged`, `perspectiveShift` in `none | minor | major`; a `notes` string. Show mismatches as yellow flags on the card with "verify" wording. Never blocks anything. Log kind `qa_check`. **Decision rule:** after two sets, if more than half the flags were false, remove it.

### 3.3 Flash edits latency test
Add `MODEL_IMAGE_EDIT_FAST = 'gemini-3.1-flash-image'` and a "Fast" toggle in the edit panel. Pricing per `MODEL_PRICING`: about $0.101 per 2K image versus $0.134, so the point is latency, not cost. Log the model per call (already done). **Decision rule:** after one set, compare median edit latency and the share of Flash edits that survived as the current version. Keep only if it is meaningfully faster without a worse keep rate.

### 3.4 Approval gate removal, conditional
Only if item 1.5 shows prompts edited before approval are under about 20% across two sets. Then add a per-session toggle "Auto-render after prompt" that generates the prompt, marks it approved, and renders immediately with the card's candidate count. The prompt stays viewable and editable afterwards. Default off.

---

## 6. Process rules (no code, start now)

1. **Canva once, last.** Color-grade only final versions right before delivery. 25 re-uploads for 13 delivered images means each image was graded about twice; an AI edit after a grade throws the grade away.
2. **One edit call, several numbered changes.** Up to about 4 changes per call. The composer (1.3) formats this automatically.
3. **Promote repeated edits to prompt rules after every set.** Query the edit instructions in `image_versions.promptSnapshot` and the diff between `rooms.initialPrompt` and `rooms.generatedPrompt`. Respect constraint 5 when writing rules.
4. **Reference-angle rooms wait for a final anchor**, then generate with 3 candidates.

---

## 7. Rejected or deferred (do not build)

| Idea | Decision | Reason |
|---|---|---|
| Pixel-diff accept or reject overlay for edit drift | Rejected | Tone shifts slightly on every generation, so the diff is noise. |
| Image-editing controls in the app (color, lighting, crop) | Rejected | Canva stays. |
| Gemini Batch API for first renders | Rejected | 50% off but minutes-to-hours latency. Opposed to the goal. |
| Server-side job queue as a first step | Deferred | Cards already run in parallel from the browser. Only needed for tab-closed operation. |
| Unit-wide design brief injected into every prompt | Deferred | Client complaints were about same-room angles and missing items, not cross-room palette. |
| 1K drafts, then 2K finals | Rejected | 1K and 2K cost the same; re-rendering the winner is a new dice roll. |
| Lower resolution, input compression, trimming the system prompt | Rejected | Saves under a cent per call. |
| Cheaper model for first renders | Rejected | Camera lock matters most on the first render. |
| Additions to `REFERENCE_ANGLE_SYSTEM_PROMPT` | Rejected | Constraint 4. |
| Auto room-type labeling on upload | Low priority | Saves about a minute; accuracy doubts. Only as a side effect of 2.1. |

---

## 8. Measurement after each set

Run against `database.sqlite` after each delivered set and record in `Time Tracking.md`:

```sql
-- versions per room
SELECT r.roomType, r.customLabel, COUNT(v.id) AS versions
FROM rooms r LEFT JOIN image_versions v ON v.roomId = r.id
WHERE r.sessionId = ? GROUP BY r.id ORDER BY versions DESC;

-- edits per set
SELECT COUNT(*) FROM image_versions v JOIN rooms r ON r.id = v.roomId
WHERE r.sessionId = ? AND json_extract(v.promptSnapshot, '$.source') IN ('edit', 'edit-composed');

-- spend and failures per set
SELECT kind, model, COUNT(*) AS calls, ROUND(SUM(costUsd), 2) AS usd,
       SUM(status = 'error') AS failed
FROM api_calls WHERE sessionId = ? GROUP BY kind, model;

-- prompts edited before approval
SELECT SUM(isPromptApproved = 1) AS approved,
       SUM(isPromptApproved = 1 AND generatedPrompt != initialPrompt) AS edited
FROM rooms WHERE sessionId = ?;
```

Targets after Batch 1: versions per room at or under 4, edits per set at or under 12, API at or under $10 per set, Taha's time at or under 2.5 h per set. After Batch 2 and 3: 60 to 75 min per set.

---

## 9. Open flags for Taha (not for the implementer)

- Commit `8e5d4c4` sets living rooms to "L-sectional, skip accent chairs by default" and kitchens to "Always style the counters with an espresso machine". Both were previously rejected as overfit or bare-always rules (constraint 5). Keep or soften is Taha's call; the implementer must not change them.
- `DESIGNER_SYSTEM_PROMPT` still says "sets of 4–5 images per unit". Reality is about 6, capped at 7. Safe one-line fix; include it with item 1.1.
