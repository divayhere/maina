/** Maps logarithmic dBFS meter values to a perceptible, bounded UI level. */
export function recordingLevelFromDbfs(rmsDbfs: number | null | undefined, active: boolean): number {
  if (!active) return 0;
  const dbfs = Number.isFinite(rmsDbfs) ? Number(rmsDbfs) : -60;
  const linear = Math.max(0, Math.min(1, (dbfs + 60) / 36));
  return Math.max(0.06, Math.min(1, Math.pow(linear, 0.55)));
}
