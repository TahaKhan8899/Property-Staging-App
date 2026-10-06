import express from 'express';
import cors from 'cors';
import db from './db.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { ZipArchive } from 'archiver';
import { fileURLToPath, URL } from 'url';
import { registerGeminiRoutes } from './geminiRoutes.js';
import { isGeminiConfigured } from './gemini.js';
import { computeCallCost } from '../shared/gemini-core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// GEMINI_API_KEY lives in .env.local (shared with Vite). Tests set STAGING_DB_PATH and must never pick up the real key.
if (!process.env.STAGING_DB_PATH) {
    try {
        process.loadEnvFile(path.resolve(__dirname, '../.env.local'));
    } catch {
        // no .env.local: the key may come from the environment
    }
}

// Root of all session folders. STAGING_UPLOADS_ROOT lets tests point at a temp folder.
const UPLOADS_ROOT = process.env.STAGING_UPLOADS_ROOT || path.join(__dirname, 'uploads');

const SESSION_STATUS_VALUES = new Set(['not_started', 'in_progress', 'completed']);
const normalizeSessionStatus = (value = '') => {
    if (typeof value !== 'string') return 'not_started';
    const normalized = value.toLowerCase();
    return SESSION_STATUS_VALUES.has(normalized) ? normalized : 'not_started';
};

const ROOM_STATUS_VALUES = new Set(['in_progress', 'done']);
const normalizeRoomStatus = (value = '') => {
    if (typeof value !== 'string') return 'in_progress';
    const normalized = value.toLowerCase();
    return ROOM_STATUS_VALUES.has(normalized) ? normalized : 'in_progress';
};

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- Helpers ---

// Sanitize string for folder/file names
// Remove special chars, allow typical name chars. 
const sanitizeName = (name) => {
    // Basic sanitization: specific allow list or black list.
    // Allow: alphanum, space, dash, underscore, parens.
    return name.replace(/[^a-zA-Z0-9 \-_\(\)]/g, '').trim();
};

// Normalize whatever is stored in DB (relative path, /uploads prefix, or full URL)
const normalizeStoredUploadPath = (storedPath = '') => {
    if (!storedPath) return '';

    let cleaned = storedPath.replace(/\\/g, '/').trim();

    if (/^https?:\/\//i.test(cleaned)) {
        try {
            const parsed = new URL(cleaned);
            cleaned = parsed.pathname || '';
        } catch {
            cleaned = cleaned.replace(/^https?:\/\/[^/]+/, '');
        }
    }

    cleaned = cleaned.replace(/^\/+/, '');
    if (cleaned.startsWith('uploads/')) {
        cleaned = cleaned.slice('uploads/'.length);
    }
    cleaned = cleaned.replace(/^\/+/, '');

    try {
        cleaned = decodeURIComponent(cleaned);
    } catch {
        // ignore decode issues, fall back to raw string
    }

    return cleaned;
};

// Resolve a stored path to an absolute file on disk under /uploads
const getUploadFilePath = (storedPath = '') => {
    const relative = normalizeStoredUploadPath(storedPath);
    if (!relative) return null;
    return path.join(UPLOADS_ROOT, relative);
};

// Convert stored path to a URL the client can consume
const getPublicUploadUrl = (storedPath = '') => {
    if (!storedPath) return '';
    if (storedPath.startsWith('data:')) return storedPath;
    if (/^https?:\/\//i.test(storedPath)) return storedPath;

    const relative = normalizeStoredUploadPath(storedPath);
    return relative ? `/uploads/${relative}` : '';
};

// Prompt snapshot helpers allow us to store JSON safely while remaining backwards compatible
const stringifyPromptSnapshot = (snapshot) => {
    if (snapshot === undefined || snapshot === null) return null;
    if (typeof snapshot === 'string') return snapshot;
    try {
        return JSON.stringify(snapshot);
    } catch {
        return null;
    }
};

const parsePromptSnapshot = (raw) => {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

// Delivery compression shared by the per-image download and the compressed zip, so both stay identical
const compressForDelivery = (inputPath) => sharp(inputPath).jpeg({ quality: 50, mozjpeg: true });

// Get Session Folder Path
const getSessionFolderPath = (sessionName) => {
    const safeName = sanitizeName(sessionName || 'Untitled Session');
    return path.join(UPLOADS_ROOT, safeName);
};

// Ensure directories exist
const ensureDirectories = (sessionPath) => {
    const original = path.join(sessionPath, 'original');
    const staged = path.join(sessionPath, 'staged');
    const stagedCompressed = path.join(sessionPath, 'staged-compressed');
    [original, staged, stagedCompressed].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
    return { original, staged, stagedCompressed };
};

// Final approved images live in <session>/output/<Room N>.<ext> (one file per room, no version suffix)
const getOutputDir = (sessionName) => path.join(getSessionFolderPath(sessionName), 'output');

// Filename this room has in output/. Rooms added before outputFileName existed fall back to the old naming.
const getRoomOutputFileName = (room) => {
    if (room.outputFileName) return room.outputFileName;
    if (!room.outputSourcePath) return null;
    return `${path.basename(room.filePath, path.extname(room.filePath))}${path.extname(room.outputSourcePath)}`;
};

// Remove only this room's own output file (never another room's, even if original names collide)
const removeRoomOutputFile = (sessionName, room) => {
    const fileName = getRoomOutputFileName(room);
    if (!fileName) return;
    const target = path.join(getOutputDir(sessionName), fileName);
    if (fs.existsSync(target)) fs.unlinkSync(target);
};

// Next unused "<Room Type> N" index in a session. Counting rooms is not enough: after a room is
// deleted (or its type changed) count+1 lands on a name that is still taken, and the new upload
// overwrites that room's original. So take max(existing N) + 1 across DB rows and files on disk
// (original/ and staged/, where files look like "Kitchen 3_v2.jpg").
const getNextRoomIndex = (sessionId, sessionName, safeRoomType) => {
    const escapedType = safeRoomType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escapedType} (\\d+)(?:_v\\d+)?$`, 'i');
    let maxIndex = 0;
    const consider = (baseName) => {
        const match = pattern.exec(baseName);
        if (match) maxIndex = Math.max(maxIndex, parseInt(match[1], 10));
    };

    db.prepare('SELECT filePath FROM rooms WHERE sessionId = ?').all(sessionId).forEach(room => {
        if (room.filePath) consider(path.basename(room.filePath, path.extname(room.filePath)));
    });
    ['original', 'staged'].forEach(subfolder => {
        const dir = path.join(getSessionFolderPath(sessionName), subfolder);
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(file => consider(path.basename(file, path.extname(file))));
    });
    return maxIndex + 1;
};

// Configure Multer (Temp storage)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const tempDir = path.join(UPLOADS_ROOT, 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        cb(null, tempDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// Serve static files
app.use('/uploads', express.static(UPLOADS_ROOT));

// Test route
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', geminiKeyConfigured: isGeminiConfigured() });
});

// --- Sessions ---

app.get('/api/sessions', (req, res) => {
    try {
        const sessions = db.prepare('SELECT * FROM sessions ORDER BY sortOrder ASC, lastModified DESC').all();
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sessions', (req, res) => {
    try {
        const { id, name, lastModified, status } = req.body;
        const safeLastModified = lastModified ?? Date.now();
        const safeStatus = normalizeSessionStatus(status);
        const highestSortOrder = db.prepare('SELECT COALESCE(MAX(sortOrder), -1) as maxOrder FROM sessions').get();
        const nextSortOrder = (highestSortOrder?.maxOrder ?? -1) + 1;
        db.prepare('INSERT INTO sessions (id, name, lastModified, status, sortOrder) VALUES (?, ?, ?, ?, ?)')
            .run(id, name, safeLastModified, safeStatus, nextSortOrder);

        // Create folder structure immediately
        if (name) {
            ensureDirectories(getSessionFolderPath(name));
        }

        res.json({ success: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/sessions/reorder', (req, res) => {
    try {
        const { orderedIds } = req.body;
        if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
            return res.status(400).json({ error: 'orderedIds must be a non-empty array' });
        }

        const updateStmt = db.prepare('UPDATE sessions SET sortOrder = ? WHERE id = ?');
        const transaction = db.transaction((ids) => {
            ids.forEach((sessionId, index) => {
                updateStmt.run(index, sessionId);
            });
        });
        transaction(orderedIds);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/sessions/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { name, lastModified, status } = req.body;

        const currentSession = db.prepare('SELECT name FROM sessions WHERE id = ?').get(id);
        if (!currentSession) return res.status(404).json({ error: 'Session not found' });

        // Handle Folder Rename if name changes
        if (name && name !== currentSession.name) {
            const oldPath = getSessionFolderPath(currentSession.name);
            const newPath = getSessionFolderPath(name);
            const oldSanitizedName = sanitizeName(currentSession.name);
            const newSanitizedName = sanitizeName(name);

            // If old path exists, try to rename
            if (fs.existsSync(oldPath)) {
                if (!fs.existsSync(newPath)) {
                    // Simple Rename
                    fs.renameSync(oldPath, newPath);

                    // Update database paths for all rooms and image versions
                    // Update rooms table - filePath and generatedImageUrl
                    const roomsToUpdate = db.prepare('SELECT id, filePath, generatedImageUrl FROM rooms WHERE sessionId = ?').all(id);
                    const updateRoomStmt = db.prepare('UPDATE rooms SET filePath = ?, generatedImageUrl = ? WHERE id = ?');

                    roomsToUpdate.forEach(room => {
                        let newFilePath = room.filePath;
                        let newGeneratedImageUrl = room.generatedImageUrl;

                        // Update filePath - handle both relative paths and full URLs
                        if (room.filePath) {
                            if (room.filePath.startsWith(oldSanitizedName + '/')) {
                                // Relative path: "BTR-B1/original/..."
                                newFilePath = room.filePath.replace(oldSanitizedName + '/', newSanitizedName + '/');
                            } else if (room.filePath.includes(`/uploads/${oldSanitizedName}/`)) {
                                // Full URL: "http://localhost:3001/uploads/BTR-B1/..."
                                newFilePath = room.filePath.replace(`/uploads/${oldSanitizedName}/`, `/uploads/${newSanitizedName}/`);
                            }
                        }

                        // Update generatedImageUrl - handle both relative paths and full URLs
                        if (room.generatedImageUrl) {
                            if (room.generatedImageUrl.startsWith(oldSanitizedName + '/')) {
                                // Relative path: "BTR-B1/staged/..."
                                newGeneratedImageUrl = room.generatedImageUrl.replace(oldSanitizedName + '/', newSanitizedName + '/');
                            } else if (room.generatedImageUrl.includes(`/uploads/${oldSanitizedName}/`)) {
                                // Full URL: "http://localhost:3001/uploads/BTR-B1/..."
                                newGeneratedImageUrl = room.generatedImageUrl.replace(`/uploads/${oldSanitizedName}/`, `/uploads/${newSanitizedName}/`);
                            }
                        }

                        updateRoomStmt.run(newFilePath, newGeneratedImageUrl, room.id);
                    });

                    // Update image_versions table - url
                    const versionsToUpdate = db.prepare('SELECT id, url FROM image_versions WHERE roomId IN (SELECT id FROM rooms WHERE sessionId = ?)').all(id);
                    const updateVersionStmt = db.prepare('UPDATE image_versions SET url = ? WHERE id = ?');

                    versionsToUpdate.forEach(version => {
                        if (version.url) {
                            let newUrl = version.url;
                            if (version.url.startsWith(oldSanitizedName + '/')) {
                                // Relative path: "BTR-B1/staged/..."
                                newUrl = version.url.replace(oldSanitizedName + '/', newSanitizedName + '/');
                            } else if (version.url.includes(`/uploads/${oldSanitizedName}/`)) {
                                // Full URL: "http://localhost:3001/uploads/BTR-B1/..."
                                newUrl = version.url.replace(`/uploads/${oldSanitizedName}/`, `/uploads/${newSanitizedName}/`);
                            }
                            updateVersionStmt.run(newUrl, version.id);
                        }
                    });
                } else {
                    // Collision or Target exists. 
                    // Strategy: Merge? Or just ignore moving?
                    // User requested enforcing uniqueness, but here we are in a patch renaming event.
                    // If target exists, we probably shouldn't rename nicely without conflict.
                    // But for now, we will assume user knows what they are doing or handle it gracefully by NOT overwriting.
                    console.warn(`Cannot rename folder "${oldPath}" to "${newPath}" because target exists.`);
                }
            } else {
                // Create new if old didn't exist
                ensureDirectories(newPath);
            }
        }

        const updates = [];
        const params = { id };

        if (name !== undefined) {
            updates.push('name = @name');
            params.name = name;
        }
        if (lastModified !== undefined) {
            updates.push('lastModified = @lastModified');
            params.lastModified = lastModified;
        }
        if (status !== undefined) {
            updates.push('status = @status');
            params.status = normalizeSessionStatus(status);
        }

        if (updates.length > 0) {
            const query = `UPDATE sessions SET ${updates.join(', ')} WHERE id = @id`;
            db.prepare(query).run(params);
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/sessions/:id', (req, res) => {
    try {
        const { id } = req.params;
        const session = db.prepare('SELECT name FROM sessions WHERE id = ?').get(id);

        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);

        if (session) {
            const folderPath = getSessionFolderPath(session.name);
            if (fs.existsSync(folderPath)) {
                fs.rmSync(folderPath, { recursive: true, force: true });
            }
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download the session's output/ folder as one zip: staged files as-is, or compressed for delivery
app.get('/api/sessions/:id/export', async (req, res) => {
    try {
        const { id } = req.params;
        const variant = req.query.variant === 'compressed' ? 'compressed' : 'staged';
        const session = db.prepare('SELECT name FROM sessions WHERE id = ?').get(id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const outputDir = getOutputDir(session.name);
        const files = fs.existsSync(outputDir)
            ? fs.readdirSync(outputDir).filter(f => !f.startsWith('.') && fs.statSync(path.join(outputDir, f)).isFile()).sort()
            : [];
        if (files.length === 0) return res.status(404).json({ error: 'No images in output' });

        const zipName = `${sanitizeName(session.name)} - ${variant === 'compressed' ? 'Compressed' : 'Staged'}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"; filename*=UTF-8''${encodeURIComponent(zipName)}`);

        const archive = new ZipArchive({ zlib: { level: 0 } }); // JPEGs don't deflate; store is faster
        archive.on('error', (err) => {
            console.error('Export zip error:', err);
            res.destroy(err);
        });
        archive.pipe(res);

        const usedNames = new Set();
        for (const file of files) {
            const filePath = path.join(outputDir, file);
            if (variant === 'compressed') {
                // Compressed output is always JPEG, so keep the name but use .jpg ("Kitchen 1.png" and
                // "Kitchen 1.jpg" can both be in output/, so suffix a repeat)
                const base = path.basename(file, path.extname(file));
                let name = `${base}.jpg`;
                for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${base} (${n}).jpg`;
                usedNames.add(name.toLowerCase());
                archive.append(await compressForDelivery(filePath).toBuffer(), { name });
            } else {
                archive.file(filePath, { name: file });
            }
        }
        await archive.finalize();
    } catch (err) {
        console.error('Export error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else res.destroy(err);
    }
});

// --- API Usage / Cost Tracking ---

// One api_calls row; the session is resolved from the room so callers only need roomId
const insertApiCall = (c) => {
    const session = c.roomId
        ? db.prepare('SELECT s.id, s.name FROM rooms r JOIN sessions s ON s.id = r.sessionId WHERE r.id = ?').get(c.roomId)
        : null;
    db.prepare(`
        INSERT INTO api_calls (id, timestamp, sessionId, sessionName, roomId, kind, model, status, error,
            promptTokens, textOutputTokens, thoughtsTokens, imageOutputTokens, imageCount, costUsd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        crypto.randomUUID(), Date.now(), session?.id ?? null, session?.name ?? null, c.roomId ?? null,
        c.kind, c.model, c.status, c.error ?? null,
        c.promptTokens ?? 0, c.textOutputTokens ?? 0, c.thoughtsTokens ?? 0, c.imageOutputTokens ?? 0,
        c.imageCount ?? 0, c.costUsd ?? 0
    );
};

app.post('/api/usage', (req, res) => {
    try {
        insertApiCall(req.body || {});
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sessions/:id/usage', (req, res) => {
    try {
        const { id } = req.params;
        const totals = db.prepare(`
            SELECT COUNT(*) AS calls, COALESCE(SUM(costUsd), 0) AS costUsd,
                   COALESCE(SUM(status = 'error'), 0) AS failedCalls
            FROM api_calls WHERE sessionId = ?
        `).get(id);
        const byKind = db.prepare(`
            SELECT kind, model, COUNT(*) AS calls, SUM(costUsd) AS costUsd
            FROM api_calls WHERE sessionId = ? GROUP BY kind, model ORDER BY costUsd DESC
        `).all(id);
        const byRoom = db.prepare(`
            SELECT roomId, COUNT(*) AS calls, SUM(costUsd) AS costUsd
            FROM api_calls WHERE sessionId = ? GROUP BY roomId
        `).all(id);
        res.json({ ...totals, byKind, byRoom });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Rooms ---

app.get('/api/sessions/:id/rooms', (req, res) => {
    try {
        const { id } = req.params;
        const rooms = db.prepare('SELECT * FROM rooms WHERE sessionId = ?').all(id);

        const boolFields = ['isGeneratingPrompt', 'isPromptApproved', 'isGeneratingImage'];
        const processedRooms = rooms.map(room => {
            const r = { ...room };
            boolFields.forEach(f => {
                r[f] = !!r[f];
            });

            if (r.filePath) {
                const publicOriginal = getPublicUploadUrl(r.filePath);
                if (publicOriginal) r.filePath = publicOriginal;
            }
            if (r.generatedImageUrl) {
                const publicStaged = getPublicUploadUrl(r.generatedImageUrl);
                if (publicStaged) r.generatedImageUrl = publicStaged;
            }
            r.roomStatus = normalizeRoomStatus(r.roomStatus);
            return r;
        });

        res.json(processedRooms);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Handle Upload with Naming Logic
app.post('/api/rooms', upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const { id, sessionId, roomType, customLabel, roomStatus } = req.body;
        const normalizedRoomStatus = normalizeRoomStatus(roomStatus);

        // 1. Get Session Info
        const session = db.prepare('SELECT name FROM sessions WHERE id = ?').get(sessionId);
        if (!session) {
            fs.unlinkSync(req.file.path); // clean temp
            return res.status(404).json({ error: 'Session not found' });
        }

        // 2. Determine "N"
        // Pattern: roomType equals the uploaded roomType
        const safeRoomType = sanitizeName(roomType);
        const nextIndex = getNextRoomIndex(sessionId, session.name, safeRoomType);

        // 3. Generate Name
        // e.g. "Bedroom 1.jpg"
        const ext = path.extname(req.file.originalname) || '.jpg';
        const newFileName = `${safeRoomType} ${nextIndex}${ext}`;

        // 4. Move File
        const safeSessionName = sanitizeName(session.name);
        const { original } = ensureDirectories(getSessionFolderPath(session.name));
        const targetPath = path.join(original, newFileName);

        // Handle collision: If file exists, overwrite.
        // Rename moves the file from temp to target
        fs.renameSync(req.file.path, targetPath);

        // 5. Save Relative Path to DB
        // "Unit A/original/Bedroom 1.jpg"
        // Note: We use forward slashes for DB path consistency usually, providing path.join matches OS.
        // But for URL serving, we want forward slashes. 
        // path.join might give backslashes on Window, but we are on Mac.
        const relativePath = path.join(safeSessionName, 'original', newFileName);

        const data = {
            id: id,
            sessionId,
            roomType,
            customLabel: customLabel || '',
            filePath: relativePath,
            generatedPrompt: '',
            initialPrompt: '',
            isGeneratingPrompt: 0,
            isPromptApproved: 0,
            generatedImageUrl: '',
            isGeneratingImage: 0,
            error: '',
            roomStatus: normalizedRoomStatus
        };

        const stmt = db.prepare(`
            INSERT INTO rooms (
                id, sessionId, roomType, customLabel, filePath, 
                generatedPrompt, initialPrompt, isGeneratingPrompt, isPromptApproved, 
                generatedImageUrl, isGeneratingImage, error, roomStatus
            ) VALUES (
                @id, @sessionId, @roomType, @customLabel, @filePath, 
                @generatedPrompt, @initialPrompt, @isGeneratingPrompt, @isPromptApproved, 
                @generatedImageUrl, @isGeneratingImage, @error, @roomStatus
            )
        `);
        stmt.run(data);

        res.json({ success: true, id: data.id, filePath: `/uploads/${relativePath}` });
    } catch (err) {
        console.error("Upload error:", err);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: err.message });
    }
});

// Write a generated image buffer into staged/ as the room's next version and make it current.
// Shared by the client-facing /generated route and the server-side Gemini routes.
// Throws an Error with .status = 404 when the room does not exist.
const saveGeneratedBuffer = (id, buffer, description, promptSnapshot) => {
    // 1. Get Room Info
    const room = db.prepare('SELECT r.*, s.name as sessionName FROM rooms r JOIN sessions s ON r.sessionId = s.id WHERE r.id = ?').get(id);
    if (!room) throw Object.assign(new Error('Room not found'), { status: 404 });

    // 2. Check if there's an existing image without a version entry (backward compatibility)
    const existingVersions = db.prepare('SELECT COUNT(*) as count FROM image_versions WHERE roomId = ?').get(id);

    // If room has a generatedImageUrl but no versions, create version 0 for the existing image
    const fallbackPrompt = room.generatedPrompt || room.initialPrompt || null;

    if (existingVersions.count === 0 && room.generatedImageUrl) {
        const version0Id = crypto.randomUUID();
        const version0Prompt = stringifyPromptSnapshot({
            basePrompt: fallbackPrompt,
            source: 'backfill'
        });
        db.prepare(`
            INSERT INTO image_versions (id, roomId, url, timestamp, description, versionNumber, promptSnapshot)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(version0Id, id, room.generatedImageUrl, Date.now() - 1000, 'Initial generation', 1, version0Prompt);
    }

    // 3. Determine version number for new image
    const versionCount = db.prepare('SELECT COUNT(*) as count FROM image_versions WHERE roomId = ?').get(id);
    const versionNumber = versionCount.count + 1;

    // 4. Generate filename with version
    const originalFileName = path.basename(room.filePath);
    const originalBase = path.basename(originalFileName, path.extname(originalFileName));
    const newFileName = `${originalBase}_v${versionNumber}.jpg`;

    const safeSessionName = sanitizeName(room.sessionName);
    const { staged } = ensureDirectories(getSessionFolderPath(room.sessionName));
    const targetPath = path.join(staged, newFileName);

    // 5. Write File
    fs.writeFileSync(targetPath, buffer);

    // 6. Create version entry
    const versionId = crypto.randomUUID();
    const relativePath = path.join(safeSessionName, 'staged', newFileName);
    const timestamp = Date.now();

    const snapshotPayload = promptSnapshot ?? (fallbackPrompt ? { basePrompt: fallbackPrompt, source: 'generate' } : null);
    const promptJson = stringifyPromptSnapshot(snapshotPayload);

    db.prepare(`
        INSERT INTO image_versions (id, roomId, url, timestamp, description, versionNumber, promptSnapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(versionId, id, relativePath, timestamp, description || 'Generated image', versionNumber, promptJson);

    // 7. Update Room
    db.prepare('UPDATE rooms SET generatedImageUrl = ?, currentVersionId = ? WHERE id = ?')
        .run(relativePath, versionId, id);

    return {
        url: `/uploads/${relativePath}`,
        version: {
            id: versionId,
            versionNumber,
            timestamp,
            description: description || 'Generated image',
            promptSnapshot: parsePromptSnapshot(promptJson)
        }
    };
};

// Save Generated Image to Disk with Versioning
app.post('/api/rooms/:id/generated', (req, res) => {
    try {
        const { id } = req.params;
        const { imageBase64, description, promptSnapshot } = req.body;

        if (!imageBase64) return res.status(400).json({ error: 'No image data' });

        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const saved = saveGeneratedBuffer(id, Buffer.from(base64Data, 'base64'), description, promptSnapshot);
        res.json({ success: true, ...saved });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: err.message });
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Upload External Staged Image (e.g., Canva edits)
app.post('/api/rooms/:id/upload-staged', upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const { id } = req.params;
        const promptSnapshotRaw = req.body?.promptSnapshot ? (() => {
            try {
                return JSON.parse(req.body.promptSnapshot);
            } catch {
                return req.body.promptSnapshot;
            }
        })() : null;

        // 1. Get Room Info
        const room = db.prepare('SELECT r.*, s.name as sessionName FROM rooms r JOIN sessions s ON r.sessionId = s.id WHERE r.id = ?').get(id);
        if (!room) {
            fs.unlinkSync(req.file.path); // clean temp
            return res.status(404).json({ error: 'Room not found' });
        }

        // 2. Check if there's an existing image without a version entry (backward compatibility)
        const existingVersions = db.prepare('SELECT COUNT(*) as count FROM image_versions WHERE roomId = ?').get(id);

        // If room has a generatedImageUrl but no versions, create version 0 for the existing image
        const fallbackPrompt = room.generatedPrompt || room.initialPrompt || null;

        if (existingVersions.count === 0 && room.generatedImageUrl) {
            const version0Id = crypto.randomUUID();
            const version0Prompt = stringifyPromptSnapshot({
                basePrompt: fallbackPrompt,
                source: 'backfill'
            });
            db.prepare(`
                INSERT INTO image_versions (id, roomId, url, timestamp, description, versionNumber, promptSnapshot)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(version0Id, id, room.generatedImageUrl, Date.now() - 1000, 'Initial generation', 1, version0Prompt);
        }

        // 3. Determine version number for new image
        const versionCount = db.prepare('SELECT COUNT(*) as count FROM image_versions WHERE roomId = ?').get(id);
        const versionNumber = versionCount.count + 1;

        // 4. Generate filename with version
        const originalFileName = path.basename(room.filePath);
        const originalBase = path.basename(originalFileName, path.extname(originalFileName));
        const uploadExt = path.extname(req.file.originalname) || '.jpg';
        const newFileName = `${originalBase}_v${versionNumber}${uploadExt}`;

        const safeSessionName = sanitizeName(room.sessionName);
        const { staged } = ensureDirectories(getSessionFolderPath(room.sessionName));
        const targetPath = path.join(staged, newFileName);

        // 5. Move uploaded file from temp to staged folder
        fs.renameSync(req.file.path, targetPath);

        // 6. Create version entry
        const versionId = crypto.randomUUID();
        const relativePath = path.join(safeSessionName, 'staged', newFileName);
        const timestamp = Date.now();

        const snapshotPayload = promptSnapshotRaw ?? (fallbackPrompt ? { basePrompt: fallbackPrompt, source: 'upload-staged' } : { source: 'upload-staged' });
        const promptJson = stringifyPromptSnapshot(snapshotPayload);

        db.prepare(`
            INSERT INTO image_versions (id, roomId, url, timestamp, description, versionNumber, promptSnapshot)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(versionId, id, relativePath, timestamp, 'Uploaded external image', versionNumber, promptJson);

        // 7. Update Room
        db.prepare('UPDATE rooms SET generatedImageUrl = ?, currentVersionId = ? WHERE id = ?')
            .run(relativePath, versionId, id);

        res.json({
            success: true,
            url: `/uploads/${relativePath}`,
            version: {
                id: versionId,
                versionNumber,
                timestamp,
                description: 'Uploaded external image',
                promptSnapshot: parsePromptSnapshot(promptJson)
            }
        });

    } catch (err) {
        console.error('Upload staged error:', err);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/rooms/:id', (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        if (updates.roomStatus !== undefined) {
            updates.roomStatus = normalizeRoomStatus(updates.roomStatus);
        }

        // Edge Case: If RoomType changes, we should rename the file.
        // e.g. "Bedroom 1" -> "Living Room 1"
        // To simplify, we will restrict Room Type changes for now or handle it carefully.
        // If we handle it: 
        // 1. Get current room data (sessionId, currentType, currentFilePath).
        // 2. Determine new name.
        // 3. Rename file.
        // 4. Update filePath in `updates`.

        // Implementation of RoomType Rename:
        if (updates.roomType) {
            const currentRoom = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
            if (currentRoom && currentRoom.roomType !== updates.roomType) {
                const session = db.prepare('SELECT name FROM sessions WHERE id = ?').get(currentRoom.sessionId);
                const safeSessionName = sanitizeName(session.name);
                const sessionPath = getSessionFolderPath(session.name);

                // Get Original Extension
                const ext = path.extname(currentRoom.filePath);

                // Determine next index for NEW room type
                const nextIndex = getNextRoomIndex(currentRoom.sessionId, session.name, sanitizeName(updates.roomType));
                const newFileName = `${updates.roomType} ${nextIndex}${ext}`;

                const oldFullPath = getUploadFilePath(currentRoom.filePath);
                const newFullPath = path.join(sessionPath, 'original', newFileName);

                if (oldFullPath && fs.existsSync(oldFullPath)) {
                    fs.renameSync(oldFullPath, newFullPath);

                    // Also handle staged file if exists
                    if (currentRoom.generatedImageUrl && !currentRoom.generatedImageUrl.startsWith('data:')) {
                        const oldStaged = getUploadFilePath(currentRoom.generatedImageUrl);
                        // assume jpg for staged
                        const stagedExt = path.extname(currentRoom.generatedImageUrl) || '.jpg';
                        const newStagedName = `${updates.roomType} ${nextIndex}${stagedExt}`;
                        const newStagedPath = path.join(sessionPath, 'staged', newStagedName);
                        if (oldStaged && fs.existsSync(oldStaged)) {
                            fs.renameSync(oldStaged, newStagedPath);
                            updates.generatedImageUrl = path.join(safeSessionName, 'staged', newStagedName);
                        }
                    }

                    updates.filePath = path.join(safeSessionName, 'original', newFileName);
                }
            }
        }

        const keys = Object.keys(updates);
        if (keys.length === 0) return res.json({ success: true });

        const safeUpdates = {};
        const allowedCols = [
            'roomType', 'customLabel', 'generatedPrompt', 'initialPrompt',
            'isGeneratingPrompt', 'isPromptApproved', 'generatedImageUrl',
            'isGeneratingImage', 'error', 'filePath', 'roomStatus', 'referenceRoomId' // filePath allowed for internal update
        ];

        keys.forEach(k => {
            if (allowedCols.includes(k)) {
                safeUpdates[k] = updates[k];
            }
        });

        const updateKeys = Object.keys(safeUpdates);
        if (updateKeys.length === 0) return res.json({ success: true });

        const setClause = updateKeys.map(k => `${k} = @${k}`).join(', ');
        const query = `UPDATE rooms SET ${setClause} WHERE id = @id`;

        ['isGeneratingPrompt', 'isPromptApproved', 'isGeneratingImage'].forEach(f => {
            if (f in safeUpdates) safeUpdates[f] = safeUpdates[f] ? 1 : 0;
        });

        const data = { ...safeUpdates, id };
        db.prepare(query).run(data);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Get all versions for a room
app.get('/api/rooms/:id/versions', (req, res) => {
    try {
        const { id } = req.params;
        const versions = db.prepare('SELECT * FROM image_versions WHERE roomId = ? ORDER BY versionNumber ASC').all(id);

        // Normalize stored URLs so the client always gets something usable
        const processedVersions = versions.map(v => {
            const normalizedUrl = getPublicUploadUrl(v.url);
            return {
                ...v,
                url: normalizedUrl || v.url,
                promptSnapshot: parsePromptSnapshot(v.promptSnapshot)
            };
        });

        res.json(processedVersions);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Restore a specific version as current
app.post('/api/rooms/:id/versions/:versionId/restore', (req, res) => {
    try {
        const { id, versionId } = req.params;

        const version = db.prepare('SELECT * FROM image_versions WHERE id = ? AND roomId = ?').get(versionId, id);
        if (!version) return res.status(404).json({ error: 'Version not found' });

        db.prepare('UPDATE rooms SET generatedImageUrl = ?, currentVersionId = ? WHERE id = ?')
            .run(version.url, versionId, id);

        res.json({ success: true, url: getPublicUploadUrl(version.url) || version.url });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Download compressed version of current staged image
app.get('/api/rooms/:id/download-compressed', async (req, res) => {
    try {
        const { id } = req.params;

        // Get room info
        const room = db.prepare('SELECT r.*, s.name as sessionName FROM rooms r JOIN sessions s ON r.sessionId = s.id WHERE r.id = ?').get(id);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        if (!room.generatedImageUrl) return res.status(404).json({ error: 'No staged image found' });

        // Construct full path to the staged image
        const imagePath = getUploadFilePath(room.generatedImageUrl);
        if (!imagePath || !fs.existsSync(imagePath)) {
            console.warn('download-compressed missing file', {
                roomId: id,
                storedPath: room.generatedImageUrl,
                resolvedPath: imagePath
            });
            return res.status(404).json({ error: 'Image file not found on disk' });
        }

        const sessionPath = getSessionFolderPath(room.sessionName);
        const { stagedCompressed } = ensureDirectories(sessionPath);

        // Generate filename for download + storage. Rooms in a session can share an original name
        // (e.g. two "Kitchen 3"), so the 2nd+ one gets " (2)", " (3)" by creation order.
        const originalBase = path.basename(room.filePath, path.extname(room.filePath));
        const sameNamed = db.prepare('SELECT id, filePath FROM rooms WHERE sessionId = ? ORDER BY rowid').all(room.sessionId)
            .filter(r => r.filePath && path.basename(r.filePath, path.extname(r.filePath)).toLowerCase() === originalBase.toLowerCase());
        const position = Math.max(0, sameNamed.findIndex(r => r.id === id));
        const suffix = position > 0 ? ` (${position + 1})` : '';
        const downloadFileName = `${originalBase}${suffix}_compressed.jpg`;
        const compressedPath = path.join(stagedCompressed, downloadFileName);

        // Always recompress from the currently selected version. A cached copy can be stale when an
        // older version is restored (its mtime is older than the cached file), and it's only ~1s.
        await compressForDelivery(imagePath).toFile(compressedPath);

        // Return redirect to the compressed file so browser just opens it
        const relativeCompressedPath = path.relative(UPLOADS_ROOT, compressedPath).replace(/\\/g, '/');
        const publicUrl = `/uploads/${relativeCompressedPath}`;

        return res.redirect(publicUrl);

    } catch (err) {
        console.error('Compression error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

// Copy the currently displayed staged version into the session's output folder
app.post('/api/rooms/:id/output', (req, res) => {
    try {
        const { id } = req.params;
        const room = db.prepare('SELECT r.*, s.name as sessionName FROM rooms r JOIN sessions s ON r.sessionId = s.id WHERE r.id = ?').get(id);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        if (!room.generatedImageUrl) return res.status(404).json({ error: 'No staged image found' });

        const sourcePath = getUploadFilePath(room.generatedImageUrl);
        if (!sourcePath || !fs.existsSync(sourcePath)) {
            return res.status(404).json({ error: 'Image file not found on disk' });
        }

        const baseName = path.basename(room.filePath, path.extname(room.filePath));
        const outputDir = getOutputDir(room.sessionName);
        fs.mkdirSync(outputDir, { recursive: true });

        // Drop this room's previous output file, then pick a name no other room is using
        removeRoomOutputFile(room.sessionName, room);
        const ext = path.extname(sourcePath) || '.jpg';
        let fileName = `${baseName}${ext}`;
        for (let n = 2; fs.existsSync(path.join(outputDir, fileName)); n++) {
            fileName = `${baseName} (${n})${ext}`;
        }
        fs.copyFileSync(sourcePath, path.join(outputDir, fileName));

        // Session-relative (e.g. "staged/Living Room 1_v2.jpg") so it survives session renames
        const outputSourcePath = normalizeStoredUploadPath(room.generatedImageUrl).split('/').slice(1).join('/');
        db.prepare('UPDATE rooms SET outputSourcePath = ?, outputFileName = ? WHERE id = ?').run(outputSourcePath, fileName, id);

        res.json({ success: true, outputSourcePath, fileName });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Remove a room's image from the output folder
app.delete('/api/rooms/:id/output', (req, res) => {
    try {
        const { id } = req.params;
        const room = db.prepare('SELECT r.filePath, r.outputFileName, r.outputSourcePath, s.name as sessionName FROM rooms r JOIN sessions s ON r.sessionId = s.id WHERE r.id = ?').get(id);
        if (!room) return res.status(404).json({ error: 'Room not found' });

        removeRoomOutputFile(room.sessionName, room);
        db.prepare('UPDATE rooms SET outputSourcePath = NULL, outputFileName = NULL WHERE id = ?').run(id);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/rooms/:id', (req, res) => {
    try {
        const { id } = req.params;
        const room = db.prepare('SELECT r.filePath, r.generatedImageUrl, r.outputFileName, r.outputSourcePath, s.name as sessionName FROM rooms r JOIN sessions s ON r.sessionId = s.id WHERE r.id = ?').get(id);

        db.prepare('DELETE FROM rooms WHERE id = ?').run(id);

        if (room) {
            // Delete Original
            if (room.filePath) {
                const fullPath = getUploadFilePath(room.filePath);
                if (fullPath && fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
            }
            // Delete Staged
            if (room.generatedImageUrl && !room.generatedImageUrl.startsWith('data:')) {
                const fullPath = getUploadFilePath(room.generatedImageUrl);
                if (fullPath && fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
            }
            // Delete Output copy
            removeRoomOutputFile(room.sessionName, room);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

registerGeminiRoutes(app, {
    db,
    getUploadFilePath,
    saveGeneratedBuffer,
    insertApiCall: ({ roomId, kind, model, usage, imageCount, error }) => insertApiCall({
        roomId,
        kind,
        model,
        status: error ? 'error' : 'ok',
        error: error ? (error instanceof Error ? error.message : String(error)).slice(0, 500) : undefined,
        imageCount,
        ...computeCallCost(model, usage, imageCount)
    })
});

export const startServer = (port = 3001) => app.listen(port, () => {
    // Nothing is running after a restart, so clear "generating" flags left by an interrupted run
    db.prepare('UPDATE rooms SET isGeneratingPrompt = 0, isGeneratingImage = 0 WHERE isGeneratingPrompt = 1 OR isGeneratingImage = 1').run();
    console.log(`Server running on http://localhost:${port}`);
});

// Still start when run directly (`node server/index.js`) so existing launch commands keep working.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
    startServer();
}

export default app;
