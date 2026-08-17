import { describe, expect, it } from 'vitest';

import { mergeTranscript, transcriptWordCount } from './transcript';

describe('mergeTranscript', () => {
  it('appends distinct text', () => {
    expect(mergeTranscript('hello world', 'this is Maina')).toBe('hello world this is Maina');
  });

  it('removes a recognizer boundary overlap', () => {
    expect(mergeTranscript('we discussed the launch date', 'the launch date is Friday')).toBe(
      'we discussed the launch date is Friday',
    );
  });

  it('handles Hindi text and whitespace', () => {
    expect(mergeTranscript('आज की मीटिंग में', 'मीटिंग में बजट तय हुआ')).toBe(
      'आज की मीटिंग में बजट तय हुआ',
    );
  });

  it('does not duplicate an identical partial', () => {
    expect(mergeTranscript('send the proposal tomorrow', 'send the proposal tomorrow')).toBe(
      'send the proposal tomorrow',
    );
  });
});

describe('transcriptWordCount', () => {
  it('counts normalized words', () => {
    expect(transcriptWordCount('  one   two\nthree ')).toBe(3);
  });
});
