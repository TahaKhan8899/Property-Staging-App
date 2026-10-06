import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import request from 'supertest';

// Boot the Express app against a throwaway DB + uploads folder. Must run before server/index.js
// is first imported in the test file (db.js opens the file at import time).
export const bootApp = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-test-'));
    process.env.STAGING_DB_PATH = path.join(dir, 'test.sqlite');
    process.env.STAGING_UPLOADS_ROOT = path.join(dir, 'uploads');
    fs.mkdirSync(process.env.STAGING_UPLOADS_ROOT, { recursive: true });
    const { default: app } = await import('../index.js');
    const { default: db } = await import('../db.js');
    return {
        app,
        db,
        uploads: process.env.STAGING_UPLOADS_ROOT,
        cleanup: () => {
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
};

// Small noisy JPEG (noise so quality-50 recompression is measurably smaller)
export const makeJpeg = (width = 400, height = 225, seed = 1) => {
    const raw = Buffer.alloc(width * height * 3);
    let x = seed;
    for (let i = 0; i < raw.length; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        raw[i] = x & 0xff;
    }
    return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
};

export const toDataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;

let counter = 0;
export const createSession = async (app, name = `Set ${++counter}`) => {
    const id = `s-${counter++}`;
    await request(app).post('/api/sessions').send({ id, name }).expect(200);
    return { id, name };
};

export const uploadRoom = async (app, sessionId, roomType = 'Kitchen', jpeg) => {
    const id = `r-${roomType}-${counter++}`;
    const buf = jpeg ?? (await makeJpeg());
    const res = await request(app)
        .post('/api/rooms')
        .field('id', id)
        .field('sessionId', sessionId)
        .field('roomType', roomType)
        .attach('file', buf, 'photo.jpg')
        .expect(200);
    return { id, filePath: res.body.filePath };
};

export const saveGenerated = async (app, roomId, jpeg, extra = {}) => {
    const buf = jpeg ?? (await makeJpeg());
    const res = await request(app)
        .post(`/api/rooms/${roomId}/generated`)
        .send({ imageBase64: toDataUrl(buf), ...extra })
        .expect(200);
    return res.body;
};

export const getRoom = (db, id) => db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
