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
  - For any room, after 2 rejected rounds, post a diagnosis stop (see step 5) before rendering again.
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
  - Arthur's raw files have random AI names ("bright minimal entryway with window") that mean nothing. For those, you do the identification work: room type, camera direction and same-space grouping, from the photo's fixed features and the floor plan. Propose it at Stop 1 so Taha corrects instead of researching. Never ask Taha to rename files first.
  - If a photo seems to contradict a name Taha gave, say so as a question at Stop 1, but map it as named.
- Room types: `Bedroom`, `Living Room`, `Kitchen`, `Bathroom`, `Patio`, `Other`. A close-up of the living area is `Living Room`. Name an open-plan photo by the zone that is its main subject: a wide shot whose subject is the living area is `Living Room` even with the kitchen in the background, and one whose subject is the kitchen is `Kitchen`. The type sets the delivered file name, so confirm each name at Stop 1. EEZ-B1's open-plan living shot was typed `Kitchen` and shipped as "Kitchen 3.jpg".

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
  - **The living-room hero piece is the style kit's L-sectional**, even when the brief asks for a spacious feel or a "sofa on legs". To Arthur, a sectional is what makes the space feel bigger. If Taha's command explicitly asks for a plain sofa, confirm it at Stop 1 as a Need-from-you line before rendering. In EEZ-B1 the agent rendered the brief's sofa, Taha swapped it for a sectional at Stop 2, and the anchor and its dining edit had to be redone.
- **Same floor plan as an earlier set** (Taha says so, or the plans match):
  - Map each earlier room to this set's room **by camera angle**, not by card name. Card numbers can be reversed between sets (504-202's Kitchen 1 is 504-102's Kitchen 1 angle only by luck of upload order).
  - Open the earlier room's output image (`server/uploads/<earlier set>/output/`) and its `generatedPrompt`.
  - Start this room's prompt from the earlier prompt's layout sentences **verbatim**. Vary only colours and small decor. Keep items the earlier prompt placed (a TV at the frame edge, art) unless this photo can't show them.
  - If you think the layout differs, ask at Stop 1 as a Need-from-you line. If Taha says it's the same, use the earlier layout.
  - Why: in 504-202, 504-102's Kitchen 2 prompt for the identical camera ("sofa on the right side of the room, back facing the kitchen counters… rug in the open area to the left of the sofa") was in context from the start. The agent wrote its own layout instead, and Kitchen 2 took 22 versions; the 504-102 wording fixed the sofa angle on its first use.

**Stop 1: mapping check.** Use the review-stop format below. The table is a proposal for Taha to correct, not a question for him to research: you do the work of naming each room and where its camera faces. Show one table with these columns:
- file;
- identified as (room type, and anchor, dependent or single);
- camera direction (compass and which plan wall is the back wall), from the floor plan and fixed features (windows, doors, appliances);
- placement plan in frame terms, with each seating group's facing direction in room terms (see step 3);
- confidence (mark anything under 65%).

Rules:
- Where Taha labeled the files or named rooms in his command, those labels win; just confirm them.
- Any room type, camera direction or placement under 65% gets its own Need-from-you line with your proposal ("Kitchen 2 sofa: right side, back to the counters, front facing the left wall. OK?"). Never put a low-confidence layout only under "Also check for". 504-202's Kitchen 2 sofa sat at 55% there, and round 1 rendered it wrong.
- For a same-plan set, show which earlier room maps to which room, by camera angle.
- **Camera position.** For every dependent or wide shot, give one Need-from-you line naming where the camera stands in plan terms and what that puts in frame ("living2 camera: at the front door, so the sectional's chaise, rug and coffee table show at the right. OK?"). Base it on the plan and the photo's fixed features, not on where furniture would be convenient to hide.
  - Never place the main seating group behind the camera to save matching work. Taha wants the living seating visible in open-plan shots.
  - In EEZ-B1 the agent put the `living2` camera behind the sofa, so round 1 had no seating group. Taha pointed out that the camera was at the front door, and the seating group should show at the right edge. It cost a full round.

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
- **Layout language.** Give each piece's position in frame terms, but its **facing direction in room terms**: name the wall or fixture it faces or backs onto ("sofa back to the kitchen counters, front facing the wall just outside the left edge"). Never use "camera side", "toward the camera" or "foreground side" for which way furniture faces, and never "rotate". In 504-202, "rug on the camera side of the sofa" turned the whole group toward the lens in every render until it was replaced.
- Read every prompt back against two things, and fix the text by hand instead of paying for a new prompt call:
  - **The mapping.** It must not contradict the plan or carry a stale line such as "no TV" that no longer applies.
  - **The system prompt rules** in `shared/constants.js`. Watch for:
    - towels on hooks beside art (504-201's bath prompt asked for exactly that);
    - a bare wall left without art or shelves. Never replace the designer's art or shelves with "leave the wall bare" unless the wall has no room for them. In 504-202 the agent did that on Kitchen 2's left wall, and Taha asked for art there at the end (one extra edit and round);
    - kitchen styling dropped;
    - stools on the cabinet side.
- Then approve: `PUT /api/rooms/:id/prompt` `{"prompt": "...", "approve": true}` (never PATCH `generatedPrompt`/`initialPrompt` directly).
- Render all rooms in parallel in one turn: `POST /api/rooms/:id/render` `{"candidates": N}`.
  - N = 1 for simple rooms, 2 for anchors and re-renders.
  - Versions are numbered in candidate order, and v(first) is left current. The response lists every new version. Taha can also pick from the candidate strip on the card.
- QA every render by opening the JPEG under `server/uploads/<set>/staged/` next to the original. Findings are flags for Taha, never automatic fixes.

#### QA: Blocking (never recommend accepting a render with one of these)
- **Layout.** The layout contradicts the mapping or the anchor: a piece on the wrong wall, crammed into a corner, an empty centre floor where the plan has furniture.
- **Orientation.** A sofa, rug or seating group visibly angled toward the lens instead of squared to its wall. Arthur notices this, so it is never FYI. Taha rejected 504-202 Kitchen 2 v5, v13 and v15 for it.
- **Framing.** A door, cabinet or appliance at a frame edge has dropped out, or less floor and depth are visible than in the original (zoomed or compressed). Taha rejected four kitchen picks in 504-201 for this.
- **Architecture counts.** Cabinet doors and drawers on every face (peninsula and island faces especially), window widths, door count, sink count.
- **Changed fixtures.** Counters, appliances or fixtures that differ from the original; a doorway that disappeared. Small hardware (a wall hook, a towel ring) is FYI.
- **Neighbour space.** Anything staged past a divider railing or in a space outside the unit.
- **Rule breaks.** A clear break of a system-prompt rule: towel on a hook beside art, toilet lid open, a large bare wall, stools on the cabinet side or in front of the dishwasher.

#### QA: FYI (one line at most, no edit offer)
- Subtle decor drift between angles: art frame, rug tone, pot colour, small styling. Taha judges angles side by side, and "nearly identical" is the bar.
- Stool count. Two or three is fine, as long as both angles of the same room match.
- Small ceiling items: an extra light, a missing smoke detector.
- Small missing hardware: a wall hook, a towel ring. Taha accepted 504-202's bath without its hook.

#### Picking between candidates
After the Blocking list, prefer, in this order:
1. Sofa, rug and coffee table squared to their wall, not to the lens.
2. On a dependent, the visible dining chairs match the anchor's count (all four showing beats one hidden behind the table).
3. Furniture identity with the anchor (see step 4).
4. Framing closest to the original.

Taha chose 504-202 Kitchen 2 v20 over the agent's v21 for its four visible chairs and its sofa and rug tilt.

**Stop 2: anchor review.** Use the review-stop format.
- Per room: versions, one line on what's right, Blocking flags, FYI flags, and your pick. Taha picks the final ones.
- Record each pick's version id; you don't need to restore it (later calls target versions directly).
- Ask Taha to lock the anchor first. As soon as he does, start the dependent (step 4) in the same turn as the revisions on the other rooms.
- **Same-room pairs without a planned anchor** (two bedroom angles, for example): the angle Taha accepts first becomes the anchor, and the other becomes the dependent. State the assignment at the stop ("Bedroom 3 is accepted, so it is the anchor; Bedroom 2 will be matched to it"). Don't re-render the accepted angle or flip the roles unless Taha asks.

### 4. Dependent angles
- Only start once the anchor is final, including small decor edits. In 504-102, Kitchen 2 cost 12 renders because Kitchen 1 kept changing under it.
- Link it with `PATCH /api/rooms/:dependentId` `{"referenceRoomId": "<anchorId>"}` **before its first prompt or render**. The link stays for the record; never PATCH it to null and back. 504-202's Kitchen 2 rendered round 1 unlinked, so `referenceMode` was ignored and nothing recorded which mode ran.
- **Default: text-only** (except open-plan dependents; see below).
  - Send `"referenceMode": "text"` on both `/prompt` and `/render`. The render then uses only the dependent's own photo, which keeps its lens.
  - In 504-201, all 8 kitchen renders made with the anchor as a reference image came out tighter than the original. 3 of 6 text-only renders held the lens.
- **Open-plan dependents with large anchor pieces** (a sectional, a dining set): run round 1 as `"referenceMode": ["text", "reference", "reference"]` with `"referenceVersionId": "<picked anchor version>"`. Text mode keeps the lens; reference mode is the only one that has copied exact furniture (504-202 Kitchen 2 v20, v21; Bedroom 3 v3).
- Every round that includes reference mode uses **3 candidates**. Reference mode broke the camera in 6 of 14 Kitchen 2 candidates, and in 2 of 7 two-candidate rounds both failed.
- **A layout failure is not a mode failure.** If the camera held but the furniture is in the wrong place, fix the layout text and keep the mode. 504-202's round 1 was text-only, held the camera in all three candidates, and failed only because the prompt put the sofa in the corner.
- The prompt comes from `POST /prompt` `{"referenceMode": "text", "userComments": "..."}`, so the designer prompt still adds the room-type staging (kitchen counter styling, runner, towel, stools). Hand-written dependent prompts in 504-201 dropped all of it. Use the same prompt for the reference candidates. `userComments` must have three blocks, so a later round can change one block at a time:
  1. **Layout:** the style kit's layout sentences for this camera angle, or the Stop 1 placement, in room terms (step 3).
  2. **Anchor pieces, from pixels.** Open Taha's picked anchor version and describe each visible piece from the image, never from the anchor's prompt or an earlier description. Give colour with a comparison ("muted sage grey-green, lighter and greyer than forest green"), piping, arm style, table base ("chunky base of two crossed wooden slabs, not a slim X frame"), chair back ("tall egg-shaped back"), leg colour, legs or no legs, which side of the TV the plant stands. In reference mode, text that contradicts image 1 overrides it: 504-202 Kitchen 2 v4 to v17 copied "forest green, white piping, X-base" from the text, not the sage sofa in image 1. Literal descriptions matched on the first try.
  3. **Protections:** the step 3 frame edges and architecture counts. For an oblique camera, name the landmarks at both frame edges ("hallway, electrical panel, pantry door, and the door and switch at the left edge stay exactly where they are").
  Also match the anchor's stool count if stools show in both angles, and leave out anchor items that can't be seen from this angle.
- Read the prompt back as in step 3, approve it, and render `{"candidates": 3}` (or the mixed modes above).
- QA as in step 3.
  - Small drift from the anchor (an art frame, a rug tone) is fine: FYI only.
  - Noticeable mismatches (a pot on the wrong side of the TV, legs on a coffee table that has none) get fixed with **one** edit after Taha picks, all items in one call.
- If text-only fails twice on furniture match, propose reference mode for one candidate: `"referenceMode": ["text", "text", "reference"]` with `"referenceVersionId": "<picked anchor version>"`. Without `referenceVersionId` the server uses whatever the anchor card currently shows.
- Each version's `promptSnapshot` records `referenceMode`, `referenceRoomId` and `referenceVersionId`. Use them to report which mode produced which version.

**Stop 3: dependent review.** Same format as Stop 2.

### 5. Revisions (Taha's notes, or Arthur's round)

**Moves: decline through edits.** Edits don't move furniture: 504-201 v11 (two moves) and 504-202 Kitchen 2 v9 left every piece where it was. When Taha asks for an edit that shifts something, say so in one line and offer a fresh render; split the request so additions, removals and swaps still go in one edit.

**Swaps: run them.** Replacing an item through an edit is generally fine. If a swap of a large piece fails once, don't retry the edit: go to a fresh render with a pixel-level description of the piece (step 4). In 504-202, two sofa, table and chair swaps with the anchor as reference (v18, v19) didn't take, and the next fresh render matched all three.

At every stop, say what each edit used: "edit of v17, reference: Kitchen 1 v5". Taha asked at 504-202 whether v18 had used a reference; it had.

**Diagnosis stop.** After 2 rejected rounds on any room, post a stop before rendering again, in three lines:
1. What changed between the rounds, and what came back.
2. What that shows: layout text, furniture description, mode, or a model roll.
3. The **one** variable group you'll change next: layout, anchor pieces, protections, or mode.

Before writing it, compare this room's prompt with the style kit's working prompt for the same angle, if there is one. Change one block per round: 504-202's round 3 changed five things at once, and the cause couldn't be isolated. Don't discourage a re-render that changes a different variable. In 504-202 the agent asked Taha to stop re-rendering after round 4, and the next three rounds kept the camera in 5 of 6 candidates.

| Change | Do |
|---|---|
| Furniture position, layout, or which wall | **Fresh render from the original.** Write the prompt by hand and send it as `POST /render` `{"prompt": "...", "candidates": 2}` (one-off; doesn't change the room's saved prompt). Use `PUT /prompt` instead if it should become the room's prompt. On a dependent, keep its step 4 mode (text, or the text and reference mix with 3 candidates). |
| Addition, removal or swap (TV, art, dining set, counter decor, throw colour) | **Edit.** `POST /api/rooms/:id/edit` `{"instructions": "<numbered, literal changes anchored to frame positions>"}`. Up to about 4 changes per call. Every edit pass degrades colour a little, so don't chain more than 2 to 3 edits on one image. Re-render instead. If a large-piece swap fails once, re-render with a pixel-level description. |
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
- Cross-angle lighting match (the dependent's light and shadows against the anchor's) happens in that Canva pass, not through re-renders: separate render calls always differ in lighting. Budget time for it in the report. 504-202's Kitchen 2 took 10 minutes and 4 uploads.

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

## Worked example: 504-202

- **Photos:** `bath`, `bed1-east`, `bed2-north-facing-closet`, `bed2-north-facing-patio`, `east-patio`, `kitchen-living1-from-entry-facing-fridge`, `kitchen-living2-from-north-east-looking-south-west`, plus a floor plan. Same plan as 504-102.
- **Result:** 84 minutes, USD 6.27, 50 calls (0 failed), 46 versions. Six of seven rooms were final by minute 40. Bath and Bedroom 1 were accepted on v1.
- **Kitchen 2 (the dependent):** 22 AI versions, USD 3.19, 34 minutes of rounds plus 10 of Canva. The causes, in order:
  - The agent wrote its own layout instead of 504-102's prompt for the same camera.
  - Its layout said "rug on the camera side", which turned the group toward the lens.
  - Its furniture text didn't match the anchor's pixels.
  - Reference mode broke the camera in 6 of 14 candidates.
  - It used edits for a move and for two large swaps.
- **Bedroom 2 pair:** Taha accepted the closet angle first, then re-anchored on the entry-door angle's v5 and had the closet angle redone. Text mode fixed the entry-door angle after two reference renders cropped its doorway.
- **Taha's corrections, now rules:**
  - room-relative layout wording;
  - furniture described from the anchor's pixels;
  - sofa and rug orientation is Blocking;
  - a dining-chair count that matches the anchor;
  - don't strip designer art;
  - the first accepted angle is the anchor.

## Worked example: EEZ-B1

- **Photos:** `bath` (portrait 1024×1536), `bedroom-master`, `bedroom2`, `kitchen-main`, `kitchen-with-laundry`, `living1` (toward the front door), `living2` (open plan, toward the kitchen), plus a 2D plan and a 3D render. A new floor plan.
- **Result:** 62 minutes of Taha's time, USD 3.81, 32 calls (0 failed). Both bedrooms, the bath and `kitchen-main` were accepted on v1.
- **Bedroom labels:** Taha's file names had the bedrooms swapped. The master is the only room with the angled entry door, which settled it; window counts did not, since both rooms have two.
- **Portrait bath:** the 16:9 render recomposed cleanly into landscape and was accepted on v1.
- **Lost rounds:**
  - the brief's sofa was replaced by a sectional at Stop 2;
  - the `living2` camera was placed behind the sofa;
  - three tries failed to rotate the kitchen runner (two edits, one fresh render), and Taha accepted it unrotated.
- **Taha's picks over the agent's:** colour and lighting truth over a little lost floor (`kitchen-main` v1); cabinet scale over a fuller ceiling (`kitchen-with-laundry` v1, then v7). He cropped an invented edge door out of `living2` v6 in Canva and uploaded it as v7.
- **Rules added:** sectional by default; camera position as a Stop 1 Need-from-you line.

## Known gaps (update this list as plan items land)
- No floor-plan input to the server's prompt writer. The plan reaches it only through `userComments`.
