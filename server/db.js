import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure we put the DB in the root project folder, not inside /server.
// STAGING_DB_PATH lets tests point at a temp file.
const dbPath = process.env.STAGING_DB_PATH || path.resolve(__dirname, '../database.sqlite');
const db = new Database(dbPath);

console.log(`Connected to SQLite database at ${dbPath}`);

// Enable WAL for better concurrency
db.pragma('journal_mode = WAL');

// Define Schema
const schema = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    lastModified INTEGER,
    status TEXT DEFAULT 'not_started',
    sortOrder INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    sessionId TEXT,
    roomType TEXT,
    customLabel TEXT,
    filePath TEXT, -- Local filesystem path or URL path
    -- previewUrl REMOVED: redundant if we have filePath
    generatedPrompt TEXT,
    initialPrompt TEXT,
    isGeneratingPrompt INTEGER, -- 0 or 1
    isPromptApproved INTEGER,   -- 0 or 1
    generatedImageUrl TEXT,
    isGeneratingImage INTEGER,  -- 0 or 1
    error TEXT,
    currentVersionId TEXT,
    roomStatus TEXT DEFAULT 'in_progress',
    FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS image_versions (
    id TEXT PRIMARY KEY,
    roomId TEXT,
    url TEXT,
    timestamp INTEGER,
    description TEXT,
    versionNumber INTEGER,
    promptSnapshot TEXT,
    FOREIGN KEY(roomId) REFERENCES rooms(id) ON DELETE CASCADE
  );

  -- One row per Gemini API call (including failures) for cost tracking.
  -- No foreign keys: spend history should survive room/session deletion.
  CREATE TABLE IF NOT EXISTS api_calls (
    id TEXT PRIMARY KEY,
    timestamp INTEGER,
    sessionId TEXT,
    sessionName TEXT,
    roomId TEXT,
    kind TEXT,            -- prompt | reference_prompt | refine | generate | edit
    model TEXT,
    status TEXT,          -- ok | error
    error TEXT,
    promptTokens INTEGER,
    textOutputTokens INTEGER,
    thoughtsTokens INTEGER,
    imageOutputTokens INTEGER,
    imageCount INTEGER,
    costUsd REAL,
    durationMs INTEGER    -- wall time of the attempt (image calls), for latency comparisons
  );
  CREATE INDEX IF NOT EXISTS idx_api_calls_session ON api_calls(sessionId);
`;

db.exec(schema);

// Migrations for existing databases
try {
  db.prepare('ALTER TABLE rooms ADD COLUMN filePath TEXT').run();
} catch (e) {
  // Column likely exists
}

try {
  db.prepare('ALTER TABLE rooms ADD COLUMN currentVersionId TEXT').run();
} catch (e) {
  // Column likely exists
}

try {
  db.prepare('ALTER TABLE api_calls ADD COLUMN durationMs INTEGER').run();
} catch (e) {
  // Column likely exists
}

try {
  db.prepare('ALTER TABLE image_versions ADD COLUMN promptSnapshot TEXT').run();
} catch (e) {
  // Column likely exists
}

try {
  db.prepare("ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'not_started'").run();
} catch (e) {
  // Column likely exists
}

try {
  db.prepare("UPDATE sessions SET status = 'not_started' WHERE status IS NULL").run();
} catch (e) {
  // ignore - table might be empty
}

try {
  db.prepare('ALTER TABLE sessions ADD COLUMN sortOrder INTEGER DEFAULT 0').run();
} catch (e) {
  // Column likely exists
}

const assignMissingSortOrders = () => {
  const sessionsNeedingOrder = db
    .prepare('SELECT id FROM sessions WHERE sortOrder IS NULL ORDER BY lastModified DESC, id ASC')
    .all();
  if (!sessionsNeedingOrder.length) return;
  const updateStmt = db.prepare('UPDATE sessions SET sortOrder = ? WHERE id = ?');
  sessionsNeedingOrder.forEach((session, index) => {
    updateStmt.run(index, session.id);
  });
};

assignMissingSortOrders();

// v1: sessions used to be appended at the bottom (oldest first). Flip the existing order once so the
// newest sit on top; new sessions are now inserted at the top (see POST /api/sessions).
if (db.pragma('user_version', { simple: true }) < 1) {
  db.transaction(() => {
    db.prepare('UPDATE sessions SET sortOrder = (SELECT MAX(sortOrder) FROM sessions) - sortOrder').run();
    db.pragma('user_version = 1');
  })();
}

try {
  db.prepare("ALTER TABLE rooms ADD COLUMN roomStatus TEXT DEFAULT 'in_progress'").run();
} catch (e) {
  // Column likely exists
}

try {
  db.prepare("UPDATE rooms SET roomStatus = 'in_progress' WHERE roomStatus IS NULL").run();
} catch (e) {
  // ignore - table might be empty
}

try {
  db.prepare('ALTER TABLE rooms ADD COLUMN referenceRoomId TEXT').run();
} catch (e) {
  // Column likely exists
}

try {
  db.prepare('ALTER TABLE rooms ADD COLUMN outputSourcePath TEXT').run();
} catch (e) {
  // Column likely exists
}

try {
  db.prepare('ALTER TABLE rooms ADD COLUMN outputFileName TEXT').run();
} catch (e) {
  // Column likely exists
}

export default db;
