import { describe, expect, it } from 'vitest';
import { MediaModality } from '@google/genai';
import type { GenerateContentResponse } from '@google/genai';
import { MODEL_PRICING } from '../../constants';
import { buildEditPrompt, buildImageParts, collectImageFromStream, computeCallCost, guessMimeType } from '../geminiService';

const img = (tag: string) => ({ mimeType: 'image/jpeg', data: tag });

describe('buildEditPrompt', () => {
  it('wraps the instructions with the keep-identical block and closing sentence', () => {
    const p = buildEditPrompt('Make the sofa blue');
    expect(p).toContain('Make the sofa blue');
    expect(p).toContain('Keep everything else IDENTICAL');
    expect(p.trim().endsWith('do not modify architecture or change the scene in any other way.')).toBe(true);
    expect(p).toContain('Do not add any new objects unless explicitly listed above');
  });

  it('passes text through untouched with rawPrompt', () => {
    const raw = 'Keep exactly as they are:\n- a rug\nChanges:\n1. remove the table';
    expect(buildEditPrompt(raw, { rawPrompt: true })).toBe(raw);
  });
});

describe('buildImageParts', () => {
  it('orders parts [reference, target, text] with a reference', () => {
    const parts = buildImageParts(img('T'), 'go', img('R'));
    expect(parts).toHaveLength(3);
    expect((parts[0] as any).inlineData.data).toBe('R');
    expect((parts[1] as any).inlineData.data).toBe('T');
    expect((parts[2] as any).text).toBe('go');
  });

  it('orders parts [target, text] without a reference', () => {
    const parts = buildImageParts(img('T'), 'go');
    expect(parts).toHaveLength(2);
    expect((parts[0] as any).inlineData.data).toBe('T');
    expect((parts[1] as any).text).toBe('go');
  });
});

describe('guessMimeType', () => {
  it('handles extensions, query strings and File objects', () => {
    expect(guessMimeType('/uploads/a/Kitchen 1.png')).toBe('image/png');
    expect(guessMimeType('/uploads/a/Kitchen 1.PNG?v=2')).toBe('image/png');
    expect(guessMimeType('/uploads/a/Kitchen 1.jpg#x')).toBe('image/jpeg');
    expect(guessMimeType(new File(['x'], 'a.png', { type: 'image/png' }))).toBe('image/png');
    expect(guessMimeType(new File(['x'], 'a.bin'))).toBe('image/jpeg');
  });
});

async function* fakeStream(chunks: Partial<GenerateContentResponse>[]) {
  for (const c of chunks) yield c as GenerateContentResponse;
}

describe('collectImageFromStream', () => {
  it('returns the final image, reports thoughts via onProgress and keeps usage', async () => {
    const usage = { promptTokenCount: 10, candidatesTokenCount: 20 };
    const progress: [string, string | undefined][] = [];
    const result = await collectImageFromStream(
      fakeStream([
        { candidates: [{ content: { parts: [{ thought: true, text: 'thinking' }] } }] } as any,
        { candidates: [{ content: { parts: [{ thought: true, inlineData: { mimeType: 'image/png', data: 'THOUGHT' } }] } }] } as any,
        { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'FINAL' } }] } }], usageMetadata: usage } as any,
        { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 25 } } as any,
      ]),
      (s, i) => progress.push([s, i]),
      'Preview...'
    );
    expect(result.image).toBe('data:image/png;base64,FINAL');
    expect(result.usage?.candidatesTokenCount).toBe(25);
    expect(progress[0]).toEqual(['thinking', undefined]);
    expect(progress[1]).toEqual(['Preview...', 'data:image/png;base64,THOUGHT']);
  });

  it('returns null image when the stream has none', async () => {
    const result = await collectImageFromStream(fakeStream([{ candidates: [{ content: { parts: [{ text: 'hi' }] } }] } as any]));
    expect(result.image).toBeNull();
  });
});

describe('computeCallCost', () => {
  it('matches MODEL_PRICING for image + text modalities', () => {
    const model = 'gemini-3-pro-image';
    const usage = {
      promptTokenCount: 1000,
      thoughtsTokenCount: 500,
      candidatesTokenCount: 1300,
      candidatesTokensDetails: [
        { modality: MediaModality.IMAGE, tokenCount: 1120 },
        { modality: MediaModality.TEXT, tokenCount: 180 },
      ],
    };
    const r = computeCallCost(model, usage as any, 1);
    const p = MODEL_PRICING[model];
    expect(r.imageOutputTokens).toBe(1120);
    expect(r.textOutputTokens).toBe(180);
    expect(r.costUsd).toBeCloseTo((1000 * p.input + (180 + 500) * p.textOutput + 1120 * p.imageOutput) / 1e6, 10);
  });

  it('treats candidates as image tokens when the breakdown is missing, and is 0 for unknown models', () => {
    const usage = { promptTokenCount: 0, candidatesTokenCount: 1120 };
    expect(computeCallCost('gemini-3-pro-image', usage as any, 1).imageOutputTokens).toBe(1120);
    expect(computeCallCost('mystery-model', usage as any, 1).costUsd).toBe(0);
  });
});
