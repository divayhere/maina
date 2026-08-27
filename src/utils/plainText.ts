/**
 * Converts the small Markdown subset returned by meeting-note providers into
 * readable React Native plain text. The canonical cloud response is left
 * untouched for copying, export, corrections, and MKC lineage.
 */
export function markdownToReadableText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
