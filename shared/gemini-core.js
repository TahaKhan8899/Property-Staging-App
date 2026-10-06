// Gemini helpers with no browser or Express dependencies. Used by server/gemini.js and unit tests.
import { MediaModality } from '@google/genai';
import { MODEL_PRICING } from './constants.js';

// Best-effort mimeType for inlineData (File.type, else guess from the path extension)
export const guessMimeType = (fileOrUrl) => {
  if (typeof fileOrUrl !== 'string') return fileOrUrl.type || 'image/jpeg';
  const p = fileOrUrl.split(/[?#]/)[0].toLowerCase();
  return p.endsWith('.png') ? 'image/png' : 'image/jpeg';
};

// Parts for an image call: optional reference first (Image 1), then the target image, then the text
export const buildImageParts = (target, text, reference) => [
  ...(reference ? [{ inlineData: { mimeType: reference.mimeType, data: reference.data } }] : []),
  { inlineData: { mimeType: target.mimeType, data: target.data } },
  { text }
];

// Wrap the user's edit instructions in the standard "change only this" template.
// rawPrompt sends the text untouched (for prompts that already carry their own keep list).
export const buildEditPrompt = (editInstructions, options = {}) => {
  if (options.rawPrompt) return editInstructions;
  return `Generate this exact same image, but make the following specific edits only:

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
};

// User message for the first-pass staging prompt (system prompt is DESIGNER_SYSTEM_PROMPT)
export const buildStagingUserPrompt = (roomLabel, userComments) => {
  let userPrompt = `
Analyze this ${roomLabel} and generate a detailed virtual staging prompt for it.
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
  return userPrompt;
};

// User message for the same-room / other-angle prompt (system prompt is REFERENCE_ANGLE_SYSTEM_PROMPT)
export const buildReferenceUserPrompt = (userComments) => {
  let userPrompt = 'Image 1 is the staged reference. Image 2 is the empty target. Output only the staging prompt.';
  if (userComments && userComments.trim()) {
    userPrompt += `\nExtra context about the images from a human: ${userComments.trim()}`;
  }
  return userPrompt;
};

export const buildRefinePrompt = (currentPrompt, userFeedback) => `
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

// Read an image-model stream: thought text and interim images go to onProgress, the last
// non-thought image is the result, and the latest usageMetadata is kept for cost logging.
// If the stream throws midway, the error carries the usage seen so far as error.usage.
export const collectImageFromStream = async (stream, onProgress, interimStatus = 'Generating preview...') => {
  let image = null;
  let usage;

  try {
    for await (const chunk of stream) {
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      const candidates = chunk.candidates;
      if (!candidates || candidates.length === 0) continue;
      for (const part of candidates[0].content?.parts ?? []) {
        // Thoughts come back as parts with thought: true (text and/or interim images)
        if (part.thought) {
          if (part.text && onProgress) onProgress(part.text, undefined);
          if (part.inlineData?.data && onProgress) {
            const mime = part.inlineData.mimeType || 'image/png';
            onProgress(part.text || interimStatus, `data:${mime};base64,${part.inlineData.data}`);
          }
        } else if (part.inlineData?.data) {
          const mime = part.inlineData.mimeType || 'image/png';
          image = `data:${mime};base64,${part.inlineData.data}`;
        }
      }
    }
  } catch (err) {
    if (err && typeof err === 'object') err.usage = usage;
    throw err;
  }

  return { image, usage };
};

// Token breakdown and estimated USD cost of one call, from MODEL_PRICING
export const computeCallCost = (model, usage, imageCount) => {
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
  return { promptTokens, textOutputTokens, thoughtsTokens, imageOutputTokens, costUsd };
};

// Retry with exponential backoff, only for 503 / UNAVAILABLE (service overloaded)
export const retryWithBackoff = async (fn, maxRetries = 3, initialDelay = 1000) => {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const errorStr = error?.message || String(error);
      if (errorStr.includes('503') || errorStr.includes('UNAVAILABLE')) {
        const delay = initialDelay * Math.pow(2, attempt);
        console.log(`Attempt ${attempt + 1} failed with 503. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw lastError;
};
