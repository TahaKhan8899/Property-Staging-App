import { GoogleGenAI } from "@google/genai";
import { MODEL_TEXT_ANALYSIS, MODEL_IMAGE_GENERATION, DESIGNER_SYSTEM_PROMPT, IMAGE_RESOLUTION, IMAGE_ASPECT_RATIO } from "../constants";

// Helper to convert file or URL to base64
export const fileToGenerativePart = async (fileOrUrl: File | string): Promise<string> => {
  // If it's a string (URL), fetch it first
  if (typeof fileOrUrl === 'string') {
    try {
      const response = await fetch(fileOrUrl);
      if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64String = reader.result as string;
          const base64Data = base64String.split(',')[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      console.error("Error converting URL to base64:", error);
      throw error;
    }
  }

  // It's a File object
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      // Remove data url prefix (e.g. "data:image/jpeg;base64,")
      const base64Data = base64String.split(',')[1];
      resolve(base64Data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(fileOrUrl);
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
  fileOrUrl: File | string,
  roomType: string,
  customLabel?: string
): Promise<string> => {
  // Re-instantiate to ensure we catch the latest API key from environment if it was just selected
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("API Key not found. Please select or enter a valid API key.");

  const ai = new GoogleGenAI({ apiKey });

  const base64Data = await fileToGenerativePart(fileOrUrl);
  const actualLabel = roomType === 'Other' ? customLabel || 'Room' : roomType;

  // Determine mimeType for inlineData. 
  // If it's a File, we use file.type. 
  // If it's a URL, we can guess or rely on the fetch... simpler: fetch usually gets it right, 
  // but here we just need to pass a string to Gemini. 
  // Actually Gemini API expects mimeType. 
  // Let's improve fileToGenerativePart to return { mimeType, data } or just handle it here.
  // For simplicity, let's assume image/jpeg if unknown or extract from blob.
  // Ideally `fileToGenerativePart` should return the full object needed for `inlineData`.

  // Refactor: We won't fundamentally change the helper return type to keep diff small, 
  // but we need mimeType.
  // If string, we don't easily know mimeType without the Blob.
  // Let's assume generic image for now or extract from URL extension if possible.
  // However, simpler approach: The API often accepts generic "image/jpeg" or "image/png".
  // Let's try to be smarter.
  let mimeType = 'image/jpeg';
  if (typeof fileOrUrl !== 'string') {
    mimeType = fileOrUrl.type;
  } else {
    // Try to guess from URL
    if (fileOrUrl.toLowerCase().endsWith('.png')) mimeType = 'image/png';
    // If we fetched it in helper, we had the blob. 
    // Maybe we should have the helper return { data, mimeType }?
    // THAT would be cleaner but changes the signature more. 
    // Let's stick to the plan of minimal changes first. 
    // Wait, if I fetch in helper, I lose the mimeType info. 
    // I should update helper to return { data, mimeType }.
  }

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
              mimeType: mimeType, // This might be wrong if URL is PNG but we default to JPEG. Usually fine.
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
  originalFileOrUrl: File | string,
  prompt: string,
  onProgress?: (status: string, interimImage?: string) => void
): Promise<string> => {
  // Re-instantiate for latest key
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("API Key not found. Please select or enter a valid API key.");

  const ai = new GoogleGenAI({ apiKey });

  const base64Data = await fileToGenerativePart(originalFileOrUrl);

  let mimeType = 'image/jpeg';
  if (typeof originalFileOrUrl !== 'string') {
    mimeType = originalFileOrUrl.type;
  } else {
    if (originalFileOrUrl.toLowerCase().endsWith('.png')) mimeType = 'image/png';
  }

  try {
    const responseStream = await ai.models.generateContentStream({
      model: MODEL_IMAGE_GENERATION,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: mimeType,
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

    let finalImageBase64: string | null = null;

    for await (const chunk of responseStream) {
      const candidates = chunk.candidates;
      if (candidates && candidates.length > 0) {
        for (const part of candidates[0].content.parts) {
          // Check for Text (Thoughts)
          // The SDK/API returns thoughts as text parts with a 'thought' property being true,
          // but the SDK typing might not strictly expose 'thought' on Part yet depending on version.
          // Based on docs: "if (part.thought)"
          if ((part as any).thought) {
            if (part.text && onProgress) {
              onProgress(part.text, undefined);
            }
            // Check for Interim Images (InlineData inside thought)
            if (part.inlineData && part.inlineData.data && onProgress) {
              const mime = part.inlineData.mimeType || 'image/png';
              const rawBase64 = `data:${mime};base64,${part.inlineData.data}`;
              onProgress(part.text || "Generating preview...", rawBase64);
            }
          }
          // Check for Final Image (InlineData NOT marked as thought, or just the last image)
          // The docs say: "The last image within Thinking is also the final rendered image."
          // But usually the final response part contains the result.
          // We will look for inlineData.

          if (part.inlineData && part.inlineData.data) {
            // We'll treat every image as potentially final or interim.
            // If it's a thought, we streamed it. 
            // If it's NOT a thought, it's likely the final one.
            if (!(part as any).thought) {
              const mime = part.inlineData.mimeType || 'image/png';
              finalImageBase64 = `data:${mime};base64,${part.inlineData.data}`;
            }
          }
        }
      }
    }

    if (finalImageBase64) {
      // Convert to JPG client-side
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Failed to get canvas context'));
            return;
          }
          // Draw white background in case of transparency
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          const jpgDataUrl = canvas.toDataURL('image/jpeg', 0.9); // 90% quality
          resolve(jpgDataUrl);
        };
        img.onerror = (err) => reject(new Error('Failed to load generated image for conversion'));
        img.src = finalImageBase64!;
      });
    }

    throw new Error("No image data returned from model.");
  } catch (error) {
    console.error("Error generating staged image:", error);
    throw new Error("Failed to generate staged image. Ensure you are using a paid API key for high-quality generation.");
  }
};