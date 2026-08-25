import { getProvider, type AIProvider } from './providers';
import type { ExtractedTodo, MeetingPacketRequest, MeetingPacketResult } from './types';

const SYSTEM_PROMPT = [
  'You are an expert meeting analyst.',
  'Turn the transcript into a concise executive meeting packet.',
  'Write the output in crisp professional English even if the transcript mixes Hindi and English.',
  'Never invent facts that are not supported by the transcript.',
  'If something is uncertain, place it under openQuestions rather than decisions.',
  'Return strict JSON only with no markdown fences.',
].join(' ');

function buildPrompt(req: MeetingPacketRequest): string {
  return [
    'Create a meeting packet from this transcript.',
    'Requirements:',
    '- title: under 10 words, specific, useful, not generic.',
    '- summary: 2-5 short paragraphs in markdown-safe plain text.',
    '- decisions: array of concrete decisions. Empty array if none.',
    '- openQuestions: array of unresolved questions, blockers, unknowns. Empty array if none.',
    '- todos: array of objects with { text, sourceQuote }.',
    '- Keep todos action-oriented and assignable when possible.',
    '- If there are no todos, return an empty array.',
    '- Preserve business nuance and commercial implications.',
    '',
    'Return JSON in this exact shape:',
    '{"title":"","summary":"","decisions":[],"openQuestions":[],"todos":[{"text":"","sourceQuote":""}]}',
    '',
    req.language ? `Transcript language hint: ${req.language}` : '',
    req.existingSummary ? `Existing summary draft (improve/replace if needed):\n${req.existingSummary}` : '',
    '',
    'Transcript:',
    req.transcript,
  ].filter(Boolean).join('\n');
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function ensureTodos(value: unknown): ExtractedTodo[] {
  if (!Array.isArray(value)) return [];
  const parsed: ExtractedTodo[] = [];
  value.forEach((item) => {
      if (!item || typeof item !== 'object') return null;
      const text = String((item as Record<string, unknown>).text ?? '').trim();
      if (!text) return;
      const sourceQuote = String((item as Record<string, unknown>).sourceQuote ?? '').trim();
      parsed.push({
        text,
        sourceQuote: sourceQuote || undefined,
      });
    });
  return parsed;
}

function parseMeetingPacket(value: string, providerId: string, model: string): MeetingPacketResult {
  const normalized = stripCodeFence(value);
  const parsed = JSON.parse(normalized) as Record<string, unknown>;
  const title = String(parsed.title ?? '').trim() || 'Meeting summary';
  const summary = String(parsed.summary ?? '').trim();
  return {
    title,
    summary,
    decisions: ensureStringArray(parsed.decisions),
    openQuestions: ensureStringArray(parsed.openQuestions),
    todos: ensureTodos(parsed.todos),
    providerId,
    model,
  };
}

function extractApiErrorMessage(raw: string, fallback: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string };
      message?: string;
    };
    return parsed.error?.message ?? parsed.message ?? raw?.slice(0, 300) ?? fallback;
  } catch {
    return raw?.slice(0, 300) || fallback;
  }
}

async function readResponseText(response: Response): Promise<string> {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(extractApiErrorMessage(body, response.statusText || `HTTP ${response.status}`));
  }
  return body;
}

async function summarizeOpenAICompatible(
  provider: AIProvider,
  req: MeetingPacketRequest,
  apiKey: string,
  model: string,
  baseUrl?: string,
): Promise<MeetingPacketResult> {
  const endpointBase = (baseUrl || provider.baseUrl || '').replace(/\/$/, '');
  if (!endpointBase) throw new Error('A base URL is required for this provider.');
  const response = await fetch(`${endpointBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(req) },
      ],
    }),
    signal: req.signal,
  });
  const raw = await readResponseText(response);
  const json = JSON.parse(raw) as {
    choices?: { message?: { content?: string | { text?: string }[] } }[];
    error?: { message?: string };
  };
  if (json.error?.message) throw new Error(json.error.message);
  const content = json.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content.map((item) => item.text ?? '').join('\n')
    : content ?? '';
  return parseMeetingPacket(text, provider.id, model);
}

async function summarizeAnthropic(
  provider: AIProvider,
  req: MeetingPacketRequest,
  apiKey: string,
  model: string,
): Promise<MeetingPacketResult> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildPrompt(req) }],
    }),
    signal: req.signal,
  });
  const raw = await readResponseText(response);
  const json = JSON.parse(raw) as {
    content?: { type?: string; text?: string }[];
    error?: { message?: string };
  };
  if (json.error?.message) throw new Error(json.error.message);
  const text = (json.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
  return parseMeetingPacket(text, provider.id, model);
}

async function summarizeGemini(
  provider: AIProvider,
  req: MeetingPacketRequest,
  apiKey: string,
  model: string,
): Promise<MeetingPacketResult> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: `${SYSTEM_PROMPT}\n\n${buildPrompt(req)}` }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      }),
      signal: req.signal,
    },
  );
  const raw = await readResponseText(response);
  const json = JSON.parse(raw) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    error?: { message?: string };
  };
  if (json.error?.message) throw new Error(json.error.message);
  const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('\n') ?? '';
  return parseMeetingPacket(text, provider.id, model);
}

export async function generateMeetingPacket(input: {
  providerId: string;
  apiKey: string;
  model: string;
  transcript: string;
  language?: string;
  baseUrl?: string;
  existingSummary?: string | null;
  signal?: AbortSignal;
}): Promise<MeetingPacketResult> {
  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);
  const req: MeetingPacketRequest = {
    transcript: input.transcript,
    language: input.language,
    existingSummary: input.existingSummary,
    signal: input.signal,
  };
  if (provider.kind === 'anthropic') {
    return summarizeAnthropic(provider, req, input.apiKey, input.model);
  }
  if (provider.kind === 'gemini') {
    return summarizeGemini(provider, req, input.apiKey, input.model);
  }
  return summarizeOpenAICompatible(provider, req, input.apiKey, input.model, input.baseUrl);
}
