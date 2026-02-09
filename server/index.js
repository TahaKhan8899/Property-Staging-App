import express from 'express';
import cors from 'cors';
import db from './db.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { fileURLToPath, URL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const PORT = 3001;

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
    return path.join(__dirname, 'uploads', relative);
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

// Get Session Folder Path
const getSessionFolderPath = (sessionName) => {
    const safeName = sanitizeName(sessionName || 'Untitled Session');
    return path.join(__dirname, 'uploads', safeName);
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

// Configure Multer (Temp storage)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const tempDir = path.join(__dirname, 'uploads', 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        cb(null, tempDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// Serve static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Test route
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
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
        const existingRooms = db.prepare('SELECT COUNT(*) as count FROM rooms WHERE sessionId = ? AND roomType = ?').get(sessionId, roomType);
        const nextIndex = existingRooms.count + 1;

        // 3. Generate Name
        // e.g. "Bedroom 1.jpg"
        const ext = path.extname(req.file.originalname) || '.jpg';
        const safeRoomType = sanitizeName(roomType);
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

// Save Generated Image to Disk with Versioning
app.post('/api/rooms/:id/generated', (req, res) => {
    try {
        const { id } = req.params;
        const { imageBase64, description, promptSnapshot } = req.body;

        if (!imageBase64) return res.status(400).json({ error: 'No image data' });

        // 1. Get Room Info
        const room = db.prepare('SELECT r.*, s.name as sessionName FROM rooms r JOIN sessions s ON r.sessionId = s.id WHERE r.id = ?').get(id);
        if (!room) return res.status(404).json({ error: 'Room not found' });

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
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        fs.writeFileSync(targetPath, base64Data, { encoding: 'base64' });

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

        res.json({
            success: true,
            url: `/uploads/${relativePath}`,
            version: {
                id: versionId,
                versionNumber,
                timestamp,
                description: description || 'Generated image',
                promptSnapshot: parsePromptSnapshot(promptJson)
            }
        });

    } catch (err) {
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
                const countRes = db.prepare('SELECT COUNT(*) as count FROM rooms WHERE sessionId = ? AND roomType = ?').get(currentRoom.sessionId, updates.roomType);
                const nextIndex = countRes.count + 1;
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
            'isGeneratingImage', 'error', 'filePath', 'roomStatus' // filePath allowed for internal update
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

        // Generate filename for download + storage
        const originalFileName = path.basename(room.filePath);
        const originalBase = path.basename(originalFileName, path.extname(originalFileName));
        const downloadFileName = `${originalBase}_compressed.jpg`;
        const compressedPath = path.join(stagedCompressed, downloadFileName);

        // Create compressed copy on disk if missing or source newer
        let regenerateCompressed = true;
        if (fs.existsSync(compressedPath)) {
            try {
                const sourceStat = fs.statSync(imagePath);
                const compressedStat = fs.statSync(compressedPath);
                regenerateCompressed = sourceStat.mtimeMs > compressedStat.mtimeMs;
            } catch {
                regenerateCompressed = true;
            }
        }

        if (regenerateCompressed) {
            await sharp(imagePath)
                .jpeg({ quality: 50, mozjpeg: true })
                .toFile(compressedPath);
        }

        // Return redirect to the compressed file so browser just opens it
        const uploadsRoot = path.join(__dirname, 'uploads');
        const relativeCompressedPath = path.relative(uploadsRoot, compressedPath).replace(/\\/g, '/');
        const publicUrl = `/uploads/${relativeCompressedPath}`;

        return res.redirect(publicUrl);

    } catch (err) {
        console.error('Compression error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

app.delete('/api/rooms/:id', (req, res) => {
    try {
        const { id } = req.params;
        const room = db.prepare('SELECT filePath, generatedImageUrl FROM rooms WHERE id = ?').get(id);

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
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
