// Client for the server-side Gemini routes (server/geminiRoutes.js). Progress arrives as Server-Sent
// Events over a POST, so this reads the response stream by hand (EventSource only supports GET).
import { getFullUrl, USAGE_LOGGED_EVENT } from './db';
import type { PromptSnapshot } from '../types';

const API_BASE = 'http://localhost:3001/api';

export type ProgressHandler = (status: string, interimImage?: string, candidate?: number) => void;

export interface SavedVersion {
  id: string;
  versionNumber: number;
  timestamp: number;
  description: string;
  url: string;
  promptSnapshot?: PromptSnapshot | null;
}

const parseEvent = (block: string) => {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.length ? JSON.parse(data.join('\n')) : null };
};

// One candidate of a multi-candidate render finished (version) or failed (error)
export interface CandidateEvent {
  candidate: number;
  of: number;
  version?: SavedVersion;
  error?: string;
}

const postWithProgress = async <T>(
  path: string,
  body: unknown,
  onProgress?: ProgressHandler,
  onCandidate?: (e: CandidateEvent) => void
): Promise<T> => {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body ?? {})
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `API Error: ${res.status} ${res.statusText}`);
    }
    if (!res.body) throw new Error('No response stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const { event, data } = parseEvent(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (event === 'thought') onProgress?.(data.status, data.interimImage, data.candidate);
        else if (event === 'candidate_done' || event === 'candidate_error') onCandidate?.(data);
        else if (event === 'done') return data as T;
        else if (event === 'error') throw new Error(data?.error || 'Request failed');
      }
      if (done) throw new Error('Connection closed before the server finished');
    }
  } finally {
    // The server logged the Gemini call(s); refresh the cost readout
    window.dispatchEvent(new Event(USAGE_LOGGED_EVENT));
  }
};

const withFullUrls = <T extends { url: string }>(v: T): T => ({ ...v, url: getFullUrl(v.url) || v.url });

// referenceVersionId: which render of the reference room to use (default: its current one)
export const generateRoomPrompt = (roomId: string, options: { userComments?: string; referenceVersionId?: string } = {}) =>
  postWithProgress<{ generatedPrompt: string; initialPrompt: string }>(`/rooms/${roomId}/prompt`, options);

export const refineRoomPrompt = (roomId: string, currentPrompt: string, feedback: string) =>
  postWithProgress<{ generatedPrompt: string }>(`/rooms/${roomId}/refine-prompt`, { currentPrompt, feedback });

export const renderRoom = async (
  roomId: string,
  options: {
    candidates?: number;
    referenceVersionId?: string;
    onProgress?: ProgressHandler;
    onCandidate?: (e: CandidateEvent) => void;
  } = {}
) => {
  const res = await postWithProgress<{
    url: string;
    currentVersionId: string;
    versions: SavedVersion[];
    requested: number;
    failed: number;
    errors: string[];
  }>(`/rooms/${roomId}/render`, {
    candidates: options.candidates ?? 1,
    referenceVersionId: options.referenceVersionId
  }, options.onProgress, options.onCandidate);
  return { ...withFullUrls(res), versions: res.versions.map(withFullUrls) };
};

export const editRoom = async (
  roomId: string,
  options: {
    instructions: string;
    rawPrompt?: boolean;
    intents?: string;
    baseVersionId?: string;
    // Optional Image 1: a room in the same session (at a version, default current) or an uploaded photo
    referenceRoomId?: string;
    referenceVersionId?: string;
    referenceImage?: string; // data URL
    referenceLabel?: string;
    onProgress?: ProgressHandler;
  }
) => {
  const { onProgress, ...body } = options;
  const res = await postWithProgress<{ url: string; currentVersionId: string; version: SavedVersion }>(
    `/rooms/${roomId}/edit`, body, onProgress
  );
  return { ...withFullUrls(res), version: withFullUrls(res.version) };
};
