import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure we put the DB in the root project folder, not inside /server
const dbPath = path.resolve(__dirname, '../database.sqlite');
const db = new Database(dbPath);

console.log(`Connected to SQLite database at ${dbPath}`);

// Enable WAL for better concurrency
db.pragma('journal_mode = WAL');

// Define Schema
const schema = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    lastModified INTEGER
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
    FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS image_versions (
    id TEXT PRIMARY KEY,
    roomId TEXT,
    url TEXT,
    timestamp INTEGER,
    description TEXT,
    versionNumber INTEGER,
    FOREIGN KEY(roomId) REFERENCES rooms(id) ON DELETE CASCADE
  );
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

export default db;
