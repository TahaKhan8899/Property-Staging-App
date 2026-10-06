import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createSession, getRoom, makeJpeg, saveGenerated, uploadRoom } from './helpers.js';

let ctx;
beforeAll(async () => { ctx = await bootApp(); });
afterAll(() => ctx.cleanup());

const outputDir = (s) => path.join(ctx.uploads, s.name, 'output');
const outputFiles = (s) => (fs.existsSync(outputDir(s)) ? fs.readdirSync(outputDir(s)).sort() : []);
const addOutput = (roomId) => request(ctx.app).post(`/api/rooms/${roomId}/output`).send({}).expect(200);

describe('output folder', () => {
    it('adds, replaces on version change, and removes', async () => {
        const s = await createSession(ctx.app);
        const r = await uploadRoom(ctx.app, s.id, 'Kitchen');
        const v1 = await saveGenerated(ctx.app, r.id, await makeJpeg(400, 225, 1));
        await addOutput(r.id);
        expect(outputFiles(s)).toEqual(['Kitchen 1.jpg']);
        expect(getRoom(ctx.db, r.id).outputSourcePath).toBe('staged/Kitchen 1_v1.jpg');

        const v2Bytes = await makeJpeg(400, 225, 2);
        await saveGenerated(ctx.app, r.id, v2Bytes);
        await addOutput(r.id);
        expect(outputFiles(s)).toEqual(['Kitchen 1.jpg']);
        expect(getRoom(ctx.db, r.id).outputSourcePath).toBe('staged/Kitchen 1_v2.jpg');
        expect(fs.readFileSync(path.join(outputDir(s), 'Kitchen 1.jpg')).length).toBeGreaterThan(0);
        expect(v1.version.versionNumber).toBe(1);

        await request(ctx.app).delete(`/api/rooms/${r.id}/output`).expect(200);
        expect(outputFiles(s)).toEqual([]);
        expect(getRoom(ctx.db, r.id).outputSourcePath).toBeNull();
    });

    it('gives a second room with the same base name a " (2)" suffix', async () => {
        const s = await createSession(ctx.app);
        const a = await uploadRoom(ctx.app, s.id, 'Kitchen');
        const b = await uploadRoom(ctx.app, s.id, 'Kitchen');
        await saveGenerated(ctx.app, a.id);
        await saveGenerated(ctx.app, b.id);
        // Force a name collision like two "Kitchen 1" originals
        ctx.db.prepare('UPDATE rooms SET filePath = ? WHERE id = ?').run(getRoom(ctx.db, a.id).filePath, b.id);
        await addOutput(a.id);
        await addOutput(b.id);
        expect(outputFiles(s)).toEqual(['Kitchen 1 (2).jpg', 'Kitchen 1.jpg']);
    });
});

describe('download compressed', () => {
    const download = async (roomId) => {
        const res = await request(ctx.app).get(`/api/rooms/${roomId}/download-compressed`).expect(302);
        const file = await request(ctx.app).get(res.headers.location).expect(200);
        return { url: res.headers.location, body: file.body };
    };

    it('suffixes duplicate names and outputs a smaller jpeg', async () => {
        const s = await createSession(ctx.app);
        const a = await uploadRoom(ctx.app, s.id, 'Kitchen');
        const b = await uploadRoom(ctx.app, s.id, 'Kitchen');
        const big = await makeJpeg(1200, 675, 3);
        await saveGenerated(ctx.app, a.id, big);
        await saveGenerated(ctx.app, b.id, big);
        ctx.db.prepare('UPDATE rooms SET filePath = ? WHERE id = ?').run(getRoom(ctx.db, a.id).filePath, b.id);

        const first = await download(a.id);
        const second = await download(b.id);
        expect(decodeURIComponent(first.url)).toMatch(/Kitchen 1_compressed\.jpg$/);
        expect(decodeURIComponent(second.url)).toMatch(/Kitchen 1 \(2\)_compressed\.jpg$/);
        expect(first.body.length).toBeLessThan(big.length);
        expect(first.body[0]).toBe(0xff); // JPEG magic
    });

    it('recompresses after restoring an older version', async () => {
        const s = await createSession(ctx.app);
        const r = await uploadRoom(ctx.app, s.id, 'Kitchen');
        const v1Bytes = await makeJpeg(1200, 675, 4);
        const v1 = await saveGenerated(ctx.app, r.id, v1Bytes);
        await saveGenerated(ctx.app, r.id, await makeJpeg(300, 169, 5));
        const small = await download(r.id);
        await request(ctx.app).post(`/api/rooms/${r.id}/versions/${v1.version.id}/restore`).send({}).expect(200);
        const restored = await download(r.id);
        expect(restored.body.length).toBeGreaterThan(small.body.length);
    });
});

describe('session order', () => {
    it('lists the newest session first', async () => {
        const a = await createSession(ctx.app, 'Order A');
        const b = await createSession(ctx.app, 'Order B');
        const list = (await request(ctx.app).get('/api/sessions').expect(200)).body.map(x => x.id);
        expect(list[0]).toBe(b.id);
        expect(list.indexOf(b.id)).toBeLessThan(list.indexOf(a.id));
    });
});

describe('session rename and delete', () => {
    it('moves the folder and rewrites room and version paths', async () => {
        const s = await createSession(ctx.app, 'Old Name');
        const r = await uploadRoom(ctx.app, s.id, 'Kitchen');
        await saveGenerated(ctx.app, r.id);
        await request(ctx.app).patch(`/api/sessions/${s.id}`).send({ name: 'New Name' }).expect(200);

        expect(fs.existsSync(path.join(ctx.uploads, 'Old Name'))).toBe(false);
        expect(fs.existsSync(path.join(ctx.uploads, 'New Name', 'original', 'Kitchen 1.jpg'))).toBe(true);
        const row = getRoom(ctx.db, r.id);
        expect(row.filePath.startsWith('New Name/')).toBe(true);
        expect(row.generatedImageUrl.startsWith('New Name/')).toBe(true);
        const v = ctx.db.prepare('SELECT url FROM image_versions WHERE roomId = ?').get(r.id);
        expect(v.url.startsWith('New Name/')).toBe(true);
    });

    it('delete cascades rooms, versions and folder; api_calls survive', async () => {
        const s = await createSession(ctx.app, 'Doomed');
        const r = await uploadRoom(ctx.app, s.id, 'Kitchen');
        await saveGenerated(ctx.app, r.id);
        await request(ctx.app).post('/api/usage').send({ roomId: r.id, kind: 'generate', model: 'm', status: 'ok', costUsd: 0.13 }).expect(200);
        await request(ctx.app).delete(`/api/sessions/${s.id}`).expect(200);

        expect(getRoom(ctx.db, r.id)).toBeUndefined();
        expect(ctx.db.prepare('SELECT COUNT(*) c FROM image_versions WHERE roomId = ?').get(r.id).c).toBe(0);
        expect(fs.existsSync(path.join(ctx.uploads, 'Doomed'))).toBe(false);
        expect(ctx.db.prepare('SELECT COUNT(*) c FROM api_calls WHERE sessionId = ?').get(s.id).c).toBe(1);
    });
});

describe('usage', () => {
    it('resolves the session from the room and totals/groups correctly', async () => {
        const s = await createSession(ctx.app);
        const r = await uploadRoom(ctx.app, s.id, 'Kitchen');
        const post = (c) => request(ctx.app).post('/api/usage').send({ roomId: r.id, model: 'img', status: 'ok', ...c }).expect(200);
        await post({ kind: 'generate', costUsd: 0.13 });
        await post({ kind: 'generate', costUsd: 0.13 });
        await post({ kind: 'edit', costUsd: 0.14 });
        await post({ kind: 'edit', costUsd: 0, status: 'error', error: 'boom' });

        const res = await request(ctx.app).get(`/api/sessions/${s.id}/usage`).expect(200);
        expect(res.body.calls).toBe(4);
        expect(res.body.failedCalls).toBe(1);
        expect(res.body.costUsd).toBeCloseTo(0.4, 5);
        const gen = res.body.byKind.find(k => k.kind === 'generate');
        expect(gen.calls).toBe(2);
        expect(gen.costUsd).toBeCloseTo(0.26, 5);
        expect(res.body.byRoom).toHaveLength(1);
        expect(ctx.db.prepare('SELECT sessionName FROM api_calls WHERE sessionId = ? LIMIT 1').get(s.id).sessionName).toBe(s.name);
    });

    it('counts approved prompts and those edited before approval', async () => {
        const s = await createSession(ctx.app);
        const rooms = await Promise.all(['Kitchen', 'Bedroom', 'Bathroom', 'Patio'].map(t => uploadRoom(ctx.app, s.id, t)));
        const set = (r, generated, initial, approved) =>
            ctx.db.prepare('UPDATE rooms SET generatedPrompt = ?, initialPrompt = ?, isPromptApproved = ? WHERE id = ?').run(generated, initial, approved, r.id);
        set(rooms[0], 'same', 'same', 1);        // approved as generated
        set(rooms[1], 'edited', 'original', 1);  // approved after an edit
        set(rooms[2], 'edited', 'original', 0);  // edited but not approved: not counted
        set(rooms[3], 'p', null, 1);             // no initialPrompt (e.g. manual): counts as edited
        const res = await request(ctx.app).get(`/api/sessions/${s.id}/usage`).expect(200);
        expect(res.body.promptsApproved).toBe(3);
        expect(res.body.promptsEdited).toBe(2);
        const empty = await createSession(ctx.app);
        const res2 = await request(ctx.app).get(`/api/sessions/${empty.id}/usage`).expect(200);
        expect(res2.body).toMatchObject({ promptsApproved: 0, promptsEdited: 0 });
    });
});
