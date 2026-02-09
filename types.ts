export enum RoomType {
  Bedroom = 'Bedroom',
  LivingRoom = 'Living Room',
  Kitchen = 'Kitchen',
  Bathroom = 'Bathroom',
  PatioBalcony = 'Patio',
  Other = 'Other',
}

export type SessionStatus = 'not_started' | 'in_progress' | 'completed';
export type RoomStatus = 'in_progress' | 'done';

export interface PromptSnapshot {
  basePrompt?: string | null;
  editInstruction?: string | null;
  source?: string;
  capturedAt?: number;
  notes?: string;
  rawPrompt?: string | null;
}

export interface ImageVersion {
  id: string;
  roomId: string;
  url: string;
  timestamp: number;
  description: string;
  versionNumber: number;
  promptSnapshot?: PromptSnapshot | string | null;
}

export interface RoomData {
  id: string;
  file: File;
  previewUrl: string;
  roomType: RoomType;
  customLabel: string;
  roomStatus?: RoomStatus;

  // Prompt State
  initialThoughts?: string; // User's initial ideas before generation
  initialPrompt?: string; // Stores the original AI output for reset functionality
  generatedPrompt: string;
  isGeneratingPrompt: boolean;
  isPromptApproved: boolean;

  // Image Generation State
  generatedImageUrl?: string;
  isGeneratingImage: boolean;
  isEditingImage?: boolean;
  error?: string;

  // Version History
  imageVersions?: ImageVersion[];
  currentVersionId?: string;
}

export interface Session {
  id: string;
  name: string;
  lastModified: number;
  status: SessionStatus;
  rooms: RoomData[];
}

declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }
  interface Window {
    aistudio?: AIStudio;
  }
}
