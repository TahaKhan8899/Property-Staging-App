import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RoomData, RoomType, SessionStatus } from './types';
import RoomCard from './components/RoomCard';
import type { ReferenceOption } from './components/RoomCard';
import ApiKeySelector from './components/ApiKeySelector';
import {
  getSessions,
  createSession,
  deleteSession,
  updateSessionName,
  updateSession,
  addRoomToSession,
  getRoomsForSession,
  updateRoom as updateRoomInDB,
  deleteRoom,
  reorderSessions,
  getSessionUsage,
  getSessionExportUrl,
  USAGE_LOGGED_EVENT
} from './services/db';
import { hasStaleOutput } from './services/outputState';
import type { SessionEntity, SessionUsage } from './services/db';

const SESSION_STATUS_META: Record<SessionStatus, { label: string; dotClass: string; activeClasses: string }> = {
  not_started: {
    label: 'Not started',
    dotClass: 'bg-red-500',
    activeClasses: 'border-red-200 bg-red-50 text-red-700'
  },
  in_progress: {
    label: 'In progress',
    dotClass: 'bg-amber-500',
    activeClasses: 'border-amber-200 bg-amber-50 text-amber-700'
  },
  completed: {
    label: 'Completed',
    dotClass: 'bg-emerald-500',
    activeClasses: 'border-emerald-200 bg-emerald-50 text-emerald-700'
  }
};

const SESSION_STATUS_ORDER: SessionStatus[] = ['not_started', 'in_progress', 'completed'];
const DEFAULT_SESSION_STATUS: SessionStatus = 'not_started';

const resolveSessionStatus = (status?: SessionStatus | null) => {
  if (status && SESSION_STATUS_META[status as SessionStatus]) {
    return status as SessionStatus;
  }
  return DEFAULT_SESSION_STATUS;
};

const ordersEqual = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
};

function App() {
  // --- Data Fetching ---
  const [sessions, setSessions] = useState<SessionEntity[] | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomData[]>([]);
  const [isApiKeyValid, setIsApiKeyValid] = useState(false);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null);
  const [dragOverSessionId, setDragOverSessionId] = useState<string | null>(null);
  const [isSavingSessionOrder, setIsSavingSessionOrder] = useState(false);
  const initialSessionOrderRef = useRef<string[]>([]);
  const dragAcceptedRef = useRef(false);

  // Load Sessions on Mount & Polling/Refresh
  const loadSessions = useCallback(async () => {
    try {
      const data = await getSessions();
      setSessions(data);
      return data;
    } catch (e) {
      console.error("Failed to load sessions", e);
      return [];
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

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

  // Approval/edit state of the session's prompts; approving or editing a prompt makes no Gemini call,
  // so the usage readout (which also carries the prompt-edit counts) refreshes on this too
  const promptSignature = rooms.map(r => `${r.id}:${r.isPromptApproved ? 1 : 0}:${(r.generatedPrompt || '').length}`).join('|');

  // Gemini spend for the current session; refreshed whenever a call is logged
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  useEffect(() => {
    if (!currentSessionId) return;
    let cancelled = false;
    const refresh = () => {
      getSessionUsage(currentSessionId)
        .then(u => { if (!cancelled) setUsage(u); })
        .catch(err => console.warn('Failed to load usage:', err));
    };
    setUsage(null);
    refresh();
    window.addEventListener(USAGE_LOGGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(USAGE_LOGGED_EVENT, refresh);
    };
  }, [currentSessionId]);

  useEffect(() => {
    if (!currentSessionId) return;
    let cancelled = false;
    // Small delay so the room PATCH that changed the signature has reached the DB
    const timer = setTimeout(() => {
      getSessionUsage(currentSessionId)
        .then(u => { if (!cancelled) setUsage(u); })
        .catch(() => { /* readout stays as it was */ });
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [promptSignature, currentSessionId]);

  const currentSession = sessions?.find(s => s.id === currentSessionId);
  const currentSessionStatus = resolveSessionStatus(currentSession?.status);

  const revertSessionOrder = useCallback(() => {
    setSessions(prev => {
      const originalOrder = initialSessionOrderRef.current;
      if (!prev || !originalOrder.length) return prev;
      const sessionMap = new Map(prev.map(session => [session.id, session]));
      const reordered = originalOrder
        .map(id => sessionMap.get(id))
        .filter((session): session is SessionEntity => Boolean(session));
      const leftovers = prev.filter(session => !originalOrder.includes(session.id));
      return [...reordered, ...leftovers];
    });
  }, []);

  const moveDraggedSession = useCallback(
    (targetId: string | null) => {
      if (!draggedSessionId) return;
      setSessions(prev => {
        if (!prev) return prev;
        if (targetId === draggedSessionId) return prev;
        const updated = [...prev];
        const fromIndex = updated.findIndex(session => session.id === draggedSessionId);
        if (fromIndex === -1) return prev;
        const [movedSession] = updated.splice(fromIndex, 1);

        if (targetId) {
          const toIndex = updated.findIndex(session => session.id === targetId);
          if (toIndex === -1) {
            updated.splice(fromIndex, 0, movedSession);
            return prev;
          }
          updated.splice(toIndex, 0, movedSession);
        } else {
          updated.push(movedSession);
        }

        return updated;
      });
    },
    [draggedSessionId]
  );

  const handleSessionDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, sessionId: string) => {
      event.dataTransfer?.setData('text/plain', sessionId);
      event.dataTransfer?.setDragImage(new Image(), 0, 0);
      setDraggedSessionId(sessionId);
      dragAcceptedRef.current = false;
      initialSessionOrderRef.current = sessions?.map(session => session.id) || [];
    },
    [sessions]
  );

  const handleSessionDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>, targetId: string) => {
      event.preventDefault();
      if (!draggedSessionId) return;
      setDragOverSessionId(targetId);
      moveDraggedSession(targetId);
    },
    [draggedSessionId, moveDraggedSession]
  );

  const handleSessionListEmptySpaceDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      if (!draggedSessionId) return;
      setDragOverSessionId(null);
      moveDraggedSession(null);
    },
    [draggedSessionId, moveDraggedSession]
  );

  const persistSessionOrder = useCallback(
    async (orderedIds: string[]) => {
      setIsSavingSessionOrder(true);
      try {
        await reorderSessions(orderedIds);
      } catch (err) {
        console.error('Failed to reorder sessions', err);
        alert('Failed to save session order. Restoring previous order.');
        await loadSessions();
      } finally {
        setIsSavingSessionOrder(false);
      }
    },
    [loadSessions]
  );

  const handleSessionDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!draggedSessionId || !sessions) return;

      dragAcceptedRef.current = true;
      const newOrder = sessions.map(session => session.id);
      const previousOrder = initialSessionOrderRef.current;

      setDraggedSessionId(null);
      setDragOverSessionId(null);
      initialSessionOrderRef.current = [];

      if (!previousOrder.length || !ordersEqual(previousOrder, newOrder)) {
        await persistSessionOrder(newOrder);
      }
    },
    [persistSessionOrder, sessions]
  );

  const handleSessionListDropOnEmptySpace = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      handleSessionDrop(event);
    },
    [handleSessionDrop]
  );

  const handleSessionDragEnd = useCallback(() => {
    if (!dragAcceptedRef.current) {
      revertSessionOrder();
    }
    setDraggedSessionId(null);
    setDragOverSessionId(null);
    initialSessionOrderRef.current = [];
    dragAcceptedRef.current = false;
  }, [revertSessionOrder]);

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

  const handleSessionStatusChange = async (status: SessionStatus) => {
    if (!currentSessionId || isUpdatingStatus) return;
    const nextStatus = resolveSessionStatus(status);
    if (currentSession?.status === nextStatus) return;

    setSessions(prev => prev?.map(s => s.id === currentSessionId ? { ...s, status: nextStatus } : s) || []);

    setIsUpdatingStatus(true);
    try {
      await updateSession(currentSessionId, { status: nextStatus });
    } catch (err) {
      console.error('Failed to update session status', err);
      await loadSessions();
      alert('Failed to update session status. Please try again.');
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  // --- Upload Handlers ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingRoomType, setPendingRoomType] = useState<RoomType | null>(null);
  const [draggedRoomType, setDraggedRoomType] = useState<RoomType | null>(null);

  const handleAddRoomClick = (type: RoomType) => {
    setPendingRoomType(type);
    if (fileInputRef.current) {
      fileInputRef.current.value = ''; // Reset
      fileInputRef.current.click();
    }
  };

  const uploadRoomImage = async (file: File, roomType: RoomType) => {
    if (!currentSessionId) return;
    if (!file.type.startsWith('image/')) {
      alert('Please upload image files only.');
      return;
    }

    setLoadingRooms(true);
    try {
      await addRoomToSession(currentSessionId, file, roomType);
      await loadRooms();
      await loadSessions();
    } catch (err) {
      alert("Failed to upload room: " + err);
    } finally {
      setLoadingRooms(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0] && pendingRoomType) {
      const file = e.target.files[0];
      const roomTypeForUpload = pendingRoomType;
      try {
        await uploadRoomImage(file, roomTypeForUpload);
      } finally {
        setPendingRoomType(null);
      }
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLButtonElement>, type: RoomType) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (draggedRoomType !== type) {
      setDraggedRoomType(type);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLButtonElement>, type: RoomType) => {
    e.preventDefault();
    if (draggedRoomType === type) {
      setDraggedRoomType(null);
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLButtonElement>, type: RoomType) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setDraggedRoomType(null);
    const files = e.dataTransfer.files;
    if (files && files[0]) {
      await uploadRoomImage(files[0], type);
    }
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
  const outputCount = rooms.filter(r => r.outputSourcePath).length;
  const staleOutputCount = rooms.filter(hasStaleOutput).length;

  // Staged rooms in this session that can act as Image 1 for another room (same room, different angle).
  // Labelled like the on-disk names: "<Room Type> <n>".
  const roomLabels = new Map<string, string>();
  const typeCounts: Record<string, number> = {};
  rooms.forEach(r => {
    const base = r.roomType === RoomType.Other ? (r.customLabel || 'Room') : r.roomType;
    typeCounts[base] = (typeCounts[base] || 0) + 1;
    roomLabels.set(r.id, `${base} ${typeCounts[base]}`);
  });
  const stagedReferenceOptions: ReferenceOption[] = rooms
    .filter(r => r.generatedImageUrl)
    .map(r => ({ id: r.id, label: roomLabels.get(r.id)!, url: r.generatedImageUrl!, currentVersionId: r.currentVersionId }));

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

        <div
          className="flex-1 overflow-y-auto px-2 space-y-1"
          onDragOver={handleSessionListEmptySpaceDragOver}
          onDrop={handleSessionListDropOnEmptySpace}
        >
          {sessions.map(session => {
            const sessionStatusValue = resolveSessionStatus(session.status);
            const statusMeta = SESSION_STATUS_META[sessionStatusValue];
            const isDragging = draggedSessionId === session.id;
            const isDragTarget = dragOverSessionId === session.id;
            return (
              <div
                key={session.id}
                onClick={() => setCurrentSessionId(session.id)}
                draggable
                onDragStart={(e) => handleSessionDragStart(e, session.id)}
                onDragOver={(e) => handleSessionDragOver(e, session.id)}
                onDrop={handleSessionDrop}
                onDragEnd={handleSessionDragEnd}
                className={`group flex items-center justify-between px-3 py-2 rounded-md text-sm cursor-pointer transition-colors border border-transparent ${currentSessionId === session.id
                  ? 'bg-indigo-50 text-indigo-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-100'
                  } ${isDragging ? 'opacity-70' : ''} ${isDragTarget ? 'border-indigo-300 bg-indigo-50' : ''}`}
              >
                <div className="flex items-center gap-2 truncate max-w-[140px]">
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${statusMeta.dotClass}`}
                    title={statusMeta.label}
                    aria-label={`Status: ${statusMeta.label}`}
                  />
                  <span className="truncate">{session.name || 'Untitled Session'}</span>
                </div>
                <button
                  onClick={(e) => handleDeleteSession(e, session.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-600 transition-opacity"
                  title="Delete Session"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              </div>
            );
          })}
          {isSavingSessionOrder && (
            <p className="text-xs text-gray-400 text-center py-2">Saving session order...</p>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Header */}
        <header className="bg-white border-b border-gray-200 shrink-0">
          <div className="px-6 py-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">{currentSession?.name || 'Loading...'}</h2>
              <p className="text-sm text-gray-500 flex gap-4 mt-1">
                <span>{stats.total} Rooms</span>
                <span>{stats.promptsGenerated} Prompts</span>
                <span>{stats.imagesGenerated} Renders</span>
                {usage && (
                  <span
                    className="font-medium text-gray-700"
                    title={usage.byKind.map(k => `${k.kind} (${k.model}): ${k.calls} calls, $${k.costUsd.toFixed(2)}`).join('\n') || 'No API calls logged yet'}
                  >
                    API cost ${usage.costUsd.toFixed(2)} · {usage.calls} calls{usage.failedCalls > 0 ? ` (${usage.failedCalls} failed)` : ''}
                  </span>
                )}
                {usage && usage.promptsApproved > 0 && (
                  <span title="Approved prompts that differ from what the model first wrote (manual edits or AI refine)">
                    Prompts edited before approval: {usage.promptsEdited} of {usage.promptsApproved}
                  </span>
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <span className="text-xs text-gray-500">{outputCount} image{outputCount === 1 ? '' : 's'} in output</span>
                {(['staged', 'compressed'] as const).map(variant => (
                  <button
                    key={variant}
                    type="button"
                    disabled={!currentSessionId || outputCount === 0}
                    onClick={() => currentSessionId && window.open(getSessionExportUrl(currentSessionId, variant), '_blank')}
                    className="px-2.5 py-1 text-xs font-medium rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {variant === 'staged' ? 'Download Staged ZIP' : 'Download Compressed ZIP'}
                  </button>
                ))}
                {staleOutputCount > 0 && (
                  <span
                    className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-0.5"
                    title="These rooms show a different version than the copy in the output folder. Use Replace Output on the card."
                  >
                    {staleOutputCount} room{staleOutputCount === 1 ? '' : 's'} showing a version not in output
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2 lg:items-end">
              <span className="text-xs font-semibold text-gray-500 tracking-wide uppercase">Session Status</span>
              <div className="flex flex-wrap gap-2">
                {SESSION_STATUS_ORDER.map((statusOption) => {
                  const statusMeta = SESSION_STATUS_META[statusOption];
                  const isActive = currentSessionStatus === statusOption;
                  const isDisabled = !currentSessionId || isUpdatingStatus;
                  return (
                    <button
                      type="button"
                      key={statusOption}
                      onClick={() => handleSessionStatusChange(statusOption)}
                      disabled={isDisabled}
                      className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-full border transition ${isActive
                        ? statusMeta.activeClasses
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                        } ${isDisabled ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                      <span className={`w-2 h-2 rounded-full ${statusMeta.dotClass}`} />
                      {statusMeta.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </header>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 lg:p-8">
          <div className="max-w-5xl mx-auto space-y-8">

            {/* Unit Setup */}
            <section className="bg-white rounded-xl p-6 shadow-sm border border-gray-200">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
                <div>
                  <label htmlFor="unitName" className="block text-sm font-medium text-gray-700 mb-2">Unit / Session Name</label>
                  <input
                    type="text"
                    id="unitName"
                    value={currentSession?.name || ''}
                    onChange={handleSessionNameChange}
                    placeholder="e.g. Unit B4 - WH Property"
                    className="w-full rounded-md border-gray-300 bg-white text-gray-900 placeholder-gray-400 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-3 border"
                  />
                  <p className="text-xs text-gray-500 mt-2">
                    Files will be stored in <span className="font-mono bg-gray-100 px-1 rounded">uploads/{currentSession?.name || '...'}</span>
                  </p>
                </div>

                <div className="flex flex-col">
                  <span className="block text-sm font-medium text-gray-700 mb-3">Add Rooms</span>

                  {loadingRooms ? (
                    <div className="flex items-center justify-center h-20 bg-gray-50 rounded-lg border border-dashed border-gray-200">
                      <svg className="animate-spin h-5 w-5 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                      <span className="ml-2 text-sm text-gray-500">Uploading...</span>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      {Object.values(RoomType).map((type) => {
                        const isDragTarget = draggedRoomType === type;
                        return (
                          <button
                            key={type}
                            onClick={() => handleAddRoomClick(type)}
                            onDragOver={(e) => handleDragOver(e, type)}
                            onDragLeave={(e) => handleDragLeave(e, type)}
                            onDrop={(e) => handleDrop(e, type)}
                            className={`flex items-center justify-center gap-2 px-4 py-3 bg-white border rounded-lg text-sm font-medium transition-all shadow-sm group ${isDragTarget
                              ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                              : 'border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-indigo-300 hover:text-indigo-600'
                              }`}
                          >
                            <svg
                              className={`w-4 h-4 ${isDragTarget ? 'text-indigo-500' : 'text-gray-400 group-hover:text-indigo-500'}`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                            </svg>
                            {type}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept="image/*"
                    onChange={handleFileChange}
                  />
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
                  referenceOptions={stagedReferenceOptions.filter(o => o.id !== room.id)}
                  apiUsage={usage?.byRoom.find(r => r.roomId === room.id)}
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
