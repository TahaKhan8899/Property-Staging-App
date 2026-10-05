import { GoogleGenAI, MediaModality } from "@google/genai";
import type { GenerateContentResponseUsageMetadata } from "@google/genai";
import { MODEL_TEXT_ANALYSIS, MODEL_IMAGE_GENERATION, MODEL_PRICING, DESIGNER_SYSTEM_PROMPT, REFERENCE_ANGLE_SYSTEM_PROMPT, IMAGE_RESOLUTION, IMAGE_ASPECT_RATIO } from "../constants";
import { logApiCall } from "./db";
import type { ApiCallLog } from "./db";

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

// Retry utility with exponential backoff for handling 503 errors
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Only retry on 503 errors (service overloaded/unavailable)
      const errorStr = error?.message || String(error);
      if (errorStr.includes('503') || errorStr.includes('UNAVAILABLE')) {
        const delay = initialDelay * Math.pow(2, attempt);
        console.log(`Attempt ${attempt + 1} failed with 503. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // Don't retry other errors
        throw error;
      }
    }
  }

  throw lastError!;
}

// Best-effort mimeType for inlineData (File.type, else guess from URL extension)
const guessMimeType = (fileOrUrl: File | string): string => {
  if (typeof fileOrUrl !== 'string') return fileOrUrl.type || 'image/jpeg';
  const path = fileOrUrl.split(/[?#]/)[0].toLowerCase();
  return path.endsWith('.png') ? 'image/png' : 'image/jpeg';
};

// Log one Gemini call (success or failure) with its estimated cost. Fire-and-forget:
// a logging failure must never break staging.
const recordApiCall = (
  roomId: string | undefined,
  kind: ApiCallLog['kind'],
  model: string,
  usage: GenerateContentResponseUsageMetadata | undefined,
  imageCount: number,
  error?: unknown
) => {
  const promptTokens = usage?.promptTokenCount ?? 0;
  const thoughtsTokens = usage?.thoughtsTokenCount ?? 0;
  const candidatesTokens = usage?.candidatesTokenCount ?? 0;
  const imageDetails = usage?.candidatesTokensDetails?.filter(d => d.modality === MediaModality.IMAGE);
  // If the per-modality breakdown is missing, an image response's candidates are almost entirely image tokens
  const imageOutputTokens = imageDetails?.length
    ? imageDetails.reduce((sum, d) => sum + (d.tokenCount || 0), 0)
    : (imageCount > 0 ? candidatesTokens : 0);
  const textOutputTokens = Math.max(0, candidatesTokens - imageOutputTokens);
  const price = MODEL_PRICING[model];
  const costUsd = price
    ? (promptTokens * price.input + (textOutputTokens + thoughtsTokens) * price.textOutput + imageOutputTokens * price.imageOutput) / 1e6
    : 0;

  logApiCall({
    roomId,
    kind,
    model,
    status: error ? 'error' : 'ok',
    error: error ? (error instanceof Error ? error.message : String(error)).slice(0, 500) : undefined,
    promptTokens,
    textOutputTokens,
    thoughtsTokens,
    imageOutputTokens,
    imageCount,
    costUsd
  }).catch(err => console.warn('Failed to log API usage:', err));
};

// 1. Generate Staging Prompt
export const generateStagingPrompt = async (
  fileOrUrl: File | string,
  roomType: string,
  customLabel?: string,
  userComments?: string,
  roomId?: string
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

  let userPrompt = `
Analyze this ${actualLabel} and generate a detailed virtual staging prompt for it.
Follow the design rules in the system prompt.
Keep all architectural elements AND ESPECIALLY THE CAMERA ANGLE AND PERSPECTIVE exactly the same.
Study the photo's exact vantage point, field of view, and room proportions, and anchor every piece of furniture to where it appears in that frame so the staged image can be generated from the identical viewpoint.
Output only the staging prompt text.
`;

  if (userComments && userComments.trim()) {
    userPrompt += `
IMPORTANT USER NOTES: The user has requested the following specific details be included or considered: "${userComments.trim()}". 
Please integrate these requests into the staging prompt while maintaining the overall design rules and perspective.
`;
  }

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

    recordApiCall(roomId, 'prompt', MODEL_TEXT_ANALYSIS, response.usageMetadata, 0);
    return response.text || "Failed to generate prompt.";
  } catch (error) {
    recordApiCall(roomId, 'prompt', MODEL_TEXT_ANALYSIS, undefined, 0, error);
    console.error("Error generating prompt:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to analyze image: ${errorMessage}`);
  }
};

// 1.2 Generate Staging Prompt from a staged reference of the same room (different camera angle)
// Image 1 = staged reference, Image 2 = empty target. Uses the meta-prompt workflow.
export const generateReferenceAnglePrompt = async (
  referenceFileOrUrl: File | string,
  targetFileOrUrl: File | string,
  userComments?: string,
  roomId?: string
): Promise<string> => {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("API Key not found. Please select or enter a valid API key.");

  const ai = new GoogleGenAI({ apiKey });

  const [referenceData, targetData] = await Promise.all([
    fileToGenerativePart(referenceFileOrUrl),
    fileToGenerativePart(targetFileOrUrl)
  ]);

  let userPrompt = 'Image 1 is the staged reference. Image 2 is the empty target. Output only the staging prompt.';
  if (userComments && userComments.trim()) {
    userPrompt += `\nExtra context about the images from a human: ${userComments.trim()}`;
  }

  try {
    const response = await ai.models.generateContent({
      model: MODEL_TEXT_ANALYSIS,
      contents: {
        parts: [
          { inlineData: { mimeType: guessMimeType(referenceFileOrUrl), data: referenceData } },
          { inlineData: { mimeType: guessMimeType(targetFileOrUrl), data: targetData } },
          { text: userPrompt }
        ]
      },
      config: {
        systemInstruction: REFERENCE_ANGLE_SYSTEM_PROMPT,
      }
    });

    recordApiCall(roomId, 'reference_prompt', MODEL_TEXT_ANALYSIS, response.usageMetadata, 0);
    return response.text || "Failed to generate prompt.";
  } catch (error) {
    recordApiCall(roomId, 'reference_prompt', MODEL_TEXT_ANALYSIS, undefined, 0, error);
    console.error("Error generating reference-angle prompt:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to analyze images: ${errorMessage}`);
  }
};

// 1.5 Refine Prompt
export const refinePrompt = async (
  currentPrompt: string,
  userFeedback: string,
  roomId?: string
): Promise<string> => {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("API Key not found.");

  const ai = new GoogleGenAI({ apiKey });

  const refinementPrompt = `
You are an expert interior designer. 
Analyze the following staging prompt and the user's requested changes.
Modify the prompt to incorporate the user's feedback while keeping the rest of the style, structure, and details consistent.
Do NOT change, remove, or weaken any camera angle, perspective, or "keep exactly the same" instructions (including the ALL CAPS reinforcements in the opening, middle, and closing). Any furniture you add must be anchored to its position in the original frame and aligned to the original floor perspective.
Output ONLY the new, complete staging prompt text.

CURRENT PROMPT:
"${currentPrompt}"

USER FEEDBACK:
"${userFeedback}"
`;

  try {
    const result = await ai.models.generateContent({
      model: MODEL_TEXT_ANALYSIS,
      contents: [
        {
          role: 'user',
          parts: [{ text: refinementPrompt }]
        }
      ]
    });
    recordApiCall(roomId, 'refine', MODEL_TEXT_ANALYSIS, result.usageMetadata, 0);
    return result.text || "Failed to refine prompt.";
  } catch (error) {
    recordApiCall(roomId, 'refine', MODEL_TEXT_ANALYSIS, undefined, 0, error);
    console.error("Error refining prompt:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to refine prompt: ${errorMessage}`);
  }
};

// 2. Generate Staged Image
export const generateStagedImage = async (
  originalFileOrUrl: File | string,
  prompt: string,
  onProgress?: (status: string, interimImage?: string) => void,
  referenceFileOrUrl?: File | string, // Optional staged reference (sent as Image 1, before the target)
  roomId?: string
): Promise<string> => {
  // Wrap the entire image generation in retry logic
  return retryWithBackoff(async () => {
    // Re-instantiate for latest key
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("API Key not found. Please select or enter a valid API key.");

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: 5 * 60 * 1000 // 5 minutes timeout for 2K image generation
      }
    });

    const base64Data = await fileToGenerativePart(originalFileOrUrl);

    let mimeType = 'image/jpeg';
    if (typeof originalFileOrUrl !== 'string') {
      mimeType = originalFileOrUrl.type;
    } else {
      if (originalFileOrUrl.toLowerCase().endsWith('.png')) mimeType = 'image/png';
    }

    const referenceParts = referenceFileOrUrl
      ? [{
        inlineData: {
          mimeType: guessMimeType(referenceFileOrUrl),
          data: await fileToGenerativePart(referenceFileOrUrl)
        }
      }]
      : [];

    let usage: GenerateContentResponseUsageMetadata | undefined;
    let logged = false;
    try {
      const responseStream = await ai.models.generateContentStream({
        model: MODEL_IMAGE_GENERATION,
        contents: {
          parts: [
            ...referenceParts,
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
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
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
        recordApiCall(roomId, 'generate', MODEL_IMAGE_GENERATION, usage, 1);
        logged = true;
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
      if (!logged) recordApiCall(roomId, 'generate', MODEL_IMAGE_GENERATION, usage, 0, error);
      console.error("Error generating staged image:", error);
      // Provide more detailed error information
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to generate staged image: ${errorMessage}`);
    }
  }, 3, 2000); // 3 retries, starting with 2 second delay
};

// 3. Edit Generated Image
export const editGeneratedImage = async (
  generatedImageUrl: string,
  editInstructions: string,
  onProgress?: (status: string, interimImage?: string) => void,
  roomId?: string
): Promise<string> => {
  // Wrap the entire image editing in retry logic
  return retryWithBackoff(async () => {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("API Key not found. Please select or enter a valid API key.");

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: 5 * 60 * 1000 // 5 minutes timeout for 2K image editing
      }
    });

    // Convert the generated image URL to base64
    const base64Data = await fileToGenerativePart(generatedImageUrl);

    // Construct the edit prompt using the template
    const editPrompt = `Generate this exact same image, but make the following specific edits only:

${editInstructions}

Keep everything else IDENTICAL, including but not limited to:

Structural elements

Camera angle

Perspective

Lighting and shadows

Flooring, walls, windows, doors, and trim

Existing furniture, décor, materials, and object placement

Color palette and overall composition

Wall art, shelving, rugs, bedding, and any other item not listed above, including their color, style, and position

Do not add any new objects unless explicitly listed above, and do not modify architecture or change the scene in any other way.`;

    let usage: GenerateContentResponseUsageMetadata | undefined;
    let logged = false;
    try {
      const responseStream = await ai.models.generateContentStream({
        model: MODEL_IMAGE_GENERATION,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: guessMimeType(generatedImageUrl),
                data: base64Data
              }
            },
            { text: editPrompt }
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
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        const candidates = chunk.candidates;
        if (candidates && candidates.length > 0) {
          for (const part of candidates[0].content.parts) {
            // Check for Text (Thoughts)
            if ((part as any).thought) {
              if (part.text && onProgress) {
                onProgress(part.text, undefined);
              }
              // Check for Interim Images
              if (part.inlineData && part.inlineData.data && onProgress) {
                const mime = part.inlineData.mimeType || 'image/png';
                const rawBase64 = `data:${mime};base64,${part.inlineData.data}`;
                onProgress(part.text || "Editing image...", rawBase64);
              }
            }

            // Check for Final Image
            if (part.inlineData && part.inlineData.data) {
              if (!(part as any).thought) {
                const mime = part.inlineData.mimeType || 'image/png';
                finalImageBase64 = `data:${mime};base64,${part.inlineData.data}`;
              }
            }
          }
        }
      }

      if (finalImageBase64) {
        recordApiCall(roomId, 'edit', MODEL_IMAGE_GENERATION, usage, 1);
        logged = true;
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
          img.onerror = (err) => reject(new Error('Failed to load edited image for conversion'));
          img.src = finalImageBase64!;
        });
      }

      throw new Error("No image data returned from model.");
    } catch (error) {
      if (!logged) recordApiCall(roomId, 'edit', MODEL_IMAGE_GENERATION, usage, 0, error);
      console.error("Error editing image:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to edit image: ${errorMessage}`);
    }
  }, 3, 2000); // 3 retries, starting with 2 second delay
};
