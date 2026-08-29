export type NativeCapturePresentation = 'recording' | 'paused' | 'unchanged';

/** Native capture remains authoritative while React state is suspended by a call. */
export function nativeCapturePresentation(state?: string | null): NativeCapturePresentation {
  if (state === 'recording') return 'recording';
  if (state === 'pausing' || state === 'paused' || state === 'resuming') return 'paused';
  return 'unchanged';
}
