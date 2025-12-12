export enum RoomType {
  Bedroom = 'Bedroom',
  LivingRoom = 'Living Room',
  Kitchen = 'Kitchen',
  Bathroom = 'Bathroom',
  PatioBalcony = 'Patio',
  Other = 'Other',
}

export interface RoomData {
  id: string;
  file: File;
  previewUrl: string;
  roomType: RoomType;
  customLabel: string;

  // Prompt State
  initialThoughts?: string; // User's initial ideas before generation
  initialPrompt?: string; // Stores the original AI output for reset functionality
  generatedPrompt: string;
  isGeneratingPrompt: boolean;
  isPromptApproved: boolean;

  // Image Generation State
  generatedImageUrl?: string;
  isGeneratingImage: boolean;
  error?: string;
}

export interface Session {
  id: string;
  name: string;
  lastModified: number;
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