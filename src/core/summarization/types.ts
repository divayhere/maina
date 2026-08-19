export interface MeetingPacketRequest {
  transcript: string;
  language?: string;
  existingSummary?: string | null;
  signal?: AbortSignal;
}

export interface ExtractedTodo {
  text: string;
  sourceQuote?: string;
  sourceSpeakerId?: string | null;
  sourceTimestamp?: number | null;
}

export interface MeetingPacketResult {
  title: string;
  summary: string;
  decisions: string[];
  openQuestions: string[];
  todos: ExtractedTodo[];
  providerId: string;
  model: string;
}

export interface PacketSummarizer {
  readonly providerId: string;
  summarizeMeeting(req: MeetingPacketRequest, apiKey: string, model: string, baseUrl?: string): Promise<MeetingPacketResult>;
}
