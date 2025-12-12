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
    FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE
  );
`;

db.exec(schema);

// Optional: Run a migration column check or just altering table if exists?
// For dev/staging app, we can just ALTER TABLE or let user know. 
// However, since we are "Porting", let's be safe and try to add column if missing, 
// or since this is a schema definition file, it only runs on new DBs mostly or if table doesn't exist.
// Since User said "I'd rather not save to DB directly", maybe we just assume new schema is fine.
// But to be robust for existing DB, let's add `filePath` if it doesn't exist.

try {
  db.prepare('ALTER TABLE rooms ADD COLUMN filePath TEXT').run();
} catch (e) {
  // Column likely exists or table doesn't exist yet (handled by CREATE above)
}

export default db;
