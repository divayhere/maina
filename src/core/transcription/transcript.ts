export interface TranscriptChunk {
  text: string;
  wordCount: number;
  charCount: number;
}

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

export function appendWithoutOverlap(previous: string, incoming: string): string {
  const left = normaliseWhitespace(previous);
  const right = normaliseWhitespace(incoming);
  if (!left) return right;
  if (!right) return '';
  if (right === left || left.startsWith(right)) return '';
  if (right.startsWith(left)) return right.slice(left.length).trim();
  const merged = mergeTranscript(left, incoming);
  if (merged === left) return '';
  const appended = merged.slice(left.length).trim();
  return appended;
}

export function splitTranscriptChunks(
  value: string,
  options?: { maxWords?: number; maxChars?: number },
): TranscriptChunk[] {
  const text = normaliseWhitespace(value);
  if (!text) return [];

  const maxWords = Math.max(1, options?.maxWords ?? 120);
  const maxChars = Math.max(40, options?.maxChars ?? 800);
  const words = text.split(' ');
  const chunks: TranscriptChunk[] = [];
  let currentWords: string[] = [];

  const flush = () => {
    if (currentWords.length === 0) return;
    const chunkText = currentWords.join(' ');
    chunks.push({
      text: chunkText,
      wordCount: currentWords.length,
      charCount: chunkText.length,
    });
    currentWords = [];
  };

  for (const word of words) {
    const nextWords = [...currentWords, word];
    const nextText = nextWords.join(' ');
    const boundary =
      currentWords.length > 0 &&
      (nextWords.length > maxWords || nextText.length > maxChars);
    if (boundary) flush();
    currentWords.push(word);
  }
  flush();
  return chunks;
}

export function transcriptWordCount(value: string): number {
  const text = normaliseWhitespace(value);
  return text ? text.split(' ').length : 0;
}
