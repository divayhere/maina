import { describe, expect, it } from 'vitest';

import { MEETING_TITLE_MAX_LENGTH, normalizeMeetingTitle } from './meetingWorkspace';

describe('normalizeMeetingTitle', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeMeetingTitle('  Investor   catch-up\nAugust  ')).toBe('Investor catch-up August');
  });

  it('uses the fallback when the title is blank', () => {
    expect(normalizeMeetingTitle(' \n ', 'Meeting · 4:15 pm')).toBe('Meeting · 4:15 pm');
  });

  it('caps titles without leaving trailing whitespace', () => {
    expect(normalizeMeetingTitle(`${'a'.repeat(MEETING_TITLE_MAX_LENGTH)}  more`)).toHaveLength(MEETING_TITLE_MAX_LENGTH);
  });
});
