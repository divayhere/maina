import { describe, expect, it } from 'vitest';

import {
  appendWithoutOverlap,
  mergeTranscript,
  splitTranscriptChunks,
  transcriptWordCount,
} from './transcript';

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

describe('appendWithoutOverlap', () => {
  it('returns only the appended tail after a recognizer overlap', () => {
    expect(appendWithoutOverlap('we discussed the launch date', 'the launch date is Friday')).toBe(
      'is Friday',
    );
  });

  it('returns an empty string when the incoming text is fully duplicated', () => {
    expect(appendWithoutOverlap('send the proposal tomorrow', 'send the proposal tomorrow')).toBe('');
  });

  it('returns only the corrected tail when a flushed partial becomes a longer final', () => {
    expect(appendWithoutOverlap('hello wor', 'hello world')).toBe('ld');
  });
});

describe('splitTranscriptChunks', () => {
  it('keeps short text in one chunk', () => {
    expect(splitTranscriptChunks('hello from Maina')).toEqual([
      { text: 'hello from Maina', wordCount: 3, charCount: 16 },
    ]);
  });

  it('splits long text on conservative word caps', () => {
    const input = Array.from({ length: 9 }, (_, index) => `word${index + 1}`).join(' ');
    expect(splitTranscriptChunks(input, { maxWords: 4, maxChars: 1000 })).toEqual([
      { text: 'word1 word2 word3 word4', wordCount: 4, charCount: 23 },
      { text: 'word5 word6 word7 word8', wordCount: 4, charCount: 23 },
      { text: 'word9', wordCount: 1, charCount: 5 },
    ]);
  });
});
