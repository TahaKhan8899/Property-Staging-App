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
app.use(express.json({ limit: '50mb' })); // For other small JSON data

// Configure Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Use timestamp + original extensions or just random name
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname) || '.png';
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
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
        res.json({ success: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/sessions/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { name, lastModified } = req.body;

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
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/sessions/:id', (req, res) => {
    try {
        const { id } = req.params;
        // Rooms are cascade deleted by SQLite FOREIGN KEY
        // TODO: Ideally verify if we need to clean up files from disk too.
        // For now, simpler implementation relies on orphaned files not being critical in dev.
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
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
            // Construct full URL just in case client needs it, or client can construct from filePath
            // Assuming filePath is just filename or relative path
            if (r.filePath) {
                // If it's stored as absolute path, strip it? Or just store filename logic.
                // Let's assume we store 'uploads/filename.png' or just 'filename.png'
                // If we store just filename, we prepend /uploads/
                const filename = path.basename(r.filePath);
                r.filePath = `/uploads/${filename}`;
            }
            return r;
        });

        res.json(processedRooms);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Handle Multipart Upload
app.post('/api/rooms', upload.single('file'), (req, res) => {
    try {
        // req.file contains file info
        // req.body contains other text fields
        console.log('File uploaded:', req.file);
        console.log('Body:', req.body);

        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const room = req.body;
        // room fields come as strings in multipart/form-data, might need parsing if complex JSON
        // but here mostly primitives
        const boolFields = ['isGeneratingPrompt', 'isPromptApproved', 'isGeneratingImage'];

        // Prepare data object
        const data = {
            id: room.id,
            sessionId: room.sessionId,
            roomType: room.roomType || 'Bedroom',
            customLabel: room.customLabel || '',
            filePath: req.file.filename, // Store just filename, easy to serve from /uploads
            generatedPrompt: room.generatedPrompt || '',
            initialPrompt: room.initialPrompt || '',
            isGeneratingPrompt: room.isGeneratingPrompt === 'true' ? 1 : 0,
            isPromptApproved: room.isPromptApproved === 'true' ? 1 : 0,
            generatedImageUrl: room.generatedImageUrl || '',
            isGeneratingImage: room.isGeneratingImage === 'true' ? 1 : 0,
            error: room.error || ''
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

        res.json({ success: true, id: room.id, filePath: `/uploads/${data.filePath}` });
    } catch (err) {
        console.error("Upload error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/rooms/:id', (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const keys = Object.keys(updates);
        if (keys.length === 0) return res.json({ success: true });

        // Filter out keys not in schema if necessary or rely on safe inputs
        // Also handle boolean conversion if coming from JSON body (PATCH is usually JSON)
        const safeUpdates = {};
        const allowedCols = [
            'roomType', 'customLabel', 'generatedPrompt', 'initialPrompt',
            'isGeneratingPrompt', 'isPromptApproved', 'generatedImageUrl',
            'isGeneratingImage', 'error'
        ];

        keys.forEach(k => {
            if (allowedCols.includes(k)) {
                safeUpdates[k] = updates[k];
            }
        });

        // If file is updated via PATCH, it's complex because we need multipart again.
        // Usually we don't update the raw file of a room in this app flow, we delete and add new.
        // So ignoring file updates here for now.

        const updateKeys = Object.keys(safeUpdates);
        if (updateKeys.length === 0) return res.json({ success: true }); // nothing to update

        const setClause = updateKeys.map(k => `${k} = @${k}`).join(', ');
        const query = `UPDATE rooms SET ${setClause} WHERE id = @id`;

        // Handle boolean conversions for known bool fields
        ['isGeneratingPrompt', 'isPromptApproved', 'isGeneratingImage'].forEach(f => {
            if (f in safeUpdates) {
                safeUpdates[f] = safeUpdates[f] ? 1 : 0;
            }
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
        // Optionally fetch file path to delete from disk
        const room = db.prepare('SELECT filePath FROM rooms WHERE id = ?').get(id);

        db.prepare('DELETE FROM rooms WHERE id = ?').run(id);

        if (room && room.filePath) {
            const fullPath = path.join(__dirname, 'uploads', room.filePath);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
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
