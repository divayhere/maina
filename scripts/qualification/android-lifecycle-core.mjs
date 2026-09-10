const MAX_HIERARCHY_BYTES = 8 * 1024 * 1024;
const MAX_NODE_COUNT = 20_000;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactCount(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative safe integer.`);
  return value;
}

function decodeXml(value) {
  return value.replace(/&(?:quot|apos|lt|gt|amp);|&#(?:[0-9]+|x[0-9a-fA-F]+);/g, (entity) => {
    const named = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
    if (named[entity]) return named[entity];
    const body = entity.slice(2, -1);
    const point = body.startsWith('x') ? Number.parseInt(body.slice(1), 16) : Number.parseInt(body, 10);
    invariant(Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff, 'UI hierarchy contains an invalid XML entity.');
    return String.fromCodePoint(point);
  });
}

function parseBounds(value) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(value);
  if (!match) return null;
  const bounds = match.slice(1).map(Number);
  if (!bounds.every(Number.isSafeInteger)) return null;
  const [left, top, right, bottom] = bounds;
  return left >= 0 && top >= 0 && right > left && bottom > top
    ? Object.freeze({ left, top, right, bottom })
    : null;
}

function parseAttributes(source) {
  const attributes = {};
  const token = /([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g;
  let consumed = '';
  let match;
  while ((match = token.exec(source)) !== null) {
    const between = source.slice(consumed.length, match.index);
    invariant(/^\s*$/.test(between), 'UI hierarchy contains malformed node attributes.');
    invariant(!(match[1] in attributes), 'UI hierarchy contains duplicate node attributes.');
    attributes[match[1]] = decodeXml(match[2]);
    consumed = source.slice(0, token.lastIndex);
  }
  invariant(/^\s*\/?\s*$/.test(source.slice(consumed.length)), 'UI hierarchy contains unconsumed node attributes.');
  return attributes;
}

export function parseUiAutomatorHierarchy(xml) {
  invariant(typeof xml === 'string' && xml.length > 0, 'UI hierarchy must be nonempty text.');
  invariant(Buffer.byteLength(xml, 'utf8') <= MAX_HIERARCHY_BYTES, 'UI hierarchy exceeds the bounded size.');
  invariant((xml.match(/<hierarchy\b/g) ?? []).length === 1, 'UI hierarchy root cardinality is invalid.');
  invariant((xml.match(/<\/hierarchy>/g) ?? []).length === 1, 'UI hierarchy closing root cardinality is invalid.');

  const nodes = [];
  for (const match of xml.matchAll(/<node\s+([^>]*?)(?:\/>|>)/g)) {
    const attributes = parseAttributes(match[1]);
    const visible = attributes['visible-to-user'];
    const enabled = attributes.enabled;
    const clickable = attributes.clickable;
    invariant(visible === undefined || visible === 'true' || visible === 'false', 'UI node has invalid visibility.');
    invariant(enabled === undefined || enabled === 'true' || enabled === 'false', 'UI node has invalid enabled state.');
    invariant(clickable === undefined || clickable === 'true' || clickable === 'false', 'UI node has invalid clickable state.');
    nodes.push(Object.freeze({
      text: attributes.text ?? '',
      contentDescription: attributes['content-desc'] ?? '',
      resourceId: attributes['resource-id'] ?? '',
      className: attributes.class ?? '',
      visible: visible !== 'false',
      enabled: enabled !== 'false',
      clickable: clickable === 'true',
      bounds: parseBounds(attributes.bounds ?? ''),
    }));
    invariant(nodes.length <= MAX_NODE_COUNT, 'UI hierarchy exceeds the bounded node count.');
  }
  invariant(nodes.length > 0, 'UI hierarchy contains no nodes.');
  return Object.freeze(nodes);
}

function exactLabels(node) {
  return new Set([node.text, node.contentDescription].filter(Boolean));
}

function hasExactLabel(node, label) {
  return exactLabels(node).has(label);
}

function hasExactTestId(node, testId) {
  return node.resourceId === testId
    || node.resourceId.endsWith(`:id/${testId}`)
    || node.resourceId.endsWith(`/id/${testId}`);
}

function actionableMatches(nodes, { label, testId }) {
  return nodes.filter((node) => node.visible
    && node.enabled
    && node.clickable
    && node.bounds !== null
    && hasExactLabel(node, label)
    && hasExactTestId(node, testId));
}

export function requireUniqueAction(nodes, { label, testId }) {
  invariant(Array.isArray(nodes), 'UI nodes must be an array.');
  invariant(typeof label === 'string' && label.length > 0, 'Action label is invalid.');
  invariant(typeof testId === 'string' && testId.length > 0, 'Action test ID is invalid.');
  const matches = actionableMatches(nodes, { label, testId });
  invariant(matches.length === 1, `Action ${testId} is missing or ambiguous.`);
  const { left, top, right, bottom } = matches[0].bounds;
  return Object.freeze({
    x: Math.floor((left + right) / 2),
    y: Math.floor((top + bottom) / 2),
  });
}

export function parseRecordingTimer(nodes) {
  const candidates = nodes.filter((node) => node.visible
    && (hasExactTestId(node, 'recording-timer') || [...exactLabels(node)].some((label) => /^(?:\d+:)?\d{1,2}:\d{2}$/.test(label))));
  invariant(candidates.length === 1, 'Recording timer is missing or ambiguous.');
  const labels = [...exactLabels(candidates[0])].filter((label) => /^(?:\d+:)?\d{1,2}:\d{2}$/.test(label));
  invariant(labels.length === 1, 'Recording timer label is missing or ambiguous.');
  const parts = labels[0].split(':').map(Number);
  invariant(parts.every(Number.isSafeInteger), 'Recording timer contains an invalid component.');
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  invariant(parts.length === 2 || parts.length === 3, 'Recording timer shape is invalid.');
  invariant(hours >= 0 && minutes >= 0 && minutes < 60 && seconds >= 0 && seconds < 60, 'Recording timer range is invalid.');
  return hours * 3600 + minutes * 60 + seconds;
}

export function requireTimerAdvance(beforeSeconds, afterSeconds, minimumAdvanceSeconds = 1) {
  exactCount(beforeSeconds, 'Before timer');
  exactCount(afterSeconds, 'After timer');
  invariant(Number.isSafeInteger(minimumAdvanceSeconds) && minimumAdvanceSeconds >= 1, 'Minimum timer advance is invalid.');
  invariant(afterSeconds - beforeSeconds >= minimumAdvanceSeconds, 'Recording timer did not advance.');
  return afterSeconds - beforeSeconds;
}

export function classifyRecordingSurface(nodes) {
  const stop = actionableMatches(nodes, { label: 'Stop and save', testId: 'recording-stop-save' }).length;
  const pause = actionableMatches(nodes, { label: 'Pause', testId: 'recording-pause-resume' }).length;
  const resume = actionableMatches(nodes, { label: 'Resume', testId: 'recording-pause-resume' }).length;
  const discard = nodes.filter((node) => node.visible && hasExactLabel(node, 'Discard this recording')).length;
  invariant(stop === 1 && discard === 1 && pause + resume === 1, 'Recording controls are missing or ambiguous.');
  const timerSeconds = parseRecordingTimer(nodes);
  const stateLabels = nodes.filter((node) => node.visible && (hasExactLabel(node, 'Recording') || hasExactLabel(node, 'Paused')));
  invariant(stateLabels.length === 1, 'Recording state is missing or ambiguous.');
  const state = hasExactLabel(stateLabels[0], 'Recording') ? 'recording' : 'paused';
  invariant((state === 'recording' && pause === 1) || (state === 'paused' && resume === 1), 'Recording control and public state disagree.');
  return Object.freeze({ state, timerSeconds });
}

export function parsePublicRecordingCount(nodes) {
  const matches = [];
  for (const node of nodes) {
    if (!node.visible) continue;
    for (const label of exactLabels(node)) {
      const match = /^(\d+) recordings?$/.exec(label);
      if (match) matches.push(Number(match[1]));
    }
  }
  invariant(matches.length === 1, 'Public recording count is missing or ambiguous.');
  return exactCount(matches[0], 'Public recording count');
}

export function requireOneNewRecording(beforeCount, afterCount) {
  exactCount(beforeCount, 'Before recording count');
  exactCount(afterCount, 'After recording count');
  invariant(afterCount === beforeCount + 1, 'Process recovery did not preserve exactly one new recording.');
  return afterCount;
}

export function selectTopMeetingCard(nodes) {
  const cards = nodes.filter((node) => node.visible
    && node.enabled
    && node.clickable
    && node.bounds !== null
    && hasExactTestId(node, 'meeting-card'));
  invariant(cards.length > 0, 'No stable meeting-card action is visible.');
  const sorted = [...cards].sort((left, right) => left.bounds.top - right.bounds.top || left.bounds.left - right.bounds.left);
  invariant(sorted.length === 1 || sorted[0].bounds.top !== sorted[1].bounds.top, 'Top meeting-card action is ambiguous.');
  const { left, top, right, bottom } = sorted[0].bounds;
  return Object.freeze({
    visibleCardCount: cards.length,
    x: Math.floor((left + right) / 2),
    y: Math.floor((top + bottom) / 2),
  });
}

export function classifyDurableAudioEvidence(nodes) {
  let audioAvailable = 0;
  let positiveSegments = 0;
  let audioKept = 0;
  let retranscribe = 0;
  for (const node of nodes) {
    if (!node.visible) continue;
    for (const label of exactLabels(node)) {
      if (label === 'Audio available: Yes') audioAvailable += 1;
      if (/^Saved audio segments: [1-9]\d*$/.test(label)) positiveSegments += 1;
      if (/^(?:[1-9]\d* transcript blocks|No transcript|Transcription in progress)(?: · [1-9]\d*% audio coverage)? · audio kept$/.test(label)) audioKept += 1;
      if (label === 'Re-transcribe from saved audio') retranscribe += 1;
    }
  }
  const counts = { audioAvailable, positiveSegments, audioKept, retranscribe };
  invariant(Object.values(counts).every((count) => count <= 1), 'Durable audio evidence is ambiguous.');
  invariant(Object.values(counts).some((count) => count === 1), 'Positive durable audio evidence is absent.');
  return Object.freeze(counts);
}

export function requireNoActiveRecordingSurface(nodes) {
  const activeLabels = ['Stop and save', 'Pause', 'Resume', 'Discard this recording', 'Recording', 'Paused'];
  invariant(!nodes.some((node) => node.visible && activeLabels.some((label) => hasExactLabel(node, label))), 'Recovered detail still exposes an active recording surface.');
  return true;
}

export function classifyPowerState(output) {
  invariant(typeof output === 'string' && output.length > 0, 'Power state output must be nonempty text.');
  const wakefulness = [...output.matchAll(/^\s*mWakefulness=(Awake|Asleep|Dreaming|Dozing)$/gm)].map((match) => match[1]);
  const display = [...output.matchAll(/^\s*Display Power: state=(ON|OFF|DOZE|DOZE_SUSPEND|UNKNOWN)$/gm)].map((match) => match[1]);
  invariant(wakefulness.length === 1 && display.length === 1, 'Power state is missing or ambiguous.');
  if (wakefulness[0] === 'Awake' && display[0] === 'ON') return 'on';
  if (wakefulness[0] === 'Asleep' && display[0] === 'OFF') return 'off';
  throw new Error('Power state is not an exact on/off condition.');
}

export const androidLifecyclePolicy = Object.freeze({
  schemaVersion: 'maina.android-lifecycle-qualification-core.v1',
  exactTestIds: Object.freeze([
    'recording-timer',
    'recording-state',
    'recording-stop-save',
    'recording-pause-resume',
    'meeting-card',
  ]),
  processRecoveryRecordingDelta: 1,
  rawHierarchyPersistenceAllowed: false,
});
