import { RoomData, RoomType } from '../types';

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
}

export const getSessions = async (): Promise<SessionEntity[]> => {
  return await api.get('/sessions');
};

export const createSession = async (name: string = 'New Session') => {
  const id = crypto.randomUUID();
  await api.post('/sessions', {
    id,
    name,
    lastModified: Date.now()
  });
  return id;
};

export const deleteSession = async (id: string) => {
  await api.delete(`/sessions/${id}`);
};

export const updateSessionName = async (id: string, name: string) => {
  await api.patch(`/sessions/${id}`, { name, lastModified: Date.now() });
};

// --- Rooms ---

export const getRoomsForSession = async (sessionId: string): Promise<RoomData[]> => {
  const rooms = await api.get(`/sessions/${sessionId}/rooms`);

  return rooms.map((r: any) => ({
    ...r,
    // Construct full URL if server returns a relative path (it returns /uploads/filename.png now)
    // We can assume server returns a usable path, or we prepend host.
    // The server currently returns `/uploads/filename.png` in `filePath`.
    previewUrl: r.filePath ? `http://localhost:3001${r.filePath}` : '',
    // We don't restore the original File object because we can't easily from a URL.
    // The RoomData type might expect `file?: File`. We should make it optional or just null.
    // For now, let's leave it undefined, assuming the UI uses previewUrl primarily.
  }));
};

export const addRoomToSession = async (sessionId: string, file: File) => {
  const id = crypto.randomUUID();

  const formData = new FormData();
  formData.append('id', id);
  formData.append('sessionId', sessionId);
  formData.append('file', file); // Multer expects 'file'
  formData.append('roomType', RoomType.Bedroom);
  formData.append('customLabel', '');
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
  // Filter out non-serializable or transient fields if necessary
  const { file, previewUrl, ...safeUpdates } = updates as any;

  await api.patch(`/rooms/${id}`, safeUpdates);
};

export const deleteRoom = async (id: string) => {
  await api.delete(`/rooms/${id}`);
};