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

describe('DESIGNER_SYSTEM_PROMPT rules from 504-201', () => {
  // Each standing rule keeps its qualifier (constraint 5)
  it.each([
    ['toilet lid', 'Where a toilet is visible, show its lid closed.'],
    ['towels without a bar', 'Where there is no towel bar, fold towels neatly on the tub ledge or vanity.'],
    ['stool count', 'If a peninsula or island is visible, include two to three counter stools'],
    ['stool side', 'If the peninsula or island has a seating overhang on the living or dining side, place the stools on that side'],
    ['cabinet faces', 'Keep the exact number of cabinet doors and drawers on every visible cabinet face'],
    ['patio divider', 'If a divider railing or partition separates this patio from a neighbouring one, stage only the side nearest the camera'],
    ['dining style', 'Where a dining table fits, prefer a round walnut pedestal table with cream upholstered chairs on slim black metal legs. Small variations of this style are fine.'],
  ])('has the %s rule', (_, rule) => {
    expect(DESIGNER_SYSTEM_PROMPT).toContain(rule);
  });
});

describe('REFERENCE_ANGLE_SYSTEM_PROMPT', () => {
  it('is unchanged from the reviewed snapshot (update the snapshot only as a deliberate act)', () => {
    expect(REFERENCE_ANGLE_SYSTEM_PROMPT).toMatchSnapshot();
  });
});
