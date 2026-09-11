export function candidateRecoveryAudioUris(
  nativeFinalizedUris: readonly string[],
  recordedSegmentUris: readonly string[],
): string[] {
  return [...new Set([...nativeFinalizedUris, ...recordedSegmentUris].filter((uri) => uri.trim().length > 0))];
}
