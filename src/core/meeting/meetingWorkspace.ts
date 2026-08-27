export const MEETING_TITLE_MAX_LENGTH = 120;

export function normalizeMeetingTitle(value: string, fallback = 'Untitled meeting'): string {
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, MEETING_TITLE_MAX_LENGTH).trim();
  return normalized || fallback;
}
