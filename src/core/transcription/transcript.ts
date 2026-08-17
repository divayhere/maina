function normaliseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Merge recognizer finals/partials without repeating the overlap that Android
 * sometimes sends around session boundaries.
 */
export function mergeTranscript(existing: string, incoming: string): string {
  const left = normaliseWhitespace(existing);
  const right = normaliseWhitespace(incoming);
  if (!left) return right;
  if (!right) return left;

  const leftWords = left.split(' ');
  const rightWords = right.split(' ');
  const maxOverlap = Math.min(leftWords.length, rightWords.length, 24);

  for (let size = maxOverlap; size >= 1; size -= 1) {
    const suffix = leftWords.slice(-size).join(' ').toLocaleLowerCase();
    const prefix = rightWords.slice(0, size).join(' ').toLocaleLowerCase();
    if (suffix === prefix) {
      return [...leftWords, ...rightWords.slice(size)].join(' ');
    }
  }

  return `${left} ${right}`;
}

export function transcriptWordCount(value: string): number {
  const text = normaliseWhitespace(value);
  return text ? text.split(' ').length : 0;
}
