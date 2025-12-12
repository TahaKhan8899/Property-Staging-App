import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RoomData, RoomType } from './types';
import RoomCard from './components/RoomCard';
import ApiKeySelector from './components/ApiKeySelector';
import {
  getSessions,
  createSession,
  deleteSession,
  updateSessionName,
  addRoomToSession,
  getRoomsForSession,
  updateRoom as updateRoomInDB,
  deleteRoom
} from './services/db';

export interface SessionEntity {
  id: string;
  name: string;
  lastModified: number;
}

function App() {
  // --- Data Fetching ---
  const [sessions, setSessions] = useState<SessionEntity[] | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomData[]>([]);
  const [isApiKeyValid, setIsApiKeyValid] = useState(false);
  const [loadingRooms, setLoadingRooms] = useState(false);

  // Load Sessions on Mount & Polling/Refresh
  const loadSessions = async () => {
    try {
      const data = await getSessions();
      setSessions(data);
      return data;
    } catch (e) {
      console.error("Failed to load sessions", e);
      return [];
    }
  };

  useEffect(() => {
    loadSessions();
  }, []);

  // Initialize Session selection
  useEffect(() => {
    if (sessions && sessions.length > 0) {
      if (!currentSessionId || !sessions.find(s => s.id === currentSessionId)) {
        setCurrentSessionId(sessions[0].id);
      }
    } else if (sessions && sessions.length === 0) {
      // Auto-create only if we have confirmed 0 sessions
      const init = async () => {
        const id = await createSession();
        await loadSessions(); // Refresh list
        setCurrentSessionId(id);
      };
      init();
    }
  }, [sessions, currentSessionId]);

  const currentSession = sessions?.find(s => s.id === currentSessionId);

  // Load Rooms when session changes
  const loadRooms = useCallback(async () => {
    if (!currentSessionId) return;
    setLoadingRooms(true);
    try {
      const data = await getRoomsForSession(currentSessionId);
      setRooms(data);
    } catch (e) {
      console.error("Failed to load rooms", e);
    } finally {
      setLoadingRooms(false);
    }
  }, [currentSessionId]);

  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  // --- Handlers ---

  const handleCreateSession = async () => {
    const newId = await createSession();
    await loadSessions();
    setCurrentSessionId(newId);
  };

  const handleDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm("Are you sure you want to delete this session?")) {
      await deleteSession(id);
      await loadSessions();
      if (currentSessionId === id) {
        setCurrentSessionId(null);
      }
    }
  };

  const handleSessionNameChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (currentSessionId) {
      // Optimistic update
      const newName = e.target.value;
      setSessions(prev => prev?.map(s => s.id === currentSessionId ? { ...s, name: newName } : s) || []);

      // Debounce actual API call? For MVP, just calling it. 
      // Actually, debounce is better for typed input. 
      await updateSessionName(currentSessionId, newName);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && currentSessionId) {
      const files = Array.from(e.target.files);
      // Ideally show loading state here
      for (const file of files) {
        await addRoomToSession(currentSessionId, file);
      }
      await loadRooms(); // Refresh rooms
      await loadSessions(); // Update lastModified order
    }
    e.target.value = '';
  };

  const updateRoom = useCallback(async (id: string, updates: Partial<RoomData>) => {
    // Optimistic UI update
    setRooms(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));

    // API Call
    await updateRoomInDB(id, updates);
  }, []);

  const removeRoom = useCallback(async (id: string) => {
    setRooms(prev => prev.filter(r => r.id !== id));
    await deleteRoom(id);
  }, []);

  const stats = {
    total: rooms.length,
    promptsGenerated: rooms.filter(r => r.generatedPrompt).length,
    imagesGenerated: rooms.filter(r => r.generatedImageUrl).length
  };

  if (!sessions) return null; // Initial Loading

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {!isApiKeyValid && <ApiKeySelector onKeySelected={() => setIsApiKeyValid(true)} />}

      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col shrink-0">
        <div className="p-4 border-b border-gray-100 flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
          </div>
          <h1 className="font-bold text-gray-900 tracking-tight text-sm">WH Staging</h1>
        </div>

        <div className="p-4">
          <button
            onClick={handleCreateSession}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-black transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg>
            New Session
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          {sessions.map(session => (
            <div
              key={session.id}
              onClick={() => setCurrentSessionId(session.id)}
              className={`group flex items-center justify-between px-3 py-2 rounded-md text-sm cursor-pointer transition-colors ${currentSessionId === session.id
                  ? 'bg-indigo-50 text-indigo-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-100'
                }`}
            >
              <div className="truncate max-w-[140px]">
                {session.name || 'Untitled Session'}
              </div>
              <button
                onClick={(e) => handleDeleteSession(e, session.id)}
                className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-600 transition-opacity"
                title="Delete Session"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Header */}
        <header className="bg-white border-b border-gray-200 shrink-0">
          <div className="px-6 py-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">{currentSession?.name || 'Loading...'}</h2>
              <p className="text-sm text-gray-500 flex gap-4 mt-1">
                <span>{stats.total} Rooms</span>
                <span>{stats.promptsGenerated} Prompts</span>
                <span>{stats.imagesGenerated} Renders</span>
              </p>
            </div>
          </div>
        </header>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 lg:p-8">
          <div className="max-w-5xl mx-auto space-y-8">

            {/* Unit Setup */}
            <section className="bg-white rounded-xl p-6 shadow-sm border border-gray-200">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div>
                  <label htmlFor="unitName" className="block text-sm font-medium text-gray-700 mb-2">Unit / Session Name</label>
                  <input
                    type="text"
                    id="unitName"
                    value={currentSession?.name || ''}
                    onChange={handleSessionNameChange}
                    placeholder="e.g. Unit B4 - WH Property"
                    className="w-full rounded-md border-gray-600 bg-gray-700 text-white placeholder-gray-400 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-2 border"
                  />
                </div>

                <div className="flex flex-col justify-end">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Upload Room Images</label>
                  <div className="flex items-center justify-center w-full">
                    <label htmlFor="dropzone-file" className="flex flex-col items-center justify-center w-full h-32 border-2 border-gray-300 border-dashed rounded-lg cursor-pointer bg-gray-50 hover:bg-gray-100 transition-colors">
                      {loadingRooms ? (
                        <div className="flex items-center justify-center">
                          <svg className="animate-spin h-6 w-6 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center pt-5 pb-6">
                          <svg className="w-8 h-8 mb-3 text-gray-400" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 16">
                            <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 13h3a3 3 0 0 0 0-6h-.025A5.56 5.56 0 0 0 16 6.5 5.5 5.5 0 0 0 5.207 5.021C5.137 5.017 5.071 5 5 5a4 4 0 0 0 0 8h2.167M10 15V6m0 0L8 8m2-2 2 2" />
                          </svg>
                          <p className="text-sm text-gray-500"><span className="font-semibold">Click to upload</span> or drag and drop</p>
                          <p className="text-xs text-gray-500">JPG, PNG</p>
                        </div>
                      )}
                      <input
                        id="dropzone-file"
                        type="file"
                        className="hidden"
                        multiple
                        accept="image/*"
                        onChange={handleFileUpload}
                        disabled={!currentSessionId || loadingRooms}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </section>

            {/* Room Cards */}
            <section className="flex flex-col gap-6">
              {rooms.length === 0 && !loadingRooms && (
                <div className="text-center py-20 bg-white rounded-xl border border-gray-200 border-dashed">
                  <p className="text-gray-400 text-lg">No rooms uploaded yet.</p>
                  <p className="text-gray-400 text-sm">Upload images above to start.</p>
                </div>
              )}

              {rooms.map((room) => (
                <RoomCard
                  key={room.id}
                  room={room}
                  onUpdate={updateRoom}
                  onRemove={removeRoom}
                />
              ))}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;