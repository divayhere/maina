export function localAsrWindowKey(input: {
  chunkIndex: number;
  startMs: number;
  endMs: number;
}): string {
  return `qwen3-asr-0.6b-int8@1:${Math.max(0, input.chunkIndex)}:${Math.max(0, input.startMs)}:${Math.max(0, input.endMs)}`;
}

export function shouldProcessLocalAsrWindow(completedKeys: ReadonlySet<string>, key: string): boolean {
  return !completedKeys.has(key);
}
