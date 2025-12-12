import { GoogleGenAI } from "@google/genai";
import { MODEL_TEXT_ANALYSIS, MODEL_IMAGE_GENERATION, DESIGNER_SYSTEM_PROMPT, IMAGE_RESOLUTION, IMAGE_ASPECT_RATIO } from "../constants";

// Helper to convert file to base64
export const fileToGenerativePart = async (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      // Remove data url prefix (e.g. "data:image/jpeg;base64,")
      const base64Data = base64String.split(',')[1];
      resolve(base64Data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

// Helper to retrieve API key directly from storage or env
export const getApiKey = (): string | undefined => {
  if (import.meta.env.VITE_GEMINI_API_KEY) {
    return import.meta.env.VITE_GEMINI_API_KEY;
  }
  const stored = localStorage.getItem('gemini_api_key');
  if (stored) return stored;
  return process.env.API_KEY;
};

// 1. Generate Staging Prompt
export const generateStagingPrompt = async (
  file: File, 
  roomType: string, 
  customLabel?: string
): Promise<string> => {
  // Re-instantiate to ensure we catch the latest API key from environment if it was just selected
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("API Key not found. Please select or enter a valid API key.");
  
  const ai = new GoogleGenAI({ apiKey });
  
  const base64Data = await fileToGenerativePart(file);
  const actualLabel = roomType === 'Other' ? customLabel || 'Room' : roomType;

  const userPrompt = `
Analyze this ${actualLabel} and generate a detailed virtual staging prompt for it.
Follow the design rules in the system prompt.
Keep all architectural elements AND EXPECIALLY THE CAMERA ANGLE AND PERSPECTIVE exactly the same.
Output only the staging prompt text.
`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL_TEXT_ANALYSIS,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: file.type,
              data: base64Data
            }
          },
          { text: userPrompt }
        ]
      },
      config: {
        systemInstruction: DESIGNER_SYSTEM_PROMPT,
      }
    });

    return response.text || "Failed to generate prompt.";
  } catch (error) {
    console.error("Error generating prompt:", error);
    throw new Error("Failed to analyze image. Please try again.");
  }
};

// 2. Generate Staged Image
export const generateStagedImage = async (
  originalFile: File,
  prompt: string
): Promise<string> => {
  // Re-instantiate for latest key
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("API Key not found. Please select or enter a valid API key.");

  const ai = new GoogleGenAI({ apiKey });
  
  const base64Data = await fileToGenerativePart(originalFile);

  try {
    const response = await ai.models.generateContent({
      model: MODEL_IMAGE_GENERATION,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: originalFile.type,
              data: base64Data
            }
          },
          { text: `${prompt}` }
        ]
      },
      config: {
        imageConfig: {
          imageSize: IMAGE_RESOLUTION, 
          aspectRatio: IMAGE_ASPECT_RATIO 
        }
      }
    });

    // Check for image part in response
    const candidates = response.candidates;
    if (candidates && candidates.length > 0) {
      for (const part of candidates[0].content.parts) {
        if (part.inlineData && part.inlineData.data) {
          return `data:image/png;base64,${part.inlineData.data}`;
        }
      }
    }
    
    throw new Error("No image data returned from model.");
  } catch (error) {
    console.error("Error generating staged image:", error);
    throw new Error("Failed to generate staged image. Ensure you are using a paid API key for high-quality generation.");
  }
};