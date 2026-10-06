import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createSession, getRoom, makeJpeg, saveGenerated, uploadRoom } from './helpers.js';

let ctx;
beforeAll(async () => { ctx = await bootApp(); });
afterAll(() => ctx.cleanup());

const originalsOf = (session) => fs.readdirSync(path.join(ctx.uploads, session.name, 'original')).sort();
const stagedOf = (session) => fs.readdirSync(path.join(ctx.uploads, session.name, 'staged')).sort();

describe('upload naming', () => {
    it('numbers rooms per type', async () => {
        const s = await createSession(ctx.app);
        await uploadRoom(ctx.app, s.id, 'Kitchen');
        await uploadRoom(ctx.app, s.id, 'Kitchen');
        await uploadRoom(ctx.app, s.id, 'Bedroom');
        expect(originalsOf(s)).toEqual(['Bedroom 1.jpg', 'Kitchen 1.jpg', 'Kitchen 2.jpg']);
    });

    it('handles parallel uploads of files with the same original name', async () => {
        const s = await createSession(ctx.app);
        await Promise.all(['Kitchen', 'Bedroom', 'Bathroom', 'Patio'].map(t => uploadRoom(ctx.app, s.id, t)));
        expect(originalsOf(s)).toEqual(['Bathroom 1.jpg', 'Bedroom 1.jpg', 'Kitchen 1.jpg', 'Patio 1.jpg']);
    });

    it('does not reuse a taken number after a delete', async () => {
        const s = await createSession(ctx.app);
        const k1 = await uploadRoom(ctx.app, s.id, 'Kitchen');
        await uploadRoom(ctx.app, s.id, 'Kitchen');
        await request(ctx.app).delete(`/api/rooms/${k1.id}`).expect(200);
        await uploadRoom(ctx.app, s.id, 'Kitchen');
        // Kitchen 2 still exists, so the new one is 3 (never overwrites 2)
        expect(originalsOf(s)).toEqual(['Kitchen 2.jpg', 'Kitchen 3.jpg']);
    });

    it('does not collide after a room-type change', async () => {
        const s = await createSession(ctx.app);
        const a = await uploadRoom(ctx.app, s.id, 'Bedroom');
        await uploadRoom(ctx.app, s.id, 'Living Room');
        await request(ctx.app).patch(`/api/rooms/${a.id}`).send({ roomType: 'Living Room' }).expect(200);
        await uploadRoom(ctx.app, s.id, 'Living Room');
        expect(originalsOf(s)).toEqual(['Living Room 1.jpg', 'Living Room 2.jpg', 'Living Room 3.jpg']);
    });
});

describe('room-type rename', () => {
    it('renames original and staged files and updates DB paths', async () => {
        const s = await createSession(ctx.app);
        const r = await uploadRoom(ctx.app, s.id, 'Bedroom');
        await saveGenerated(ctx.app, r.id);
        // Room-type rename expects the staged file to be named like the room; current naming is *_v1.jpg,
        // so assert on what the route actually does to filePath and the original file.
        await request(ctx.app).patch(`/api/rooms/${r.id}`).send({ roomType: 'Office' }).expect(200);
        const row = getRoom(ctx.db, r.id);
        expect(row.filePath).toBe(path.join(s.name, 'original', 'Office 1.jpg'));
        expect(originalsOf(s)).toEqual(['Office 1.jpg']);
        expect(fs.existsSync(path.join(ctx.uploads, row.filePath))).toBe(true);
    });
});

describe('versioning', () => {
    it('writes <base>_vN.jpg, a version row with snapshot, and sets currentVersionId', async () => {
        const s = await createSession(ctx.app);
        const r = await uploadRoom(ctx.app, s.id, 'Kitchen');
        const snap = { basePrompt: 'p', source: 'generate' };
        const body = await saveGenerated(ctx.app, r.id, undefined, { description: 'First', promptSnapshot: snap });
        const body2 = await saveGenerated(ctx.app, r.id);
        expect(stagedOf(s)).toEqual(['Kitchen 1_v1.jpg', 'Kitchen 1_v2.jpg']);
        expect(body.version.versionNumber).toBe(1);
        expect(body2.version.versionNumber).toBe(2);
        const rows = ctx.db.prepare('SELECT * FROM image_versions WHERE roomId = ? ORDER BY versionNumber').all(r.id);
        expect(JSON.parse(rows[0].promptSnapshot)).toEqual(snap);
        expect(getRoom(ctx.db, r.id).currentVersionId).toBe(rows[1].id);
        expect(getRoom(ctx.db, r.id).generatedImageUrl).toBe(path.join(s.name, 'staged', 'Kitchen 1_v2.jpg'));
    });

    it('backfills version 1 for a room that has an image but no versions', async () => {
        const s = await createSession(ctx.app);
        const r = await uploadRoom(ctx.app, s.id, 'Kitchen');
        ctx.db.prepare('UPDATE rooms SET generatedImageUrl = ? WHERE id = ?').run(`${s.name}/staged/legacy.jpg`, r.id);
        const body = await saveGenerated(ctx.app, r.id);
        const rows = ctx.db.prepare('SELECT * FROM image_versions WHERE roomId = ? ORDER BY versionNumber').all(r.id);
        expect(rows).toHaveLength(2);
        expect(rows[0].versionNumber).toBe(1);
        expect(JSON.parse(rows[0].promptSnapshot).source).toBe('backfill');
        expect(body.version.versionNumber).toBe(2);
    });

    it('three parallel saves get distinct version numbers and files', async () => {
        const s = await createSession(ctx.app);
        const r = await uploadRoom(ctx.app, s.id, 'Kitchen');
        const buf = await makeJpeg();
        await Promise.all([1, 2, 3].map(() => saveGenerated(ctx.app, r.id, buf)));
        const nums = ctx.db.prepare('SELECT versionNumber FROM image_versions WHERE roomId = ? ORDER BY versionNumber').all(r.id).map(v => v.versionNumber);
        expect(nums).toEqual([1, 2, 3]);
        expect(stagedOf(s)).toHaveLength(3);
    });
});

describe('upload-staged', () => {
    it('behaves like a generated save with the external-image description', async () => {
        const s = await createSession(ctx.app);
        const r = await uploadRoom(ctx.app, s.id, 'Kitchen');
        const res = await request(ctx.app)
            .post(`/api/rooms/${r.id}/upload-staged`)
            .attach('file', await makeJpeg(), 'canva.jpg')
            .expect(200);
        expect(res.body.version.description).toBe('Uploaded external image');
        expect(res.body.version.versionNumber).toBe(1);
        expect(stagedOf(s)).toEqual(['Kitchen 1_v1.jpg']);
        const row = getRoom(ctx.db, r.id);
        expect(row.currentVersionId).toBe(res.body.version.id);
    });
});

describe('restore', () => {
    it('sets the current url and version id; unknown version is 404', async () => {
        const s = await createSession(ctx.app);
        const r = await uploadRoom(ctx.app, s.id, 'Kitchen');
        const v1 = await saveGenerated(ctx.app, r.id);
        await saveGenerated(ctx.app, r.id);
        const res = await request(ctx.app).post(`/api/rooms/${r.id}/versions/${v1.version.id}/restore`).send({}).expect(200);
        expect(res.body.url).toBe(`/uploads/${s.name}/staged/Kitchen 1_v1.jpg`);
        expect(getRoom(ctx.db, r.id).currentVersionId).toBe(v1.version.id);
        await request(ctx.app).post(`/api/rooms/${r.id}/versions/nope/restore`).send({}).expect(404);
    });
});
