import fs from 'fs';
import path from 'path';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setGeminiClientForTests } from '../gemini.js';
import { bootApp, createSession, getRoom, makeJpeg, saveGenerated, uploadRoom } from './helpers.js';

let ctx;
let png; // base64 of a tiny real PNG the fake model "generates"
let calls; // every request the fake model received
let release; // when set, image streams wait on this promise (for concurrency tests)

const USAGE = {
    promptTokenCount: 1000,
    candidatesTokenCount: 1120,
    candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }]
};

const fakeClient = {
    models: {
        generateContent: async (req) => {
            calls.push({ type: 'text', req });
            return { text: '"A staged prompt"', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } };
        },
        generateContentStream: async (req) => {
            calls.push({ type: 'image', req });
            const waitFor = release;
            return (async function* () {
                if (waitFor) await waitFor;
                yield { candidates: [{ content: { parts: [{ thought: true, text: 'thinking' }] } }] };
                yield { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }], usageMetadata: USAGE };
            })();
        }
    }
};

beforeAll(async () => {
    ctx = await bootApp();
    png = (await sharp({ create: { width: 64, height: 36, channels: 4, background: '#808080' } }).png().toBuffer()).toString('base64');
});
afterAll(() => ctx.cleanup());
beforeEach(() => {
    calls = [];
    release = null;
    setGeminiClientForTests(fakeClient);
});
afterEach(() => setGeminiClientForTests(null));

const approvedRoom = async (roomType = 'Kitchen', extra = {}) => {
    const s = await createSession(ctx.app);
    const r = await uploadRoom(ctx.app, s.id, roomType);
    ctx.db.prepare('UPDATE rooms SET generatedPrompt = ?, initialPrompt = ?, isPromptApproved = 1 WHERE id = ?').run('Stage it', 'Stage it', r.id);
    return { s, r, ...extra };
};

const apiRows = (roomId) => ctx.db.prepare('SELECT * FROM api_calls WHERE roomId = ? ORDER BY timestamp').all(roomId);

describe('POST /api/rooms/:id/prompt', () => {
    it('writes prompt and initialPrompt, strips quotes, unapproves, logs usage', async () => {
        const s = await createSession(ctx.app);
        const r = await uploadRoom(ctx.app, s.id, 'Bedroom');
        ctx.db.prepare('UPDATE rooms SET isPromptApproved = 1 WHERE id = ?').run(r.id);
        const res = await request(ctx.app).post(`/api/rooms/${r.id}/prompt`).send({ userComments: 'more plants' }).expect(200);
        expect(res.body.generatedPrompt).toBe('A staged prompt');
        const row = getRoom(ctx.db, r.id);
        expect(row.generatedPrompt).toBe('A staged prompt');
        expect(row.initialPrompt).toBe('A staged prompt');
        expect(row.isPromptApproved).toBe(0);
        expect(row.isGeneratingPrompt).toBe(0);
        const parts = calls[0].req.contents.parts;
        expect(parts[0].inlineData.data).toBeTruthy();
        expect(parts[1].text).toContain('more plants');
        expect(parts[1].text).toContain('Bedroom');
        const rows = apiRows(r.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'prompt', status: 'ok', sessionId: s.id });
    });

    it('uses the reference-angle flow with [reference, target, text] when the reference has a render', async () => {
        const s = await createSession(ctx.app);
        const anchor = await uploadRoom(ctx.app, s.id, 'Living Room');
        await saveGenerated(ctx.app, anchor.id);
        const dep = await uploadRoom(ctx.app, s.id, 'Living Room');
        await request(ctx.app).patch(`/api/rooms/${dep.id}`).send({ referenceRoomId: anchor.id }).expect(200);
        await request(ctx.app).post(`/api/rooms/${dep.id}/prompt`).send({}).expect(200);
        const parts = calls[0].req.contents.parts;
        expect(parts).toHaveLength(3);
        expect(parts[2].text).toContain('Image 1 is the staged reference');
        expect(apiRows(dep.id)[0].kind).toBe('reference_prompt');
    });
});

describe('POST /api/rooms/:id/refine-prompt', () => {
    it('updates generatedPrompt only and requires feedback', async () => {
        const { r } = await approvedRoom();
        await request(ctx.app).post(`/api/rooms/${r.id}/refine-prompt`).send({}).expect(400);
        await request(ctx.app).post(`/api/rooms/${r.id}/refine-prompt`).send({ feedback: 'add a rug', currentPrompt: 'Edited text' }).expect(200);
        const row = getRoom(ctx.db, r.id);
        expect(row.generatedPrompt).toBe('"A staged prompt"');
        expect(row.initialPrompt).toBe('Stage it');
        expect(calls[0].req.contents[0].parts[0].text).toContain('Edited text');
    });
});

describe('POST /api/rooms/:id/render', () => {
    it('refuses an unapproved prompt', async () => {
        const s = await createSession(ctx.app);
        const r = await uploadRoom(ctx.app, s.id, 'Kitchen');
        ctx.db.prepare('UPDATE rooms SET generatedPrompt = ? WHERE id = ?').run('p', r.id);
        const res = await request(ctx.app).post(`/api/rooms/${r.id}/render`).send({}).expect(400);
        expect(res.body.error).toBe('Prompt is not approved');
    });

    it('saves a JPEG version with snapshot and logs one generate row (candidates=1)', async () => {
        const { s, r } = await approvedRoom();
        const res = await request(ctx.app).post(`/api/rooms/${r.id}/render`).send({}).expect(200);
        expect(res.body.versions).toHaveLength(1);
        expect(res.body.versions[0].description).toBe('Initial generation');
        const file = path.join(ctx.uploads, s.name, 'staged', 'Kitchen 1_v1.jpg');
        expect((await sharp(file).metadata()).format).toBe('jpeg');
        const row = getRoom(ctx.db, r.id);
        expect(row.currentVersionId).toBe(res.body.versions[0].id);
        expect(row.isGeneratingImage).toBe(0);
        const rows = apiRows(r.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'generate', status: 'ok', imageCount: 1 });
        expect(rows[0].costUsd).toBeGreaterThan(0.13);
        const snap = JSON.parse(ctx.db.prepare('SELECT promptSnapshot FROM image_versions WHERE roomId = ?').get(r.id).promptSnapshot);
        expect(snap).toMatchObject({ source: 'generate', basePrompt: 'Stage it' });
        expect(calls[0].req.config.imageConfig).toEqual({ imageSize: '2K', aspectRatio: '16:9' });
    });

    it('candidates=3 saves versions 1-3 and three generate rows', async () => {
        const { r } = await approvedRoom();
        const res = await request(ctx.app).post(`/api/rooms/${r.id}/render`).send({ candidates: 3 }).expect(200);
        expect(res.body.versions.map(v => v.versionNumber).sort()).toEqual([1, 2, 3]);
        expect(calls.filter(c => c.type === 'image')).toHaveLength(3);
        expect(apiRows(r.id).filter(x => x.kind === 'generate')).toHaveLength(3);
        const descs = ctx.db.prepare('SELECT description FROM image_versions WHERE roomId = ?').all(r.id).map(v => v.description).sort();
        expect(descs).toEqual(['Candidate 1 of 3', 'Candidate 2 of 3', 'Candidate 3 of 3']);
    });

    it('sends [reference, target, text] and notes the reference when the room has a reference render', async () => {
        const s = await createSession(ctx.app);
        const anchor = await uploadRoom(ctx.app, s.id, 'Living Room');
        await saveGenerated(ctx.app, anchor.id);
        const dep = await uploadRoom(ctx.app, s.id, 'Living Room');
        ctx.db.prepare('UPDATE rooms SET referenceRoomId = ?, generatedPrompt = ?, isPromptApproved = 1 WHERE id = ?').run(anchor.id, 'go', dep.id);
        await request(ctx.app).post(`/api/rooms/${dep.id}/render`).send({}).expect(200);
        const parts = calls[0].req.contents.parts;
        expect(parts).toHaveLength(3);
        expect(parts[2].text).toBe('go');
        const snap = JSON.parse(ctx.db.prepare('SELECT promptSnapshot FROM image_versions WHERE roomId = ?').get(dep.id).promptSnapshot);
        expect(snap.notes).toBe('Reference angle: Living Room 1');
    });

    it('returns an error and logs a failed row when the model returns no image', async () => {
        const { r } = await approvedRoom();
        setGeminiClientForTests({ models: { generateContentStream: async () => (async function* () { yield { candidates: [{ content: { parts: [{ text: 'no' }] } }] }; })() } });
        const res = await request(ctx.app).post(`/api/rooms/${r.id}/render`).send({}).expect(500);
        expect(res.body.error).toContain('No image data returned');
        expect(apiRows(r.id)[0]).toMatchObject({ kind: 'generate', status: 'error' });
        expect(getRoom(ctx.db, r.id).isGeneratingImage).toBe(0);
    });

    it('returns 409 for a second operation on a busy room', async () => {
        const { r } = await approvedRoom();
        let open;
        release = new Promise(resolve => { open = resolve; });
        const first = request(ctx.app).post(`/api/rooms/${r.id}/render`).send({}).then(res => res);
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(getRoom(ctx.db, r.id).isGeneratingImage).toBe(1);
        const second = await request(ctx.app).post(`/api/rooms/${r.id}/render`).send({});
        expect(second.status).toBe(409);
        open();
        expect((await first).status).toBe(200);
        expect(getRoom(ctx.db, r.id).isGeneratingImage).toBe(0);
    });

    it('streams thought and done events over SSE', async () => {
        const { r } = await approvedRoom();
        const res = await request(ctx.app)
            .post(`/api/rooms/${r.id}/render`)
            .set('Accept', 'text/event-stream')
            .send({})
            .buffer()
            .parse((resp, cb) => { let t = ''; resp.on('data', c => { t += c; }); resp.on('end', () => cb(null, t)); })
            .expect(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        expect(res.body).toContain('event: thought');
        expect(res.body).toContain('"status":"thinking"');
        expect(res.body).toContain('event: done');
        expect(res.body.indexOf('event: thought')).toBeLessThan(res.body.indexOf('event: done'));
    });
});

describe('POST /api/rooms/:id/edit', () => {
    const staged = async () => {
        const { s, r } = await approvedRoom();
        await saveGenerated(ctx.app, r.id, await makeJpeg());
        return { s, r };
    };

    it('wraps instructions in the edit template and saves an edit version with snapshot', async () => {
        const { r } = await staged();
        const res = await request(ctx.app).post(`/api/rooms/${r.id}/edit`).send({ instructions: 'Make the sofa blue' }).expect(200);
        const text = calls[0].req.contents.parts[1].text;
        expect(text).toContain('Make the sofa blue');
        expect(text).toContain('Keep everything else IDENTICAL');
        expect(res.body.version.versionNumber).toBe(2);
        expect(res.body.version.description).toBe('Edit: Make the sofa blue');
        expect(res.body.version.promptSnapshot).toMatchObject({ source: 'edit', editInstruction: 'Make the sofa blue' });
        expect(apiRows(r.id).map(x => x.kind)).toEqual(['edit']);
    });

    it('rawPrompt sends the text untouched and records edit-composed', async () => {
        const { r } = await staged();
        const raw = 'Keep exactly as they are:\n- rug\nChanges:\n1. remove table';
        const res = await request(ctx.app).post(`/api/rooms/${r.id}/edit`).send({ instructions: raw, rawPrompt: true, intents: 'remove table' }).expect(200);
        expect(calls[0].req.contents.parts[1].text).toBe(raw);
        expect(res.body.version.promptSnapshot).toMatchObject({ source: 'edit-composed', editInstruction: 'remove table', rawPrompt: raw });
    });

    it('validates input and requires a staged image', async () => {
        const { r } = await staged();
        await request(ctx.app).post(`/api/rooms/${r.id}/edit`).send({}).expect(400);
        const { r: bare } = await approvedRoom();
        await request(ctx.app).post(`/api/rooms/${bare.id}/edit`).send({ instructions: 'x' }).expect(400);
        await request(ctx.app).post('/api/rooms/nope/edit').send({ instructions: 'x' }).expect(404);
    });
});

describe('missing API key', () => {
    it('returns a clear 500 and does not touch the room', async () => {
        const { r } = await approvedRoom();
        setGeminiClientForTests(null);
        const saved = process.env.GEMINI_API_KEY;
        delete process.env.GEMINI_API_KEY;
        try {
            const res = await request(ctx.app).post(`/api/rooms/${r.id}/render`).send({}).expect(500);
            expect(res.body.error).toContain('GEMINI_API_KEY');
            expect((await request(ctx.app).get('/api/health')).body.geminiKeyConfigured).toBe(false);
            expect(getRoom(ctx.db, r.id).isGeneratingImage).toBe(0);
        } finally {
            if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
        }
    });
});
