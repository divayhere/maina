const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES = 256;

export function normalizeQualificationMeetingIds(values: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 128) continue;
    ids.add(value);
  }
  return ids;
}

export function referencesQualificationMeeting(
  value: unknown,
  qualificationMeetingIds: ReadonlySet<string>,
  depth = 0,
  seen = new Set<object>(),
): boolean {
  if (qualificationMeetingIds.size === 0 || value == null) return false;
  if (typeof value === 'string') {
    for (const meetingId of qualificationMeetingIds) if (value.includes(meetingId)) return true;
    return false;
  }
  if (typeof value !== 'object') return false;
  if (depth >= MAX_SCAN_DEPTH || seen.has(value)) return true;
  seen.add(value);
  let children: unknown[];
  try {
    children = value instanceof Error
      ? [value.name, value.message, value.stack]
      : Array.isArray(value)
        ? value
        : Object.values(value as Record<string, unknown>);
  } catch {
    return true;
  }
  if (children.length > MAX_SCAN_ENTRIES) return true;
  return children.some((child) => referencesQualificationMeeting(
    child,
    qualificationMeetingIds,
    depth + 1,
    seen,
  ));
}

export function qualificationDiagnosticSuppressed(input: {
  globallySuppressed: boolean;
  qualificationMeetingIds: ReadonlySet<string>;
  values: readonly unknown[];
}): boolean {
  return input.globallySuppressed || input.values.some((value) => (
    referencesQualificationMeeting(value, input.qualificationMeetingIds)
  ));
}

export function diagnosticSuppressionSourcesActive(input: {
  qualificationActive: boolean;
  quarantineMeetingIds: ReadonlySet<string>;
}): boolean {
  return input.qualificationActive || input.quarantineMeetingIds.size > 0;
}
