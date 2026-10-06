import fs from 'fs';
import path from 'path';
import request from 'supertest';
import unzipper from 'unzipper';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createSession, makeJpeg, saveGenerated, uploadRoom } from './helpers.js';

let ctx;
beforeAll(async () => { ctx = await bootApp(); });
afterAll(() => ctx.cleanup());

const binary = (res, cb) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const fetchZip = async (sessionId, variant) => {
    const res = await request(ctx.app).get(`/api/sessions/${sessionId}/export?variant=${variant}`).buffer().parse(binary).expect(200);
    const dir = await unzipper.Open.buffer(res.body);
    const entries = {};
    for (const f of dir.files) entries[f.path] = await f.buffer();
    return { res, entries };
};

const stageAndOutput = async (session, roomType, seed) => {
    const r = await uploadRoom(ctx.app, session.id, roomType);
    await saveGenerated(ctx.app, r.id, await makeJpeg(1200, 675, seed));
    await request(ctx.app).post(`/api/rooms/${r.id}/output`).send({}).expect(200);
    return r;
};

describe('session export', () => {
    it('staged zip has exactly the output files, unchanged; compressed ones are smaller', async () => {
        const s = await createSession(ctx.app, 'Export Set');
        await stageAndOutput(s, 'Kitchen', 1);
        await stageAndOutput(s, 'Bedroom', 2);
        // A staged version that was never added to output must not appear
        const extra = await uploadRoom(ctx.app, s.id, 'Bathroom');
        await saveGenerated(ctx.app, extra.id);

        const outDir = path.join(ctx.uploads, s.name, 'output');
        const onDisk = fs.readdirSync(outDir).sort();

        const staged = await fetchZip(s.id, 'staged');
        expect(Object.keys(staged.entries).sort()).toEqual(onDisk);
        for (const name of onDisk) expect(staged.entries[name].equals(fs.readFileSync(path.join(outDir, name)))).toBe(true);
        expect(staged.res.headers['content-disposition']).toContain('Export Set - Staged.zip');

        const compressed = await fetchZip(s.id, 'compressed');
        expect(Object.keys(compressed.entries).sort()).toEqual(onDisk);
        for (const name of onDisk) expect(compressed.entries[name].length).toBeLessThan(staged.entries[name].length);
        expect(compressed.res.headers['content-disposition']).toContain('Export Set - Compressed.zip');
    });

    it('uses the sanitized session name in the zip file name', async () => {
        const s = await createSession(ctx.app, 'Unit #5/B');
        await stageAndOutput(s, 'Kitchen', 3);
        const { res } = await fetchZip(s.id, 'staged');
        expect(res.headers['content-disposition']).toContain('Unit 5B - Staged.zip');
    });

    it('returns 404 when output is empty and for an unknown session', async () => {
        const s = await createSession(ctx.app, 'Empty Set');
        const res = await request(ctx.app).get(`/api/sessions/${s.id}/export?variant=staged`).expect(404);
        expect(res.body.error).toBe('No images in output');
        await request(ctx.app).get('/api/sessions/nope/export').expect(404);
    });
});
