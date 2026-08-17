/**
 * SWAP-SEAM: Summarizer.
 * Turns a transcript into a summary, to-dos, or a custom output. Each provider
 * kind gets one adapter implementing this interface. The orchestration layer
 * never knows which provider is behind it.
 */

export type SummaryKind = 'summary' | 'todos' | 'custom';

export interface SummaryRequest {
  transcript: string;
  kind: SummaryKind;
  /** For kind === 'custom' or to tune tone/length. */
  instruction?: string;
  /** Optional user notes captured during the meeting, to enrich the summary. */
  notes?: string;
  language?: string;
  signal?: AbortSignal;
}

export interface TodoItem {
  text: string;
  /** The transcript sentence this was drawn from — powers tap-back traceability. */
  sourceQuote?: string;
  done: boolean;
}

export interface SummaryResult {
  /** Markdown summary text. */
  summary?: string;
  /** Present when kind produces tasks. */
  todos?: TodoItem[];
  providerId: string;
  model: string;
}

export interface Summarizer {
  readonly providerId: string;
  summarize(req: SummaryRequest, apiKey: string, model: string): Promise<SummaryResult>;
}
