export function segmentName(index: number): string {
  return `seg-${String(index).padStart(4, '0')}.wav`;
}

export function segmentIndexFromUri(uri: string | null | undefined): number | null {
  const match = uri?.match(/seg-(\d+)\.wav(?:$|[?#])/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(value) ? value : null;
}
