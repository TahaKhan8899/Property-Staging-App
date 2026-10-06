---
name: stage-set
description: Stage a floor-plan set of raw apartment photos end to end through the WH Staging app's HTTP API (session, uploads, floor-plan mapping, prompts, renders, Taha's review stops, revisions, output). Use when Taha says "stage <set>", "/stage-set <folder>", points at a folder of raw room photos (usually ~/Downloads/<set>), or asks an agent to run or revise a staging set.
---

# stage-set

Drive the staging app over its API so Taha only reviews and picks. The app is local: API `http://localhost:3001/api`, UI `http://localhost:3002`. Read `CLAUDE.md` for the route list. This skill must change in the same commit as any route it uses.

## Hard rules

- Never edit app code, commit, or kill/restart node or vite processes. If the API is down, stop and tell Taha.
- Never delete sessions, rooms or versions. Never send `initialPrompt` in a PATCH; it is the measurement baseline for prompt edits.
- Never re-roll a room Taha has accepted, not even to test a new rule.
- Guard rails: at most 8 image calls (render candidates + edits) per room before stopping to ask, and stop to ask when the set passes $8 of Gemini spend (`GET /api/sessions/:id/usage`). A typical set should land around $5.
- Retry a failed call once. If it fails again, stop and report the error text.
- 16:9 and 2K are fixed server-side. No color, lighting or crop work; Canva does that after delivery.

## Flow

### 0. Preflight
- `GET /api/health` → `geminiKeyConfigured: true`.
- List the folder. A file with "floor plan" in its name is reference only, never a room. File names tell the room type (`bath`, `bed1`, `kitchen+living2`). If a name is ambiguous, look at the photo; if still unclear, ask.
- Room types: `Bedroom`, `Living Room`, `Kitchen`, `Bathroom`, `Patio`, `Other`. Open-plan kitchen + living photos are `Kitchen`.

### 1. Read the floor plan and map it into each photo
Without a plan, infer a layout and label it `INFERRED`.
- Read the plan room by room: entry, windows, doors, and every piece of furniture Arthur drew, by wall and relative to the windows and doors.
- Open each original photo and work out the camera direction from the fixed features (windows, doorways, appliances). Then state which photo wall is which plan wall.
- Translate the plan into frame terms: left wall, right wall, back wall, foreground, near the window, in front of the hallway mouth.
- Give each room a confidence. Wide-angle kitchens are usually the least certain.
- Group photos of the same space taken from different angles. Pick the anchor: the widest view, or the one that defines the most furniture, usually the living or kitchen view. The others are dependents.

**Stop 1: mapping check.** Show one short table: room, camera direction, placement plan in frame terms, confidence. Highlight anything under 65%. Keep it skimmable. Wait for Taha.

### 2. Session and uploads
- `POST /api/sessions` `{"id": "<uuid>", "name": "<set>", "status": "in_progress"}`.
- For each room: `POST /api/rooms` multipart with `id`, `sessionId`, `roomType` and `file`. The server names the files `<Type> N`.

### 3. Anchors and single-angle rooms: prompt, read back, render
- `POST /api/rooms/:id/prompt` `{"userComments": "<placement in frame terms>"}`. The prompt writer never sees the floor plan, so `userComments` must carry the layout. Keep it concrete and short.
- Read every prompt back. If it contradicts the mapping, or carries a stale line such as "no TV" that no longer applies, fix the text by hand instead of paying for a new prompt call. Then approve:
  - `PUT /api/rooms/:id/prompt` `{"prompt": "...", "approve": true}` (never PATCH `generatedPrompt`/`initialPrompt` directly)
- Render all rooms in parallel: `POST /api/rooms/:id/render` `{"candidates": N}`.
  - N = 1 for simple rooms, 2 for anchors and re-renders.
- QA every render by opening the JPEG under `server/uploads/<set>/staged/`. Flag doorways that disappeared, a widened camera, changed counters or fixtures, wrong sink or cabinet counts, and reflections that don't match.
  - Findings are flags for Taha, never automatic fixes.

**Stop 2: anchor review.** Per room: version numbers, one line on what's right or wrong, and your pick. Taha picks the final ones. Record each pick's version id; you don't need to restore it (later calls target versions directly).

### 4. Dependent angles
- Only start once the anchor is final, including small decor edits. In 504-102, Kitchen 2 cost 12 renders because Kitchen 1 kept changing under it.
- Link it with `PATCH /api/rooms/:dependentId` `{"referenceRoomId": "<anchorId>"}`.
- Always pass `referenceVersionId` = Taha's picked anchor version on both `/prompt` and `/render`. Without it the server uses whatever the anchor card currently shows, which Taha may have changed by browsing versions.
- `POST /prompt` with `userComments` that do two things:
  - give the plan-based placement for this angle;
  - explicitly exclude anchor items that can't be seen from here, e.g. "no TV: that wall is behind the camera". "Same exact furniture" will copy anything you don't exclude.
- Read the prompt back, approve it, and render with `{"candidates": 3}`. Then QA the renders as in step 3.

**Stop 3: dependent review.** Same format as Stop 2.

### 5. Revisions (Taha's notes, or Arthur's round)

| Change | Do |
|---|---|
| Furniture position, layout, or which wall | **Fresh render from the original.** Write the prompt by hand and send it as `POST /render` `{"prompt": "...", "candidates": 2}` (one-off; doesn't change the room's saved prompt). Use `PUT /prompt` instead if it should become the room's prompt. Gemini moves furniture badly through edits. |
| Small addition or swap (TV, art, dining set, counter decor, throw color) | **Edit.** `POST /api/rooms/:id/edit` `{"instructions": "<numbered, literal changes anchored to frame positions>"}`. Up to about 4 changes per call. Every edit pass degrades color a little, so don't chain more than 2 to 3 edits on one image. Re-render instead. |
| Make one angle's decor match the other angle | Edit one angle, then edit the other angle using the first as a reference image. Until plan item 1.2 lands there is no reference on edits, so describe the item precisely, or re-render the dependent from the updated anchor. |
| Edit an older version | `POST /edit` with `"baseVersionId": "<id>"`. No restore needed. |
| Recurring correction across rooms | Tell Taha it belongs in the system prompt (`shared/constants.js`). Don't hand-patch every room. |

### 6. Finalize
- For each room, restore the picked version (`POST /api/rooms/:id/versions/:versionId/restore`) and then `POST /api/rooms/:id/output`. Output copies the current version, so this is the one place a restore is still needed.
- Report `GET /api/sessions/:id/usage`, versions per room, and calls per room.
- List every place where Taha's pick differed from yours, and why if you know. That list is how this skill improves.
- Tell Taha that ZIPs are available from the session header: "Download Staged ZIP" and "Download Compressed ZIP".
- Remind him: Canva color pass last, once, on finals only.

## Worked example: 504-102

- **Photos and types:** `bath`, `bed1`, `bed2`, `kitchen+living1`, `kitchen+living2`, plus a floor plan. They became Bathroom 1, Bedroom 1, Bedroom 2, Kitchen 1 and Kitchen 2.
- **Same-room group:** Kitchen 1 (anchor, camera looking SW) and Kitchen 2 (dependent, camera looking east down the hall).
- **First pass without the plan:** Bathroom 1 and Bedroom 1 were accepted. The Bedroom 2 bed was on the wrong wall. The kitchens didn't follow Arthur's layout.
- **Second pass with the plan mapping:**
  - Bedroom 2: the headboard moved to the east wall, which is the left wall in the photo, with nightstands on both sides.
  - Kitchen 1: L-sectional with the chaise at the window wall, rug and coffee table on the far side from the kitchen, round dining table mostly out of frame.
- **Cost:** $5.23 over 47 calls and 34 versions. Kitchen 1 took 11 versions and Kitchen 2 took 13. Most of that waste came from rendering Kitchen 2 against a Kitchen 1 that wasn't final yet, plus counter-decor edits made after the dependent had already been rendered.
- **Rule changes from Taha's review:** white drapes only, and the bed throw in an accent color different from the duvet. Both are now in the system prompt.

## Known gaps (update this list as plan items land)
- 1.2: no reference image on edits.
- 1.4: candidates exist on the API, but the UI has no picker. Taha moves between candidates with the version arrows.
- No floor-plan input to the server's prompt writer. The plan reaches it only through `userComments`.
