---
name: stage-set
description: Stage a floor-plan set of raw apartment photos end to end through the WH Staging app's HTTP API (session, uploads, floor-plan mapping, prompts, renders, Taha's review stops, revisions, output). Use when Taha says "stage <set>", "/stage-set <folder>", points at a folder of raw room photos (usually ~/Downloads/<set>), or asks an agent to run or revise a staging set.
---

# stage-set

Drive the staging app over its API so Taha only reviews and picks. The app is local: API `http://localhost:3001/api`, UI `http://localhost:3002`. Read `CLAUDE.md` for the route list. This skill must change in the same commit as any route it uses.

Target: under 60 minutes of Taha's time per set, and time spent waiting on you counts. Every review round costs him 4 to 7 minutes, so the lever is fewer rounds:
- Run independent calls in parallel.
- Put every change for a room into one call.
- Never offer a re-roll that you'd expect to fail the same way.

Note for editors of this file: never write a dollar sign followed by a digit here. Skill arguments are substituted into that pattern when the skill loads. Write amounts as "USD 8".

## Hard rules

- Never edit app code, commit, or kill/restart node or vite processes. If the API is down, stop and tell Taha.
- Never delete sessions, rooms or versions. Never send `initialPrompt` in a PATCH; it is the measurement baseline for prompt edits.
- Never re-roll a room Taha has accepted, not even to test a new rule.
- Guard rails:
  - Report spend at every stop.
  - Say so when the set passes USD 5. Stop and ask before going past USD 8. Read spend from `GET /api/sessions/:id/usage`.
  - At most 8 image calls (render candidates plus edits) per room before you stop to ask.
  - For a dependent angle, stop after 2 rejected rounds and propose a different method (see step 4), not another roll of the same one.
- Retry a failed call once. If it fails again, stop and report the error text.
- 16:9 and 2K are fixed server-side. No color, lighting or crop work; Canva does that after delivery.

## Flow

### 0. Preflight
- `GET /api/health` → `geminiKeyConfigured: true`.
- Find the folder: try `~/Downloads/<set>*` (for example `504-201 raw`) before asking.
- A file with "floor plan" in its name is reference only, never a room.
- Room identity:
  - **Taha's command text wins** over what a photo seems to show.
  - File names Taha renamed (`bath`, `bed1`, `living`, `kitchen+living2`) are authoritative.
  - Arthur's raw files have random AI names ("bright minimal entryway with window") that mean nothing. For those, identify each room type by looking at the photo, group the photos of the same space, and show the result at Stop 1. Never ask Taha to rename files first.
  - If a photo seems to contradict a name Taha gave, say so as a question at Stop 1, but map it as named.
- Room types: `Bedroom`, `Living Room`, `Kitchen`, `Bathroom`, `Patio`, `Other`. A close-up of the living area is `Living Room`. A wide open-plan shot that shows the kitchen is `Kitchen`.

### 1. Read the floor plan and map it into each photo
Without a plan, infer a layout and label it `INFERRED`.
- Read the plan room by room: entry, windows, doors, and every piece of furniture Arthur drew, by wall and relative to the windows and doors.
- Open each original photo and work out the camera direction from the fixed features (windows, doorways, appliances). Then state which photo wall is which plan wall.
- Translate the plan into frame terms: left wall, right wall, back wall, foreground, near the window, in front of the hallway mouth.
- Give each room a confidence. Wide-angle kitchens are usually the least certain.
- Group photos of the same space taken from different angles.
  - **The anchor is the close-up, single-room shot** (usually the living-room view). It is easier to put well-rendered furniture into the background of a wide shot than to render background furniture well in a close-up.
  - The wide shot that shows that room in the background is the dependent, and it must show the same furniture as the anchor.
- **Style kit.** List the sessions (`GET /api/sessions`) and find earlier sets from the same building (same name prefix, e.g. `504-`). Read their rooms (`GET /api/sessions/:id/rooms`) and pull the approved dining set, sectional and counter-stool descriptions from `generatedPrompt`. Use them as the default for this set; small variations are fine.

**Stop 1: mapping check.** Use the review-stop format below. Show one table with these columns:
- file;
- identified as (type, and anchor or dependent);
- camera direction;
- placement plan in frame terms;
- confidence (mark anything under 65%).

Add the style-kit picks in one line. Wait for Taha.

### 2. Session and uploads
- `POST /api/sessions` `{"id": "<uuid>", "name": "<set>", "status": "in_progress"}`.
- For each room: `POST /api/rooms` multipart with `id`, `sessionId`, `roomType` and `file`. The server names the files `<Type> N`.

### 3. Anchors and single-angle rooms: prompt, read back, render
- `POST /api/rooms/:id/prompt` `{"userComments": "<placement in frame terms>"}`. The prompt writer never sees the floor plan, so `userComments` must carry the layout. Keep it concrete and short:
  - Name the frame-edge features that must stay visible, e.g. "the white door at the far-left edge stays visible; the stove, microwave and base cabinets right of the stove stay fully in frame".
  - State architecture counts from the original, e.g. "peninsula face: one drawer over a two-door cabinet beside the dishwasher".
  - Don't rely on counts for decor. The model ignores "exactly two stools".
  - Patios: if a divider railing separates a neighbour's patio, say "stage only the near side of the divider".
- Read every prompt back against two things, and fix the text by hand instead of paying for a new prompt call:
  - **The mapping.** It must not contradict the plan or carry a stale line such as "no TV" that no longer applies.
  - **The system prompt rules** in `shared/constants.js`. Watch for:
    - towels on hooks beside art (504-201's bath prompt asked for exactly that);
    - a bare wall left without art or shelves;
    - kitchen styling dropped;
    - stools on the cabinet side.
- Then approve: `PUT /api/rooms/:id/prompt` `{"prompt": "...", "approve": true}` (never PATCH `generatedPrompt`/`initialPrompt` directly).
- Render all rooms in parallel in one turn: `POST /api/rooms/:id/render` `{"candidates": N}`.
  - N = 1 for simple rooms, 2 for anchors and re-renders.
  - Versions are numbered in candidate order, and v(first) is left current. The response lists every new version. Taha can also pick from the candidate strip on the card.
- QA every render by opening the JPEG under `server/uploads/<set>/staged/` next to the original. Findings are flags for Taha, never automatic fixes.

#### QA: Blocking (never recommend accepting a render with one of these)
- **Framing.** A door, cabinet or appliance at a frame edge has dropped out, or less floor and depth are visible than in the original (zoomed or compressed). Taha rejected four kitchen picks in 504-201 for this.
- **Architecture counts.** Cabinet doors and drawers on every face (peninsula and island faces especially), window widths, door count, sink count.
- **Changed fixtures.** Counters, appliances or fixtures that differ from the original; a doorway that disappeared.
- **Neighbour space.** Anything staged past a divider railing or in a space outside the unit.
- **Rule breaks.** A clear break of a system-prompt rule: towel on a hook beside art, toilet lid open, a large bare wall, stools on the cabinet side or in front of the dishwasher.

#### QA: FYI (one line at most, no edit offer)
- Subtle decor drift between angles: art frame, rug tone, pot colour, small styling. Taha judges angles side by side, and "nearly identical" is the bar.
- Stool count. Two or three is fine, as long as both angles of the same room match.
- Small ceiling items: an extra light, a missing smoke detector.

**Stop 2: anchor review.** Use the review-stop format.
- Per room: versions, one line on what's right, Blocking flags, FYI flags, and your pick. Taha picks the final ones.
- Record each pick's version id; you don't need to restore it (later calls target versions directly).
- Ask Taha to lock the anchor first. As soon as he does, start the dependent (step 4) in the same turn as the revisions on the other rooms.

### 4. Dependent angles
- Only start once the anchor is final, including small decor edits. In 504-102, Kitchen 2 cost 12 renders because Kitchen 1 kept changing under it.
- Link it with `PATCH /api/rooms/:dependentId` `{"referenceRoomId": "<anchorId>"}`. The link stays for the record; never PATCH it to null and back.
- **Default: text-only.**
  - Send `"referenceMode": "text"` on both `/prompt` and `/render`. The render then uses only the dependent's own photo, which keeps its lens.
  - In 504-201, all 8 kitchen renders made with the anchor as a reference image came out tighter than the original. 3 of 6 text-only renders held the lens.
- The prompt comes from `POST /prompt` `{"referenceMode": "text", "userComments": "..."}`, so the designer prompt still adds the room-type staging (kitchen counter styling, runner, towel, stools). Hand-written dependent prompts in 504-201 dropped all of it. `userComments` must:
  - Describe each visible anchor piece from Taha's picked anchor version by shape, material, colour and frame position. Include the details that make it read as the same piece: legs or no legs, table height, which side of the TV the plant stands, the art frame.
  - Match the anchor's stool count, if stools show in both angles.
  - Give the step 3 protections: frame edges and architecture counts.
  - Leave out anchor items that can't be seen from this angle.
- Read the prompt back as in step 3, approve it, and render `{"candidates": 3}`.
- QA as in step 3.
  - Small drift from the anchor (an art frame, a rug tone) is fine: FYI only.
  - Noticeable mismatches (a pot on the wrong side of the TV, legs on a coffee table that has none) get fixed with **one** edit after Taha picks, all items in one call.
- If text-only fails twice on furniture match, propose reference mode for one candidate: `"referenceMode": ["text", "text", "reference"]` with `"referenceVersionId": "<picked anchor version>"`. Without `referenceVersionId` the server uses whatever the anchor card currently shows.

**Stop 3: dependent review.** Same format as Stop 2.

### 5. Revisions (Taha's notes, or Arthur's round)

Edits never move furniture. In 504-201, a single edit with two moves left both pieces where they were. When Taha says "edit" but a change moves something, split it: additions, removals and swaps go in one edit; anything that changes position goes in a fresh render. Tell him in one line.

| Change | Do |
|---|---|
| Furniture position, layout, or which wall | **Fresh render from the original.** Write the prompt by hand and send it as `POST /render` `{"prompt": "...", "candidates": 2}` (one-off; doesn't change the room's saved prompt). Use `PUT /prompt` instead if it should become the room's prompt. On a dependent, add `"referenceMode": "text"`. |
| Small addition, removal or swap (TV, art, dining set, counter decor, throw colour) | **Edit.** `POST /api/rooms/:id/edit` `{"instructions": "<numbered, literal changes anchored to frame positions>"}`. Up to about 4 changes per call. Every edit pass degrades colour a little, so don't chain more than 2 to 3 edits on one image. Re-render instead. |
| Make one angle's decor match the other angle | Only when the mismatch is noticeable (see FYI). Edit one angle, then edit the other with the first as reference: `POST /edit` `{"instructions": "...match the <item> in the reference image...", "referenceRoomId": "<other angle>", "referenceVersionId": "<its new version>"}`. Works in either direction. The instructions must name what to match. |
| Take an item from another version of the same room (the chair from v2 into v1) | `POST /edit` `{"instructions": "...use the <item> from the reference image...", "referenceRoomId": "<this room>", "referenceVersionId": "<the version that has it>", "baseVersionId": "<the version to edit>"}`. The reference must differ from the version being edited. |
| Flash test (plan item 3.3) | Add `"fast": true` to a small `POST /edit` only when Taha asks. It uses the Flash image model: faster and cheaper, quality unproven. Say in the review that the edit was a fast one. |
| Use a specific real piece (client sent a product photo) | `POST /edit` with `"referenceImage": "data:image/jpeg;base64,..."` and `"referenceLabel": "<file name>"`. |
| Edit an older version | `POST /edit` with `"baseVersionId": "<id>"`. No restore needed. |
| Recurring correction across rooms | Tell Taha it belongs in the system prompt (`shared/constants.js`). Don't hand-patch every room. |

### 6. Finalize
- For each room, restore the picked version (`POST /api/rooms/:id/versions/:versionId/restore`) and then `POST /api/rooms/:id/output`. Output copies the current version, so this is the one place a restore is still needed.
- **After any edit Taha approves once the set is final, run restore and output for that room yourself.** Don't leave the output folder holding the old version.
- Final QA uses the Blocking list only. Don't propose edits for FYI items.
- Report:
  - `GET /api/sessions/:id/usage`: spend, calls, and `promptsEdited` of `promptsApproved`;
  - versions per room and calls per room.
- List every place where Taha's pick differed from yours, and why if you know. That list is how this skill improves.
- Tell Taha that ZIPs are available from the session header: "Download Staged ZIP" and "Download Compressed ZIP".
- Remind him: Canva color pass last, once, on finals only.

## Review-stop format

Use this at every stop:

```
Need from you:
- <one line per decision, with options A/B/C where it helps>

Spend: $X.XX of USD 8 (N calls)

<table per room: versions | what's right | Blocking | FYI | my pick>

Also check for: neighbour areas, dividers, and anything I called clean.
```

- Put the decisions first. Taha answers lettered options in 2 to 3 minutes and open tables in 6 to 7.
- Recommend "accept" only when a room's Blocking list is empty.
- Skip version ids unless he asks.

## Worked example: 504-102

- **Photos and types:** `bath`, `bed1`, `bed2`, `kitchen+living1`, `kitchen+living2`, plus a floor plan. They became Bathroom 1, Bedroom 1, Bedroom 2, Kitchen 1 and Kitchen 2.
- **Same-room group:** Kitchen 1 (anchor, camera looking SW) and Kitchen 2 (dependent, camera looking east down the hall).
- **First pass without the plan:** Bathroom 1 and Bedroom 1 were accepted. The Bedroom 2 bed was on the wrong wall. The kitchens didn't follow Arthur's layout.
- **Second pass with the plan mapping:**
  - Bedroom 2: the headboard moved to the east wall, which is the left wall in the photo, with nightstands on both sides.
  - Kitchen 1: L-sectional with the chaise at the window wall, rug and coffee table on the far side from the kitchen, round dining table mostly out of frame.
- **Cost:** USD 5.23 over 47 calls and 34 versions. Kitchen 1 took 11 versions and Kitchen 2 took 13. Most of that waste came from rendering Kitchen 2 against a Kitchen 1 that wasn't final yet, plus counter-decor edits made after the dependent had already been rendered.
- **Rule changes from Taha's review:** white drapes only, and the bed throw in an accent color different from the duvet. Both are now in the system prompt.

## Worked example: 504-201

- **Photos:** `bath`, `bed`, `kitchen`, `living`, `patio1-east`, `patio2-west`, plus a floor plan.
- **Anchor:** the agent first called `living.png` a bedroom and made the wide kitchen the anchor. Taha corrected both. Living Room 1, the close-up, became the anchor, and Kitchen 1 (wide) the dependent.
- **Result:** 86 minutes, USD 4.18, 47 calls (13 failed with Gemini 503s), 30 versions.
  - The kitchen alone took 34 minutes and 16 versions.
  - Eight reference-mode renders all came out zoomed in. Text-only renders fixed the lens.
  - The rest of the kitchen loop was the halved peninsula cabinet, the missing kitchen styling, and a furniture-move edit that did nothing.
- **Taha's corrections, now rules:**
  - toilet lid closed;
  - no towel on the hook beside art;
  - stage only the near side of a patio divider;
  - stools on the living side of the peninsula;
  - walnut pedestal table with cream chairs;
  - don't flag subtle cross-angle decor drift.

## Known gaps (update this list as plan items land)
- No floor-plan input to the server's prompt writer. The plan reaches it only through `userComments`.
