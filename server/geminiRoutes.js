// HTTP routes for the server-side Gemini calls. Every route works as plain JSON, or as Server-Sent
// Events when the request sends `Accept: text/event-stream` (the UI uses SSE for progress; an agent
// can use JSON). A closed tab does not cancel the work: it finishes and the version is saved.
import fs from 'fs';
import path from 'path';
import { createGemini, isGeminiConfigured } from './gemini.js';
import { guessMimeType } from '../shared/gemini-core.js';

const MAX_CANDIDATES = 3;

export const registerGeminiRoutes = (app, { db, getUploadFilePath, saveGeneratedBuffer, insertApiCall }) => {
    const gemini = createGemini({
        logCall: (roomId, kind, model, usage, imageCount, error) => {
            try {
                insertApiCall({ roomId, kind, model, usage, imageCount, error });
            } catch (err) {
                console.warn('Failed to log API usage:', err);
            }
        }
    });

    const inFlight = new Map(); // roomId -> kind of the running operation

    const loadRoom = (id) => db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);

    const readImage = (storedPath) => {
        const fullPath = getUploadFilePath(storedPath);
        if (!fullPath || !fs.existsSync(fullPath)) {
            throw Object.assign(new Error('Image file not found on disk'), { status: 404 });
        }
        return { mimeType: guessMimeType(fullPath), data: fs.readFileSync(fullPath).toString('base64') };
    };

    const loadVersion = (versionId, roomId) =>
        db.prepare('SELECT * FROM image_versions WHERE id = ? AND roomId = ?').get(versionId, roomId);

    const roomBaseName = (r) => path.basename(r.filePath || '', path.extname(r.filePath || '')) || 'reference';

    // 400 unless versionId (when given) belongs to the room's reference room
    const checkReferenceVersion = (room, versionId) => {
        if (!versionId) return null;
        if (!room.referenceRoomId) return { error: 'referenceVersionId given but the room has no reference room' };
        if (!loadVersion(versionId, room.referenceRoomId)) return { error: 'referenceVersionId does not belong to the reference room' };
        return null;
    };

    // The room's staged sibling (same room, other angle): the given version, else whatever is current.
    // Labelled "<Room> vN" so the snapshot records exactly which render was Image 1.
    const resolveReference = (room, referenceVersionId) => {
        if (!room.referenceRoomId) return null;
        const ref = loadRoom(room.referenceRoomId);
        if (!ref) return null;
        if (referenceVersionId) {
            const version = loadVersion(referenceVersionId, ref.id);
            return { image: readImage(version.url), label: `${roomBaseName(ref)} v${version.versionNumber}` };
        }
        if (!ref.generatedImageUrl) return null;
        try {
            const current = ref.currentVersionId ? loadVersion(ref.currentVersionId, ref.id) : null;
            return {
                image: readImage(ref.generatedImageUrl),
                label: current ? `${roomBaseName(ref)} v${current.versionNumber}` : roomBaseName(ref)
            };
        } catch {
            return null; // stale reference falls back to the single-image flow
        }
    };

    // Shared request lifecycle: 404 / 500 (no key) / 409 (busy) before anything starts, then the work,
    // streamed as SSE when asked. execute({ send, room }) returns the JSON result.
    const runOperation = async (req, res, { kind, flag, validate, execute }) => {
        const { id } = req.params;
        const room = loadRoom(id);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        if (!isGeminiConfigured()) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server. Add it to .env.local and restart the server.' });
        }
        const invalid = validate?.(room);
        if (invalid) return res.status(invalid.status ?? 400).json({ error: invalid.error });
        if (inFlight.has(id)) {
            return res.status(409).json({ error: `Room is busy (${inFlight.get(id)} in progress)` });
        }

        const sse = (req.headers.accept || '').includes('text/event-stream');
        const send = (event, data) => {
            if (!sse || res.writableEnded || res.destroyed) return;
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        if (sse) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
            res.flushHeaders?.();
        }

        inFlight.set(id, kind);
        if (flag) db.prepare(`UPDATE rooms SET ${flag} = 1 WHERE id = ?`).run(id);
        try {
            const result = await execute({ send, room });
            if (sse) {
                send('done', result);
                res.end();
            } else {
                res.json(result);
            }
        } catch (err) {
            if (!(err?.status)) console.error(`${kind} failed:`, err);
            const status = err?.status ?? 500;
            if (sse) {
                send('error', { error: err.message, status });
                res.end();
            } else {
                res.status(status).json({ error: err.message });
            }
        } finally {
            inFlight.delete(id);
            if (flag) db.prepare(`UPDATE rooms SET ${flag} = 0 WHERE id = ?`).run(id);
        }
    };

    const progressSender = (send, candidate) => (status, interimImage) => {
        send('thought', { status, interimImage, candidate });
    };

    // Staging prompt from the room's photo (or, with a reference room, from the staged sibling + this photo)
    app.post('/api/rooms/:id/prompt', (req, res) => runOperation(req, res, {
        kind: 'prompt',
        flag: 'isGeneratingPrompt',
        validate: (room) => checkReferenceVersion(room, req.body?.referenceVersionId),
        execute: async ({ room }) => {
            const reference = resolveReference(room, req.body?.referenceVersionId);
            const raw = await gemini.generatePrompt({
                roomId: room.id,
                image: readImage(room.filePath),
                reference: reference?.image,
                roomLabel: room.roomType === 'Other' ? room.customLabel || 'Room' : room.roomType,
                userComments: req.body?.userComments
            });
            // Models sometimes wrap the whole prompt in quotes
            const prompt = (raw || 'Failed to generate prompt.').replace(/^["']|["']$/g, '').trim();
            db.prepare('UPDATE rooms SET generatedPrompt = ?, initialPrompt = ?, isPromptApproved = 0 WHERE id = ?')
                .run(prompt, prompt, room.id);
            return { generatedPrompt: prompt, initialPrompt: prompt, isPromptApproved: false };
        }
    }));

    app.post('/api/rooms/:id/refine-prompt', (req, res) => runOperation(req, res, {
        kind: 'refine',
        validate: () => (!req.body?.feedback?.trim() ? { error: 'feedback is required' } : null),
        execute: async ({ room }) => {
            const currentPrompt = (req.body.currentPrompt ?? room.generatedPrompt ?? '').trim();
            const refined = (await gemini.refinePrompt({ roomId: room.id, currentPrompt, feedback: req.body.feedback.trim() })) || 'Failed to refine prompt.';
            db.prepare('UPDATE rooms SET generatedPrompt = ? WHERE id = ?').run(refined, room.id);
            return { generatedPrompt: refined };
        }
    }));

    // Save a hand-written prompt as the room's prompt (optionally approving it). Never touches
    // initialPrompt, which is the baseline for measuring prompt edits (plan item 1.5).
    app.put('/api/rooms/:id/prompt', (req, res) => {
        try {
            const room = loadRoom(req.params.id);
            if (!room) return res.status(404).json({ error: 'Room not found' });
            const { prompt, approve } = req.body || {};
            if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'prompt must be a non-empty string' });
            const approved = approve === undefined ? Boolean(room.isPromptApproved) : Boolean(approve);
            db.prepare('UPDATE rooms SET generatedPrompt = ?, isPromptApproved = ? WHERE id = ?').run(prompt, approved ? 1 : 0, room.id);
            res.json({ generatedPrompt: prompt, isPromptApproved: approved });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    // Render from the approved prompt, or from an explicit `prompt` (which counts as the approval and is
    // not saved to the room). candidates 1..3 run in parallel; each becomes its own version.
    // referenceVersionId picks which render of the reference room is Image 1 (default: its current one).
    app.post('/api/rooms/:id/render', (req, res) => runOperation(req, res, {
        kind: 'render',
        flag: 'isGeneratingImage',
        validate: (room) => {
            const manual = req.body?.prompt;
            if (manual !== undefined && (typeof manual !== 'string' || !manual.trim())) return { error: 'prompt must be a non-empty string' };
            if (manual === undefined) {
                if (!room.generatedPrompt?.trim()) return { error: 'Room has no prompt yet' };
                if (!room.isPromptApproved) return { error: 'Prompt is not approved' };
            }
            return checkReferenceVersion(room, req.body?.referenceVersionId);
        },
        execute: async ({ send, room }) => {
            const n = Math.min(MAX_CANDIDATES, Math.max(1, parseInt(req.body?.candidates, 10) || 1));
            const manualPrompt = req.body?.prompt?.trim();
            const prompt = manualPrompt || room.generatedPrompt;
            const image = readImage(room.filePath);
            const reference = resolveReference(room, req.body?.referenceVersionId);

            const outcomes = await Promise.allSettled(Array.from({ length: n }, async (_, i) => {
                const k = i + 1;
                const buffer = await gemini.renderImage({
                    roomId: room.id,
                    image,
                    reference: reference?.image,
                    prompt,
                    onProgress: progressSender(send, k)
                });
                const notes = [
                    manualPrompt ? 'Prompt: manual' : null,
                    reference ? `Reference angle: ${reference.label}` : null,
                    n > 1 ? `Candidate ${k} of ${n}` : null
                ].filter(Boolean).join('; ');
                return saveGeneratedBuffer(
                    room.id,
                    buffer,
                    n > 1 ? `Candidate ${k} of ${n}` : 'Initial generation',
                    { basePrompt: prompt, capturedAt: Date.now(), source: 'generate', ...(notes ? { notes } : {}) }
                );
            }));

            const saved = outcomes.filter(o => o.status === 'fulfilled').map(o => o.value);
            const errors = outcomes.filter(o => o.status === 'rejected').map(o => o.reason?.message || String(o.reason));
            if (saved.length === 0) throw new Error(`Failed to generate staged image: ${errors[0]}`);

            const current = loadRoom(room.id);
            return {
                url: `/uploads/${current.generatedImageUrl}`,
                currentVersionId: current.currentVersionId,
                versions: saved.map(s => ({ ...s.version, url: s.url })),
                requested: n,
                failed: errors.length,
                errors
            };
        }
    }));

    const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/;

    // Reference for an edit (Image 1). Either an uploaded photo (referenceImage data URL + referenceLabel),
    // or a room in the same session (referenceRoomId, defaulting to the room's own reference room when only
    // referenceVersionId is given) at referenceVersionId or its current version. Returns { error } or
    // { reference: { image, label } | null }.
    const resolveEditReference = (room, body) => {
        const { referenceImage, referenceLabel, referenceVersionId } = body;
        if (referenceImage !== undefined) {
            const match = typeof referenceImage === 'string' && IMAGE_DATA_URL.exec(referenceImage);
            if (!match) return { error: 'referenceImage must be a base64 PNG, JPEG or WebP data URL' };
            const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
            return { reference: { image: { mimeType, data: match[2] }, label: (referenceLabel || 'uploaded photo').toString().slice(0, 100) } };
        }
        const refRoomId = body.referenceRoomId || (referenceVersionId ? room.referenceRoomId : null);
        if (!refRoomId) {
            return referenceVersionId ? { error: 'referenceVersionId given but no reference room' } : { reference: null };
        }
        if (refRoomId === room.id) return { error: 'A room cannot be its own edit reference' };
        const ref = loadRoom(refRoomId);
        if (!ref || ref.sessionId !== room.sessionId) return { error: 'referenceRoomId must be a room in the same session' };
        const version = referenceVersionId
            ? loadVersion(referenceVersionId, ref.id)
            : (ref.currentVersionId ? loadVersion(ref.currentVersionId, ref.id) : null);
        if (referenceVersionId && !version) return { error: 'referenceVersionId does not belong to the reference room' };
        const url = version ? version.url : ref.generatedImageUrl;
        if (!url) return { error: 'Reference room has no staged image' };
        return {
            reference: {
                url,
                label: version ? `${roomBaseName(ref)} v${version.versionNumber}` : roomBaseName(ref)
            }
        };
    };

    // Edit the room's current render, or the version named by baseVersionId (without restoring it).
    // An optional reference image (see resolveEditReference) is sent as Image 1.
    // rawPrompt sends instructions untouched (composed prompts, item 1.3).
    app.post('/api/rooms/:id/edit', (req, res) => runOperation(req, res, {
        kind: 'edit',
        validate: (room) => {
            if (!req.body?.instructions?.trim()) return { error: 'instructions is required' };
            if (req.body.baseVersionId) {
                if (!loadVersion(req.body.baseVersionId, room.id)) return { error: 'baseVersionId does not belong to this room' };
            } else if (!room.generatedImageUrl) {
                return { error: 'Room has no staged image to edit' };
            }
            const { error } = resolveEditReference(room, req.body);
            return error ? { error } : null;
        },
        execute: async ({ send, room }) => {
            const { instructions, rawPrompt, intents, baseVersionId } = req.body;
            const base = baseVersionId ? loadVersion(baseVersionId, room.id) : null;
            const { reference } = resolveEditReference(room, req.body);
            const buffer = await gemini.editImage({
                roomId: room.id,
                image: readImage(base ? base.url : room.generatedImageUrl),
                reference: reference ? (reference.image ?? readImage(reference.url)) : undefined,
                instructions,
                rawPrompt: Boolean(rawPrompt),
                onProgress: progressSender(send)
            });
            const label = (rawPrompt && intents ? intents : instructions).replace(/\s+/g, ' ').trim();
            const snapshot = {
                basePrompt: (room.generatedPrompt || '').trim() || undefined,
                capturedAt: Date.now(),
                source: rawPrompt ? 'edit-composed' : 'edit',
                editInstruction: rawPrompt && intents ? intents : instructions,
                ...(rawPrompt ? { rawPrompt: instructions } : {}),
            };
            const notes = [
                base ? `Edited from v${base.versionNumber}` : null,
                reference ? `Edit reference: ${reference.label}` : null
            ].filter(Boolean).join('; ');
            if (notes) snapshot.notes = notes;
            const saved = saveGeneratedBuffer(room.id, buffer, `Edit: ${label.substring(0, 50)}`, snapshot);
            return { url: saved.url, currentVersionId: saved.version.id, version: { ...saved.version, url: saved.url } };
        }
    }));
};
