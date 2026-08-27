import { describe, expect, it } from 'vitest';

import { markdownToReadableText } from './plainText';

describe('markdownToReadableText', () => {
  it('removes provider formatting without changing the underlying words', () => {
    expect(markdownToReadableText([
      '### Operations Review Summary',
      '',
      '**Scope of Review:** The team reviewed inventory.',
      '- Final report remains due Tuesday.',
    ].join('\n'))).toBe([
      'Operations Review Summary',
      '',
      'Scope of Review: The team reviewed inventory.',
      '• Final report remains due Tuesday.',
    ].join('\n'));
  });

  it('normalizes quotes, inline emphasis, code, and excessive blank lines', () => {
    expect(markdownToReadableText('> _Owner:_ `Divay`\n\n\n\nNo **change**.'))
      .toBe('Owner: Divay\n\nNo change.');
  });
});
