import { RoomData, RoomType, SessionStatus, PromptSnapshot, RoomStatus } from '../types';

const API_BASE = 'http://localhost:3001/api';

// --- API Helpers ---

const api = {
  get: async (url: string) => {
    const res = await fetch(`${API_BASE}${url}`);
    if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
    return res.json();
  },
  post: async (url: string, data: any) => {
    const isFormData = data instanceof FormData;
    const headers = isFormData ? {} : { 'Content-Type': 'application/json' };
    const body = isFormData ? data : JSON.stringify(data);

    const res = await fetch(`${API_BASE}${url}`, {
      method: 'POST',
      headers,
      body
    });
    if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
    return res.json();
  },
  patch: async (url: string, data: any) => {
    const res = await fetch(`${API_BASE}${url}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
    return res.json();
  },
  delete: async (url: string) => {
    const res = await fetch(`${API_BASE}${url}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
    return res.json();
  }
};

// --- Sessions ---

export interface SessionEntity {
  id: string;
  name: string;
  lastModified: number;
  status: SessionStatus;
  sortOrder?: number;
}

export const getSessions = async (): Promise<SessionEntity[]> => {
  return await api.get('/sessions');
};

export const createSession = async (name: string = 'New Session', status: SessionStatus = 'not_started') => {
  const id = crypto.randomUUID();
  await api.post('/sessions', {
    id,
    name,
    status,
    lastModified: Date.now()
  });
  return id;
};

export const deleteSession = async (id: string) => {
  await api.delete(`/sessions/${id}`);
};

export const updateSession = async (id: string, updates: Partial<Pick<SessionEntity, 'name' | 'status'>>) => {
  if (!updates || Object.keys(updates).length === 0) return;
  await api.patch(`/sessions/${id}`, { ...updates, lastModified: Date.now() });
};

export const updateSessionName = async (id: string, name: string) => {
  await updateSession(id, { name });
};

export const reorderSessions = async (orderedIds: string[]) => {
  if (!Array.isArray(orderedIds) || !orderedIds.length) return;
  await api.patch('/sessions/reorder', { orderedIds });
};

// --- Rooms ---

// Helper to correct URLs
const getFullUrl = (path: string) => {
  if (!path) return undefined;
  if (path.startsWith('http')) return path;
  if (path.startsWith('data:')) return path;
  return `http://localhost:3001${path}`;
};

export const getRoomsForSession = async (sessionId: string): Promise<RoomData[]> => {
  const rooms = await api.get(`/sessions/${sessionId}/rooms`);

  return rooms.map((r: any) => ({
    ...r,
    previewUrl: getFullUrl(r.filePath),
    generatedImageUrl: getFullUrl(r.generatedImageUrl),
    roomStatus: (r.roomStatus || 'in_progress') as RoomStatus
  }));
};

export const addRoomToSession = async (
  sessionId: string,
  file: File,
  roomType: RoomType = RoomType.Bedroom,
  roomStatus: RoomStatus = 'in_progress'
) => {
  const id = crypto.randomUUID();

  const formData = new FormData();
  formData.append('id', id);
  formData.append('sessionId', sessionId);
  formData.append('file', file);
  formData.append('roomType', roomType);
  formData.append('customLabel', '');
  formData.append('roomStatus', roomStatus);
  // Default values for new room
  formData.append('isGeneratingPrompt', 'false');
  formData.append('isPromptApproved', 'false');
  formData.append('isGeneratingImage', 'false');
  formData.append('error', '');
  formData.append('generatedImageUrl', '');

  await api.post('/rooms', formData);
  await api.patch(`/sessions/${sessionId}`, { lastModified: Date.now() });
  return id;
};

export const updateRoom = async (id: string, updates: Partial<RoomData>) => {
  const { file, previewUrl, ...safeUpdates } = updates as any;
  await api.patch(`/rooms/${id}`, safeUpdates);
};

export const saveGeneratedImage = async (
  id: string,
  imageBase64: string,
  description?: string,
  promptSnapshot?: PromptSnapshot | Record<string, any> | string
): Promise<{ url: string; version: any }> => {
  const res = await api.post(`/rooms/${id}/generated`, { imageBase64, description, promptSnapshot });
  return {
    url: getFullUrl(res.url) || res.url,
    version: res.version
  };
};

export const uploadStagedImage = async (
  roomId: string,
  file: File,
  promptSnapshot?: PromptSnapshot | Record<string, any> | string
): Promise<{ url: string; version: any }> => {
  const formData = new FormData();
  formData.append('file', file);
  if (promptSnapshot) {
    formData.append(
      'promptSnapshot',
      typeof promptSnapshot === 'string' ? promptSnapshot : JSON.stringify(promptSnapshot)
    );
  }

  const res = await api.post(`/rooms/${roomId}/upload-staged`, formData);
  return {
    url: getFullUrl(res.url) || res.url,
    version: res.version
  };
};

export const getImageVersions = async (roomId: string) => {
  const versions = await api.get(`/rooms/${roomId}/versions`);
  return versions.map((v: any) => ({
    ...v,
    url: getFullUrl(v.url),
    promptSnapshot: v.promptSnapshot
  }));
};

export const restoreImageVersion = async (roomId: string, versionId: string): Promise<{ url: string }> => {
  const res = await api.post(`/rooms/${roomId}/versions/${versionId}/restore`, {});
  return { url: getFullUrl(res.url) || res.url };
};

export const deleteRoom = async (id: string) => {
  await api.delete(`/rooms/${id}`);
};
