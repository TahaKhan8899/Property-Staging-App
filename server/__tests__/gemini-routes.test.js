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

    it('candidates=3 leaves the lowest new version current', async () => {
        const { r } = await approvedRoom();
        const res = await request(ctx.app).post(`/api/rooms/${r.id}/render`).send({ candidates: 3 }).expect(200);
        const lowest = res.body.versions.reduce((a, b) => (a.versionNumber <= b.versionNumber ? a : b));
        expect(lowest.versionNumber).toBe(1);
        expect(res.body.currentVersionId).toBe(lowest.id);
        expect(getRoom(ctx.db, r.id).currentVersionId).toBe(lowest.id);
    });

    it('numbers versions in candidate order even when a later candidate finishes first', async () => {
        const { r } = await approvedRoom();
        let n = 0;
        setGeminiClientForTests({
            models: {
                generateContentStream: async (req) => {
                    calls.push({ type: 'image', req });
                    const delay = ++n === 1 ? 60 : 0; // candidate 1 finishes last
                    return (async function* () {
                        await new Promise(resolve => setTimeout(resolve, delay));
                        yield { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }], usageMetadata: USAGE };
                    })();
                }
            }
        });
        const res = await request(ctx.app).post(`/api/rooms/${r.id}/render`).send({ candidates: 3 }).expect(200);
        expect(res.body.versions.map(v => [v.versionNumber, v.description])).toEqual([
            [1, 'Candidate 1 of 3'], [2, 'Candidate 2 of 3'], [3, 'Candidate 3 of 3']
        ]);
        expect(res.body.currentVersionId).toBe(res.body.versions[0].id);
    });

    it('streams candidate_done per candidate and reports partial failures', async () => {
        const { r } = await approvedRoom();
        let n = 0;
        setGeminiClientForTests({
            models: {
                generateContentStream: async (req) => {
                    calls.push({ type: 'image', req });
                    const fail = ++n === 2;
                    return (async function* () {
                        yield { candidates: [{ content: { parts: [fail ? { text: 'no image' } : { inlineData: { mimeType: 'image/png', data: png } }] } }], usageMetadata: USAGE };
                    })();
                }
            }
        });
        const res = await request(ctx.app)
            .post(`/api/rooms/${r.id}/render`)
            .set('Accept', 'text/event-stream')
            .send({ candidates: 3 })
            .buffer()
            .parse((resp, cb) => { let t = ''; resp.on('data', c => { t += c; }); resp.on('end', () => cb(null, t)); })
            .expect(200);
        expect(res.body.match(/event: candidate_done/g)).toHaveLength(2);
        expect(res.body.match(/event: candidate_error/g)).toHaveLength(1);
        const done = JSON.parse(res.body.split('event: done\ndata: ')[1].split('\n')[0]);
        expect(done).toMatchObject({ requested: 3, failed: 1 });
        expect(done.versions).toHaveLength(2);
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
        expect(snap.notes).toBe('Reference angle: Living Room 1 v1');
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

describe('version targeting (1.1c)', () => {
    const imageDataSent = (call, index) => call.req.contents.parts[index].inlineData.data;
    const fileB64 = (s, rel) => fs.readFileSync(path.join(ctx.uploads, s.name, rel)).toString('base64');

    // Anchor with two distinct renders (v1, v2; v2 current) and a dependent linked to it
    const anchorAndDependent = async () => {
        const s = await createSession(ctx.app);
        const anchor = await uploadRoom(ctx.app, s.id, 'Living Room');
        const v1 = await saveGenerated(ctx.app, anchor.id, await makeJpeg(400, 225, 11));
        await saveGenerated(ctx.app, anchor.id, await makeJpeg(400, 225, 12));
        const dep = await uploadRoom(ctx.app, s.id, 'Living Room');
        ctx.db.prepare('UPDATE rooms SET referenceRoomId = ?, generatedPrompt = ?, isPromptApproved = 1 WHERE id = ?').run(anchor.id, 'go', dep.id);
        return { s, anchor, dep, v1 };
    };

    it('render with prompt uses that text on an unapproved room and leaves both prompt columns alone', async () => {
        const s = await createSession(ctx.app);
        const r = await uploadRoom(ctx.app, s.id, 'Bedroom');
        ctx.db.prepare('UPDATE rooms SET generatedPrompt = ?, initialPrompt = ? WHERE id = ?').run('saved', 'initial', r.id);
        const res = await request(ctx.app).post(`/api/rooms/${r.id}/render`).send({ prompt: 'Manual prompt text' }).expect(200);
        expect(calls[0].req.contents.parts[1].text).toBe('Manual prompt text');
        const row = getRoom(ctx.db, r.id);
        expect(row).toMatchObject({ generatedPrompt: 'saved', initialPrompt: 'initial', isPromptApproved: 0 });
        expect(res.body.versions[0].promptSnapshot).toMatchObject({ basePrompt: 'Manual prompt text', notes: 'Prompt: manual' });
    });

    it('render rejects an empty manual prompt', async () => {
        const { r } = await approvedRoom();
        await request(ctx.app).post(`/api/rooms/${r.id}/render`).send({ prompt: '  ' }).expect(400);
    });

    it('render with referenceVersionId sends that version, not the current one, and notes it', async () => {
        const { s, anchor, dep, v1 } = await anchorAndDependent();
        const res = await request(ctx.app).post(`/api/rooms/${dep.id}/render`).send({ referenceVersionId: v1.version.id }).expect(200);
        expect(imageDataSent(calls[0], 0)).toBe(fileB64(s, 'staged/Living Room 1_v1.jpg'));
        expect(res.body.versions[0].promptSnapshot.notes).toBe('Reference angle: Living Room 1 v1');
        // The anchor's current pointer did not move
        expect(getRoom(ctx.db, anchor.id).generatedImageUrl).toBe(`${s.name}/staged/Living Room 1_v2.jpg`);
    });

    it('referenceVersionId from another room, or without a reference room, is 400 and makes no call', async () => {
        const { dep } = await anchorAndDependent();
        const other = await anchorAndDependent();
        await request(ctx.app).post(`/api/rooms/${dep.id}/render`).send({ referenceVersionId: other.v1.version.id }).expect(400);
        await request(ctx.app).post(`/api/rooms/${dep.id}/prompt`).send({ referenceVersionId: other.v1.version.id }).expect(400);
        const { r } = await approvedRoom();
        await request(ctx.app).post(`/api/rooms/${r.id}/render`).send({ referenceVersionId: other.v1.version.id }).expect(400);
        expect(calls).toHaveLength(0);
    });

    it('prompt with referenceVersionId sends that version to the reference-angle writer', async () => {
        const { s, dep, v1 } = await anchorAndDependent();
        await request(ctx.app).post(`/api/rooms/${dep.id}/prompt`).send({ referenceVersionId: v1.version.id }).expect(200);
        expect(imageDataSent(calls[0], 0)).toBe(fileB64(s, 'staged/Living Room 1_v1.jpg'));
    });

    it('edit with baseVersionId edits that version without a restore and notes it', async () => {
        const { s, anchor, v1 } = await anchorAndDependent();
        const res = await request(ctx.app).post(`/api/rooms/${anchor.id}/edit`).send({ instructions: 'add a lamp', baseVersionId: v1.version.id }).expect(200);
        expect(imageDataSent(calls[0], 0)).toBe(fileB64(s, 'staged/Living Room 1_v1.jpg'));
        expect(res.body.version.versionNumber).toBe(3);
        expect(res.body.version.promptSnapshot.notes).toBe('Edited from v1');
    });

    it('edit with a baseVersionId from another room is 400', async () => {
        const { anchor } = await anchorAndDependent();
        const other = await anchorAndDependent();
        await request(ctx.app).post(`/api/rooms/${anchor.id}/edit`).send({ instructions: 'x', baseVersionId: other.v1.version.id }).expect(400);
        expect(calls).toHaveLength(0);
    });

    it('calls without the new fields send the same request shape as before', async () => {
        const { s, dep } = await anchorAndDependent();
        await request(ctx.app).post(`/api/rooms/${dep.id}/render`).send({}).expect(200);
        const parts = calls[0].req.contents.parts;
        expect(parts.map(p => Object.keys(p)[0])).toEqual(['inlineData', 'inlineData', 'text']);
        expect(parts[0].inlineData.data).toBe(fileB64(s, 'staged/Living Room 1_v2.jpg')); // anchor's current
        expect(parts[2].text).toBe('go');
        expect(calls[0].req.config).toEqual({ imageConfig: { imageSize: '2K', aspectRatio: '16:9' } });
    });
});

describe('edit references (1.2)', () => {
    const fileB64 = (s, rel) => fs.readFileSync(path.join(ctx.uploads, s.name, rel)).toString('base64');

    // Two staged angles of one room in a session: anchor has v1 + v2 (current), dependent has v1
    const twoAngles = async () => {
        const s = await createSession(ctx.app);
        const anchor = await uploadRoom(ctx.app, s.id, 'Kitchen');
        const a1 = await saveGenerated(ctx.app, anchor.id, await makeJpeg(400, 225, 21));
        await saveGenerated(ctx.app, anchor.id, await makeJpeg(400, 225, 22));
        const dep = await uploadRoom(ctx.app, s.id, 'Kitchen');
        await saveGenerated(ctx.app, dep.id, await makeJpeg(400, 225, 23));
        ctx.db.prepare('UPDATE rooms SET referenceRoomId = ? WHERE id = ?').run(anchor.id, dep.id);
        return { s, anchor, dep, a1 };
    };

    it('sibling reference: [reference, target, text], preamble, note with version', async () => {
        const { s, anchor, dep } = await twoAngles();
        const res = await request(ctx.app).post(`/api/rooms/${dep.id}/edit`).send({ instructions: 'Match the sofa', referenceRoomId: anchor.id }).expect(200);
        const parts = calls[0].req.contents.parts;
        expect(parts).toHaveLength(3);
        expect(parts[0].inlineData.data).toBe(fileB64(s, 'staged/Kitchen 1_v2.jpg'));
        expect(parts[1].inlineData.data).toBe(fileB64(s, 'staged/Kitchen 2_v1.jpg'));
        expect(parts[2].text.startsWith('Image 1 is a reference image.')).toBe(true);
        expect(res.body.version.promptSnapshot.notes).toBe('Edit reference: Kitchen 1 v2');
        expect(apiRows(dep.id).map(x => x.kind)).toEqual(['edit']);
    });

    it('works in either direction and with a pinned version; only referenceVersionId defaults to the reference room', async () => {
        const { s, anchor, dep, a1 } = await twoAngles();
        // anchor edited with the dependent as reference (reverse direction)
        await request(ctx.app).post(`/api/rooms/${anchor.id}/edit`).send({ instructions: 'x', referenceRoomId: dep.id }).expect(200);
        expect(calls[0].req.contents.parts[0].inlineData.data).toBe(fileB64(s, 'staged/Kitchen 2_v1.jpg'));
        // dependent with only referenceVersionId -> its reference room at that version
        const res = await request(ctx.app).post(`/api/rooms/${dep.id}/edit`).send({ instructions: 'x', referenceVersionId: a1.version.id }).expect(200);
        expect(calls[1].req.contents.parts[0].inlineData.data).toBe(fileB64(s, 'staged/Kitchen 1_v1.jpg'));
        expect(res.body.version.promptSnapshot.notes).toBe('Edit reference: Kitchen 1 v1');
    });

    it('combines with baseVersionId in the note', async () => {
        const { anchor, dep } = await twoAngles();
        const depV1 = ctx.db.prepare('SELECT id FROM image_versions WHERE roomId = ?').get(dep.id).id;
        const res = await request(ctx.app).post(`/api/rooms/${dep.id}/edit`).send({ instructions: 'x', referenceRoomId: anchor.id, baseVersionId: depV1 }).expect(200);
        expect(res.body.version.promptSnapshot.notes).toBe('Edited from v1; Edit reference: Kitchen 1 v2');
    });

    it('uploaded photo uses its real MIME type and file name', async () => {
        const { dep } = await twoAngles();
        const res = await request(ctx.app).post(`/api/rooms/${dep.id}/edit`)
            .send({ instructions: 'Use this exact sectional', referenceImage: `data:image/png;base64,${png}`, referenceLabel: 'sectional.png' })
            .expect(200);
        const parts = calls[0].req.contents.parts;
        expect(parts[0].inlineData).toEqual({ mimeType: 'image/png', data: png });
        expect(res.body.version.promptSnapshot.notes).toBe('Edit reference: sectional.png');
    });

    it('rejects self, other-session, mismatched version and bad uploads with 400 and no call', async () => {
        const { anchor, dep, a1 } = await twoAngles();
        const other = await twoAngles();
        await request(ctx.app).post(`/api/rooms/${dep.id}/edit`).send({ instructions: 'x', referenceRoomId: dep.id }).expect(400); // self without a version
        await request(ctx.app).post(`/api/rooms/${dep.id}/edit`).send({ instructions: 'x', referenceRoomId: other.anchor.id }).expect(400);
        await request(ctx.app).post(`/api/rooms/${dep.id}/edit`).send({ instructions: 'x', referenceRoomId: anchor.id, referenceVersionId: other.a1.version.id }).expect(400);
        await request(ctx.app).post(`/api/rooms/${anchor.id}/edit`).send({ instructions: 'x', referenceVersionId: a1.version.id }).expect(400); // anchor has no reference room
        await request(ctx.app).post(`/api/rooms/${dep.id}/edit`).send({ instructions: 'x', referenceImage: 'not-a-data-url' }).expect(400);
        expect(calls).toHaveLength(0);
    });

    it('same room at another version: [that version, current, text] and a note with the version', async () => {
        const { s, anchor, a1 } = await twoAngles();
        const res = await request(ctx.app).post(`/api/rooms/${anchor.id}/edit`)
            .send({ instructions: 'Use the chair from the reference', referenceRoomId: anchor.id, referenceVersionId: a1.version.id })
            .expect(200);
        const parts = calls[0].req.contents.parts;
        expect(parts[0].inlineData.data).toBe(fileB64(s, 'staged/Kitchen 1_v1.jpg'));
        expect(parts[1].inlineData.data).toBe(fileB64(s, 'staged/Kitchen 1_v2.jpg'));
        expect(parts[2].text.startsWith('Image 1 is a reference image.')).toBe(true);
        expect(res.body.version.promptSnapshot.notes).toBe('Edit reference: Kitchen 1 v1');
    });

    it('same room: rejects the version being edited and a version of another room', async () => {
        const { anchor, dep, a1 } = await twoAngles();
        const a2 = getRoom(ctx.db, anchor.id).currentVersionId;
        await request(ctx.app).post(`/api/rooms/${anchor.id}/edit`).send({ instructions: 'x', referenceRoomId: anchor.id, referenceVersionId: a2 }).expect(400);
        await request(ctx.app).post(`/api/rooms/${anchor.id}/edit`).send({ instructions: 'x', referenceRoomId: anchor.id, referenceVersionId: a1.version.id, baseVersionId: a1.version.id }).expect(400);
        const depV1 = ctx.db.prepare('SELECT id FROM image_versions WHERE roomId = ?').get(dep.id).id;
        await request(ctx.app).post(`/api/rooms/${anchor.id}/edit`).send({ instructions: 'x', referenceRoomId: anchor.id, referenceVersionId: depV1 }).expect(400);
        expect(calls).toHaveLength(0);
    });

    it('no reference fields: same two-part request as before, even when the room has a reference room', async () => {
        const { dep } = await twoAngles();
        await request(ctx.app).post(`/api/rooms/${dep.id}/edit`).send({ instructions: 'Make the sofa blue' }).expect(200);
        const parts = calls[0].req.contents.parts;
        expect(parts).toHaveLength(2);
        expect(parts[1].text.startsWith('Generate this exact same image')).toBe(true);
    });
});

describe('render referenceMode (1.4b)', () => {
    // Anchor with one render and a dependent linked to it, with an approved prompt
    const linkedPair = async () => {
        const s = await createSession(ctx.app);
        const anchor = await uploadRoom(ctx.app, s.id, 'Living Room');
        await saveGenerated(ctx.app, anchor.id);
        const dep = await uploadRoom(ctx.app, s.id, 'Kitchen');
        ctx.db.prepare('UPDATE rooms SET referenceRoomId = ?, generatedPrompt = ?, isPromptApproved = 1 WHERE id = ?').run(anchor.id, 'go', dep.id);
        return { s, anchor, dep };
    };
    const notesOf = (roomId) => Object.fromEntries(ctx.db.prepare('SELECT description, promptSnapshot FROM image_versions WHERE roomId = ?').all(roomId)
        .map(v => [v.description, JSON.parse(v.promptSnapshot).notes]));

    it("'text' renders a linked room from its photo alone, notes it, and keeps the link", async () => {
        const { anchor, dep } = await linkedPair();
        const res = await request(ctx.app).post(`/api/rooms/${dep.id}/render`).send({ referenceMode: 'text', candidates: 2 }).expect(200);
        const images = calls.filter(c => c.type === 'image');
        expect(images).toHaveLength(2);
        images.forEach(c => expect(c.req.contents.parts.map(p => Object.keys(p)[0])).toEqual(['inlineData', 'text']));
        expect(res.body.versions.map(v => v.promptSnapshot.notes).sort()).toEqual([
            'Text mode: reference not sent; Candidate 1 of 2',
            'Text mode: reference not sent; Candidate 2 of 2'
        ]);
        expect(getRoom(ctx.db, dep.id).referenceRoomId).toBe(anchor.id);
    });

    it('an array mixes modes per candidate and sets the candidate count', async () => {
        const { dep } = await linkedPair();
        const res = await request(ctx.app).post(`/api/rooms/${dep.id}/render`).send({ referenceMode: ['text', 'text', 'reference'] }).expect(200);
        expect(res.body.requested).toBe(3);
        expect(calls.map(c => c.req.contents.parts.length).sort()).toEqual([2, 2, 3]);
        expect(notesOf(dep.id)).toEqual({
            'Candidate 1 of 3': 'Text mode: reference not sent; Candidate 1 of 3',
            'Candidate 2 of 3': 'Text mode: reference not sent; Candidate 2 of 3',
            'Candidate 3 of 3': 'Reference angle: Living Room 1 v1; Candidate 3 of 3'
        });
    });

    it("'reference' or no referenceMode behaves as before", async () => {
        const { dep } = await linkedPair();
        await request(ctx.app).post(`/api/rooms/${dep.id}/render`).send({ referenceMode: 'reference' }).expect(200);
        expect(calls[0].req.contents.parts).toHaveLength(3);
    });

    it("'text' on an unlinked room adds no note", async () => {
        const { r } = await approvedRoom();
        const res = await request(ctx.app).post(`/api/rooms/${r.id}/render`).send({ referenceMode: 'text' }).expect(200);
        expect(res.body.versions[0].promptSnapshot.notes).toBeUndefined();
    });

    it('rejects bad modes, empty or long arrays, and a mismatched candidates count with 400 and no call', async () => {
        const { dep } = await linkedPair();
        for (const body of [
            { referenceMode: 'none' },
            { referenceMode: [] },
            { referenceMode: ['text', 'text', 'text', 'text'] },
            { referenceMode: ['text', 'bogus'] },
            { referenceMode: ['text', 'reference'], candidates: 3 }
        ]) {
            await request(ctx.app).post(`/api/rooms/${dep.id}/render`).send(body).expect(400);
        }
        await request(ctx.app).post(`/api/rooms/${dep.id}/prompt`).send({ referenceMode: ['text'] }).expect(400);
        expect(calls).toHaveLength(0);
    });

    it("prompt with 'text' uses the designer writer, not the reference-angle one", async () => {
        const { dep } = await linkedPair();
        await request(ctx.app).post(`/api/rooms/${dep.id}/prompt`).send({ referenceMode: 'text', userComments: 'sofa on the right' }).expect(200);
        const parts = calls[0].req.contents.parts;
        expect(parts).toHaveLength(2);
        expect(parts[1].text).toContain('sofa on the right');
        expect(apiRows(dep.id)[0].kind).toBe('prompt');
    });
});

describe('PUT /api/rooms/:id/prompt', () => {
    it('sets generatedPrompt and approval but never initialPrompt', async () => {
        const { r } = await approvedRoom();
        ctx.db.prepare('UPDATE rooms SET isPromptApproved = 0 WHERE id = ?').run(r.id);
        const res = await request(ctx.app).put(`/api/rooms/${r.id}/prompt`).send({ prompt: 'Hand written', approve: true }).expect(200);
        expect(res.body).toEqual({ generatedPrompt: 'Hand written', isPromptApproved: true });
        expect(getRoom(ctx.db, r.id)).toMatchObject({ generatedPrompt: 'Hand written', initialPrompt: 'Stage it', isPromptApproved: 1 });
        await request(ctx.app).put(`/api/rooms/${r.id}/prompt`).send({ prompt: 'Second' }).expect(200);
        expect(getRoom(ctx.db, r.id).isPromptApproved).toBe(1); // approve omitted -> unchanged
        await request(ctx.app).put(`/api/rooms/${r.id}/prompt`).send({}).expect(400);
        await request(ctx.app).put('/api/rooms/nope/prompt').send({ prompt: 'x' }).expect(404);
        expect(calls).toHaveLength(0);
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
