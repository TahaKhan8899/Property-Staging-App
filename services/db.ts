import { Session, RoomData } from '../types';

const DB_NAME = 'wh-staging-db';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

export const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
};

export const saveSessionToDB = async (session: Session) => {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    // Create a copy to strip transient data if needed (previewUrl is transient but easy to recreate)
    // We store the File object directly, IDB handles Blobs/Files efficiently.
    // We remove previewUrl to avoid storing stale object URLs, though we will regenerate them on load.
    const sessionToSave = {
      ...session,
      lastModified: Date.now(),
      rooms: session.rooms.map(room => {
        const { previewUrl, ...rest } = room; 
        return rest;
      })
    };

    const request = store.put(sessionToSave);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
};

export const getSessionsFromDB = async (): Promise<Session[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const sessions = request.result as Session[];
      // Sort by last modified descending
      sessions.sort((a, b) => b.lastModified - a.lastModified);
      resolve(sessions);
    };
  });
};

export const deleteSessionFromDB = async (id: string) => {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
};