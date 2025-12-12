import express from 'express';
import cors from 'cors';
import db from './db.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Get Session Folder Path
const getSessionFolderPath = (sessionName) => {
    const safeName = sanitizeName(sessionName || 'Untitled Session');
    return path.join(__dirname, 'uploads', safeName);
};

// Ensure directories exist
const ensureDirectories = (sessionPath) => {
    const original = path.join(sessionPath, 'original');
    const staged = path.join(sessionPath, 'staged');
    if (!fs.existsSync(original)) fs.mkdirSync(original, { recursive: true });
    if (!fs.existsSync(staged)) fs.mkdirSync(staged, { recursive: true });
    return { original, staged };
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
        const sessions = db.prepare('SELECT * FROM sessions ORDER BY lastModified DESC').all();
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sessions', (req, res) => {
    try {
        const { id, name, lastModified } = req.body;
        db.prepare('INSERT INTO sessions (id, name, lastModified) VALUES (?, ?, ?)').run(id, name, lastModified);

        // Create folder structure immediately
        if (name) {
            ensureDirectories(getSessionFolderPath(name));
        }

        res.json({ success: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/sessions/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { name, lastModified } = req.body;

        const currentSession = db.prepare('SELECT name FROM sessions WHERE id = ?').get(id);
        if (!currentSession) return res.status(404).json({ error: 'Session not found' });

        // Handle Folder Rename if name changes
        if (name && name !== currentSession.name) {
            const oldPath = getSessionFolderPath(currentSession.name);
            const newPath = getSessionFolderPath(name);

            // If old path exists, try to rename
            if (fs.existsSync(oldPath)) {
                if (!fs.existsSync(newPath)) {
                    // Simple Rename
                    fs.renameSync(oldPath, newPath);
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

            // Construct Paths
            // stored filePath should be relative from uploads root? Or Session root?
            // "Unit A/original/Bedroom 1.jpg" is best for uniqueness.
            // We append /uploads/ for frontend serving.
            if (r.filePath && !r.filePath.startsWith('http')) {
                r.filePath = `/uploads/${r.filePath}`;
            }
            if (r.generatedImageUrl && !r.generatedImageUrl.startsWith('data:') && !r.generatedImageUrl.startsWith('http')) {
                r.generatedImageUrl = `/uploads/${r.generatedImageUrl}`;
            }
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

        const { id, sessionId, roomType, customLabel } = req.body;

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
            error: ''
        };

        const stmt = db.prepare(`
            INSERT INTO rooms (
                id, sessionId, roomType, customLabel, filePath, 
                generatedPrompt, initialPrompt, isGeneratingPrompt, isPromptApproved, 
                generatedImageUrl, isGeneratingImage, error
            ) VALUES (
                @id, @sessionId, @roomType, @customLabel, @filePath, 
                @generatedPrompt, @initialPrompt, @isGeneratingPrompt, @isPromptApproved, 
                @generatedImageUrl, @isGeneratingImage, @error
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

// Save Generated Image to Disk
app.post('/api/rooms/:id/generated', (req, res) => {
    try {
        const { id } = req.params;
        const { imageBase64 } = req.body;

        if (!imageBase64) return res.status(400).json({ error: 'No image data' });

        // 1. Get Room Info
        const room = db.prepare('SELECT r.*, s.name as sessionName FROM rooms r JOIN sessions s ON r.sessionId = s.id WHERE r.id = ?').get(id);
        if (!room) return res.status(404).json({ error: 'Room not found' });

        // 2. determine path
        // Match original filename base
        // room.filePath is likely "UnitName/original/Bedroom 1.jpg"
        // We want "Bedroom 1.png"
        const originalFileName = path.basename(room.filePath);
        const originalBase = path.basename(originalFileName, path.extname(originalFileName)); // "Bedroom 1"
        const newFileName = `${originalBase}.jpg`;

        const safeSessionName = sanitizeName(room.sessionName);
        const { staged } = ensureDirectories(getSessionFolderPath(room.sessionName));
        const targetPath = path.join(staged, newFileName);

        // 3. Write File
        // Remove header if present. Supports png and jpeg.
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        fs.writeFileSync(targetPath, base64Data, { encoding: 'base64' });

        // 4. Update DB
        const relativePath = path.join(safeSessionName, 'staged', newFileName);
        db.prepare('UPDATE rooms SET generatedImageUrl = ? WHERE id = ?').run(relativePath, id);

        res.json({ success: true, url: `/uploads/${relativePath}` });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/rooms/:id', (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

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

                const oldFullPath = path.join(__dirname, 'uploads', currentRoom.filePath);
                const newFullPath = path.join(sessionPath, 'original', newFileName);

                if (fs.existsSync(oldFullPath)) {
                    fs.renameSync(oldFullPath, newFullPath);

                    // Also handle staged file if exists
                    if (currentRoom.generatedImageUrl && !currentRoom.generatedImageUrl.startsWith('data:')) {
                        const oldStaged = path.join(__dirname, 'uploads', currentRoom.generatedImageUrl);
                        // assume jpg for staged
                        const stagedExt = path.extname(currentRoom.generatedImageUrl) || '.jpg';
                        const newStagedName = `${updates.roomType} ${nextIndex}${stagedExt}`;
                        const newStagedPath = path.join(sessionPath, 'staged', newStagedName);
                        if (fs.existsSync(oldStaged)) {
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
            'isGeneratingImage', 'error', 'filePath' // filePath allowed for internal update
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

app.delete('/api/rooms/:id', (req, res) => {
    try {
        const { id } = req.params;
        const room = db.prepare('SELECT filePath, generatedImageUrl FROM rooms WHERE id = ?').get(id);

        db.prepare('DELETE FROM rooms WHERE id = ?').run(id);

        if (room) {
            // Delete Original
            if (room.filePath) {
                const fullPath = path.join(__dirname, 'uploads', room.filePath);
                if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
            }
            // Delete Staged
            if (room.generatedImageUrl && !room.generatedImageUrl.startsWith('data:')) {
                const fullPath = path.join(__dirname, 'uploads', room.generatedImageUrl);
                if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
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
