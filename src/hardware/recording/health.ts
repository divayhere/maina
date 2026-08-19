export interface CaptureHealthSnapshot {
  expectedSegments: number;
  closedSegments: number;
  failedSegments: number;
  audioDurationMs: number;
  recognizerDowntimeMs: number;
  measuredGapMs: number;
  largestGapMs: number;
  pausedDurationMs: number;
}

/**
 * Tracks only observed lifecycle events. It deliberately does not infer audio
 * duration from wall-clock meeting time: a recognizer restart can leave a real
 * gap between one audio file ending and the next one starting.
 */
export class CaptureHealthTracker {
  private readonly requestedSegments = new Set<number>();
  private readonly audioStarts = new Map<number, number>();
  private readonly audioDurations = new Map<number, number>();
  private readonly closedSegments = new Set<number>();
  private readonly failedSegments = new Set<number>();
  private captureUnavailableAt: number | null = null;
  private recognizerUnavailableAt: number | null = null;
  private captureGapMs = 0;
  private recognizerDowntimeMs = 0;
  private largestGapMs = 0;
  private pausedAt: number | null = null;
  private pausedDurationMs = 0;

  requestSegment(index: number): void {
    this.requestedSegments.add(index);
  }

  audioStarted(index: number, at: number): void {
    this.requestedSegments.add(index);
    this.audioStarts.set(index, at);
    if (this.captureUnavailableAt !== null) {
      const gap = Math.max(0, at - this.captureUnavailableAt);
      this.captureGapMs += gap;
      this.largestGapMs = Math.max(this.largestGapMs, gap);
      this.captureUnavailableAt = null;
    }
  }

  audioEnded(index: number, at: number, saved: boolean): void {
    this.requestedSegments.add(index);
    const startedAt = this.audioStarts.get(index);
    if (saved && startedAt !== undefined) {
      this.audioDurations.set(index, Math.max(0, at - startedAt));
      this.closedSegments.add(index);
      this.failedSegments.delete(index);
    } else {
      this.failedSegments.add(index);
    }
  }

  captureUnavailable(at: number): void {
    if (this.pausedAt !== null) return;
    if (this.captureUnavailableAt === null) this.captureUnavailableAt = at;
  }

  recognizerEnded(at: number): void {
    if (this.pausedAt !== null) return;
    if (this.recognizerUnavailableAt === null) this.recognizerUnavailableAt = at;
  }

  recognizerStarted(at: number): void {
    if (this.pausedAt !== null) return;
    if (this.recognizerUnavailableAt === null) return;
    this.recognizerDowntimeMs += Math.max(0, at - this.recognizerUnavailableAt);
    this.recognizerUnavailableAt = null;
  }

  pauseStarted(at: number): void {
    if (this.pausedAt !== null) return;
    this.pausedAt = at;
    this.captureUnavailableAt = null;
    this.recognizerUnavailableAt = null;
  }

  pauseEnded(at: number): void {
    if (this.pausedAt === null) return;
    this.pausedDurationMs += Math.max(0, at - this.pausedAt);
    this.pausedAt = null;
    this.captureUnavailableAt = null;
    this.recognizerUnavailableAt = null;
  }

  snapshot(at = Date.now()): CaptureHealthSnapshot {
    return {
      expectedSegments: this.requestedSegments.size,
      closedSegments: this.closedSegments.size,
      failedSegments: this.failedSegments.size,
      audioDurationMs: [...this.audioDurations.values()].reduce((sum, duration) => sum + duration, 0),
      recognizerDowntimeMs: this.recognizerDowntimeMs,
      measuredGapMs: this.captureGapMs,
      largestGapMs: this.largestGapMs,
      pausedDurationMs: this.pausedDurationMs + (this.pausedAt === null ? 0 : Math.max(0, at - this.pausedAt)),
    };
  }
}
