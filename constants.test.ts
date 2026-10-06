import { describe, expect, it } from 'vitest';
import { DESIGNER_SYSTEM_PROMPT, REFERENCE_ANGLE_SYSTEM_PROMPT } from './constants';

describe('DESIGNER_SYSTEM_PROMPT', () => {
  it('keeps the camera angle and perspective lock section and its three all-caps phrases', () => {
    expect(DESIGNER_SYSTEM_PROMPT).toContain('CAMERA ANGLE AND PERSPECTIVE LOCK');
    expect(DESIGNER_SYSTEM_PROMPT).toContain('EXTREMELY STRICTLY KEEPING ALL ARCHITECTURE, CAMERA ANGLE, PERSPECTIVE');
    expect(DESIGNER_SYSTEM_PROMPT).toContain('ENSURING THAT NONE OF THE PERSPECTIVE IS CHANGED FROM THE ORIGINAL IMAGE');
    expect(DESIGNER_SYSTEM_PROMPT).toContain('THE EXACT SAME CAMERA ANGLE AND PERSPECTIVE MUST BE MAINTAINED THROUGHOUT THE ENTIRE IMAGE');
  });

  it('never uses a bare "always" in the room guidelines (needs a qualifier)', () => {
    const guidelines = DESIGNER_SYSTEM_PROMPT.split('ROOM-BY-ROOM GUIDELINES')[1].split('REFERENCE EXAMPLE OF AN APPROVED PROMPT')[0];
    const qualifier = /where it makes|\bif\b|unless|\bwhen\b/i;
    const offenders = guidelines.split('\n').filter(l => /\balways\b/i.test(l) && !qualifier.test(l));
    expect(offenders).toEqual([]);
  });
});

describe('REFERENCE_ANGLE_SYSTEM_PROMPT', () => {
  it('is unchanged from the reviewed snapshot (update the snapshot only as a deliberate act)', () => {
    expect(REFERENCE_ANGLE_SYSTEM_PROMPT).toMatchSnapshot();
  });
});
