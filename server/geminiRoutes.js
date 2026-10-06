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

    // The room's staged sibling (same room, other angle), if set and it has a render on disk
    const resolveReference = (room) => {
        if (!room.referenceRoomId) return null;
        const ref = loadRoom(room.referenceRoomId);
        if (!ref?.generatedImageUrl) return null;
        try {
            return {
                image: readImage(ref.generatedImageUrl),
                label: path.basename(ref.filePath || '', path.extname(ref.filePath || '')) || 'reference'
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
        execute: async ({ room }) => {
            const reference = resolveReference(room);
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

    // Render from the approved prompt. candidates 1..3 run in parallel; each becomes its own version.
    app.post('/api/rooms/:id/render', (req, res) => runOperation(req, res, {
        kind: 'render',
        flag: 'isGeneratingImage',
        validate: (room) => {
            if (!room.generatedPrompt?.trim()) return { error: 'Room has no prompt yet' };
            if (!room.isPromptApproved) return { error: 'Prompt is not approved' };
            return null;
        },
        execute: async ({ send, room }) => {
            const n = Math.min(MAX_CANDIDATES, Math.max(1, parseInt(req.body?.candidates, 10) || 1));
            const image = readImage(room.filePath);
            const reference = resolveReference(room);

            const outcomes = await Promise.allSettled(Array.from({ length: n }, async (_, i) => {
                const k = i + 1;
                const buffer = await gemini.renderImage({
                    roomId: room.id,
                    image,
                    reference: reference?.image,
                    prompt: room.generatedPrompt,
                    onProgress: progressSender(send, k)
                });
                const notes = [
                    reference ? `Reference angle: ${reference.label}` : null,
                    n > 1 ? `Candidate ${k} of ${n}` : null
                ].filter(Boolean).join('; ');
                return saveGeneratedBuffer(
                    room.id,
                    buffer,
                    n > 1 ? `Candidate ${k} of ${n}` : 'Initial generation',
                    { basePrompt: room.generatedPrompt, capturedAt: Date.now(), source: 'generate', ...(notes ? { notes } : {}) }
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

    // Edit the room's current render. rawPrompt sends instructions untouched (composed prompts, item 1.3).
    app.post('/api/rooms/:id/edit', (req, res) => runOperation(req, res, {
        kind: 'edit',
        validate: (room) => {
            if (!req.body?.instructions?.trim()) return { error: 'instructions is required' };
            if (!room.generatedImageUrl) return { error: 'Room has no staged image to edit' };
            return null;
        },
        execute: async ({ send, room }) => {
            const { instructions, rawPrompt, intents } = req.body;
            const buffer = await gemini.editImage({
                roomId: room.id,
                image: readImage(room.generatedImageUrl),
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
                ...(rawPrompt ? { rawPrompt: instructions } : {})
            };
            const saved = saveGeneratedBuffer(room.id, buffer, `Edit: ${label.substring(0, 50)}`, snapshot);
            return { url: saved.url, currentVersionId: saved.version.id, version: { ...saved.version, url: saved.url } };
        }
    }));
};
