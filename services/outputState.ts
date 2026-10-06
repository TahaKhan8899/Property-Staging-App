import type { RoomData } from '../types';

// "/uploads/<Session>/staged/x.jpg" (or full URL) -> "staged/x.jpg", the form stored in outputSourcePath
export const toSessionRelativePath = (url?: string) => {
  if (!url) return '';
  const afterUploads = url.split('/uploads/')[1];
  if (!afterUploads) return '';
  let decoded = afterUploads;
  try { decoded = decodeURIComponent(afterUploads); } catch { /* keep raw */ }
  return decoded.split('/').slice(1).join('/');
};

export const isCurrentVersionInOutput = (room: Pick<RoomData, 'outputSourcePath' | 'generatedImageUrl'>) =>
  Boolean(room.outputSourcePath) && room.outputSourcePath === toSessionRelativePath(room.generatedImageUrl);

// In output, but the room now shows a different version than the one copied there
export const hasStaleOutput = (room: Pick<RoomData, 'outputSourcePath' | 'generatedImageUrl'>) =>
  Boolean(room.outputSourcePath) && !isCurrentVersionInOutput(room);
