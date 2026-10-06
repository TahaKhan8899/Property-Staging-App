// Server-side Gemini calls (prompt, refine, render, edit). The browser never sees the API key.
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import {
    MODEL_TEXT_ANALYSIS,
    MODEL_IMAGE_GENERATION,
    DESIGNER_SYSTEM_PROMPT,
    REFERENCE_ANGLE_SYSTEM_PROMPT,
    IMAGE_RESOLUTION,
    IMAGE_ASPECT_RATIO
} from '../shared/constants.js';
import {
    buildImageParts,
    buildEditPrompt,
    buildStagingUserPrompt,
    buildReferenceUserPrompt,
    buildRefinePrompt,
    collectImageFromStream,
    computeCallCost,
    retryWithBackoff
} from '../shared/gemini-core.js';

const IMAGE_TIMEOUT_MS = 5 * 60 * 1000; // 2K generation can take minutes

let clientOverride = null;
// Tests inject a fake client ({ models: { generateContent, generateContentStream } })
export const setGeminiClientForTests = (client) => { clientOverride = client; };

export const isGeminiConfigured = () => Boolean(clientOverride || process.env.GEMINI_API_KEY);

const getClient = () => {
    if (clientOverride) return clientOverride;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw Object.assign(
            new Error('GEMINI_API_KEY is not set on the server. Add it to .env.local and restart the server.'),
            { status: 500 }
        );
    }
    return new GoogleGenAI({ apiKey, httpOptions: { timeout: IMAGE_TIMEOUT_MS } });
};

// Final model image (data URL) -> JPEG buffer, flattened onto white in case of transparency
const toJpegBuffer = (dataUrl) =>
    sharp(Buffer.from(dataUrl.split(',')[1], 'base64'))
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 90 })
        .toBuffer();

// logCall(roomId, kind, model, usage, imageCount, error?) writes one api_calls row. It must never throw.
export const createGemini = ({ logCall }) => {
    const textCall = async (kind, roomId, request, failureLabel) => {
        try {
            const response = await getClient().models.generateContent({ model: MODEL_TEXT_ANALYSIS, ...request });
            logCall(roomId, kind, MODEL_TEXT_ANALYSIS, response.usageMetadata, 0);
            return response.text || '';
        } catch (error) {
            logCall(roomId, kind, MODEL_TEXT_ANALYSIS, undefined, 0, error);
            console.error(`Error in ${kind}:`, error);
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${failureLabel}: ${message}`);
        }
    };

    // One streamed image call (render or edit) with 503 retry. Returns a JPEG buffer.
    const imageCall = (kind, roomId, parts, onProgress, interimStatus) =>
        retryWithBackoff(async () => {
            const ai = getClient();
            let usage;
            try {
                const stream = await ai.models.generateContentStream({
                    model: MODEL_IMAGE_GENERATION,
                    contents: { parts },
                    config: { imageConfig: { imageSize: IMAGE_RESOLUTION, aspectRatio: IMAGE_ASPECT_RATIO } }
                });
                const result = await collectImageFromStream(stream, onProgress, interimStatus);
                usage = result.usage;
                if (!result.image) throw new Error('No image data returned from model.');
                const jpeg = await toJpegBuffer(result.image);
                logCall(roomId, kind, MODEL_IMAGE_GENERATION, usage, 1);
                return jpeg;
            } catch (error) {
                logCall(roomId, kind, MODEL_IMAGE_GENERATION, usage ?? error?.usage, 0, error);
                console.error(`Error in ${kind}:`, error);
                throw error;
            }
        }, 3, 2000);

    return {
        // image/reference are { mimeType, data(base64) }. With a reference this is the same-room/other-angle flow.
        generatePrompt: async ({ roomId, image, reference, roomLabel, userComments }) => {
            if (reference) {
                return textCall('reference_prompt', roomId, {
                    contents: { parts: [
                        { inlineData: reference },
                        { inlineData: image },
                        { text: buildReferenceUserPrompt(userComments) }
                    ] },
                    config: { systemInstruction: REFERENCE_ANGLE_SYSTEM_PROMPT }
                }, 'Failed to analyze images');
            }
            return textCall('prompt', roomId, {
                contents: { parts: [
                    { inlineData: image },
                    { text: buildStagingUserPrompt(roomLabel, userComments) }
                ] },
                config: { systemInstruction: DESIGNER_SYSTEM_PROMPT }
            }, 'Failed to analyze image');
        },

        refinePrompt: ({ roomId, currentPrompt, feedback }) =>
            textCall('refine', roomId, {
                contents: [{ role: 'user', parts: [{ text: buildRefinePrompt(currentPrompt, feedback) }] }]
            }, 'Failed to refine prompt'),

        renderImage: ({ roomId, image, reference, prompt, onProgress }) =>
            imageCall('generate', roomId, buildImageParts(image, prompt, reference), onProgress, 'Generating preview...'),

        editImage: ({ roomId, image, instructions, rawPrompt, onProgress }) =>
            imageCall('edit', roomId, buildImageParts(image, buildEditPrompt(instructions, { rawPrompt })), onProgress, 'Editing image...')
    };
};
