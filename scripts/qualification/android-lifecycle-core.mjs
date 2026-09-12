const MAX_HIERARCHY_BYTES = 8 * 1024 * 1024;
const MAX_NODE_COUNT = 20_000;
const MAINA_PACKAGE = 'com.divay.maina';

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
  const declaredNodeCount = (xml.match(/<node\b/g) ?? []).length;
  for (const match of xml.matchAll(/<node\s+([^>]*?)(?:\/>|>)/g)) {
    const attributes = parseAttributes(match[1]);
    const visible = attributes['visible-to-user'];
    const enabled = attributes.enabled;
    const clickable = attributes.clickable;
    const selected = attributes.selected;
    invariant(visible === undefined || visible === 'true' || visible === 'false', 'UI node has invalid visibility.');
    invariant(enabled === undefined || enabled === 'true' || enabled === 'false', 'UI node has invalid enabled state.');
    invariant(clickable === undefined || clickable === 'true' || clickable === 'false', 'UI node has invalid clickable state.');
    invariant(selected === undefined || selected === 'true' || selected === 'false', 'UI node has invalid selected state.');
    nodes.push(Object.freeze({
      text: attributes.text ?? '',
      contentDescription: attributes['content-desc'] ?? '',
      resourceId: attributes['resource-id'] ?? '',
      packageName: attributes.package ?? '',
      className: attributes.class ?? '',
      visible: visible !== 'false',
      enabled: enabled !== 'false',
      clickable: clickable === 'true',
      selected: selected === 'true',
      bounds: parseBounds(attributes.bounds ?? ''),
    }));
    invariant(nodes.length <= MAX_NODE_COUNT, 'UI hierarchy exceeds the bounded node count.');
  }
  invariant(nodes.length === declaredNodeCount, 'UI hierarchy contains an unparsed node element.');
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

function testIdValue(node) {
  const marker = node.resourceId.lastIndexOf(':id/');
  if (marker >= 0) return node.resourceId.slice(marker + 4);
  const slashMarker = node.resourceId.lastIndexOf('/id/');
  if (slashMarker >= 0) return node.resourceId.slice(slashMarker + 4);
  return node.resourceId;
}

function isMainaNode(node) {
  return node.packageName === MAINA_PACKAGE;
}

function actionableMatches(nodes, { label, testId }) {
  return nodes.filter((node) => isMainaNode(node)
    && node.visible
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

export function optionalUniqueAction(nodes, { label, testId }) {
  invariant(Array.isArray(nodes), 'UI nodes must be an array.');
  const matches = actionableMatches(nodes, { label, testId });
  invariant(matches.length <= 1, `Action ${testId} is ambiguous.`);
  if (matches.length === 0) return null;
  const { left, top, right, bottom } = matches[0].bounds;
  return Object.freeze({
    x: Math.floor((left + right) / 2),
    y: Math.floor((top + bottom) / 2),
  });
}

export function optionalUniqueMarker(nodes, testId) {
  invariant(Array.isArray(nodes), 'UI nodes must be an array.');
  invariant(typeof testId === 'string' && testId.length > 0, 'Marker test ID is invalid.');
  const matches = nodes.filter((node) => isMainaNode(node) && node.visible && hasExactTestId(node, testId));
  invariant(matches.length <= 1, `Marker ${testId} is ambiguous.`);
  return matches.length === 1 ? true : null;
}

export function parseRecordingTimer(nodes) {
  const candidates = nodes.filter((node) => isMainaNode(node) && node.visible
    && hasExactTestId(node, 'recording-timer'));
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

export function requireTimerHeld(beforeSeconds, afterSeconds) {
  exactCount(beforeSeconds, 'Before paused timer');
  exactCount(afterSeconds, 'After paused timer');
  invariant(afterSeconds === beforeSeconds, 'Paused recording timer advanced.');
  return afterSeconds;
}

export function classifyRecordingSurface(nodes) {
  const stop = actionableMatches(nodes, { label: 'Stop and save', testId: 'recording-stop-save' }).length;
  const pause = actionableMatches(nodes, { label: 'Pause', testId: 'recording-pause-resume' }).length;
  const resume = actionableMatches(nodes, { label: 'Resume', testId: 'recording-pause-resume' }).length;
  const discard = actionableMatches(nodes, { label: 'Discard this recording', testId: 'recording-discard' }).length;
  invariant(stop === 1 && discard === 1 && pause + resume === 1, 'Recording controls are missing or ambiguous.');
  const timerSeconds = parseRecordingTimer(nodes);
  const stateLabels = nodes.filter((node) => isMainaNode(node) && node.visible
    && hasExactTestId(node, 'recording-state')
    && (hasExactLabel(node, 'Recording') || hasExactLabel(node, 'Paused')));
  invariant(stateLabels.length === 1, 'Recording state is missing or ambiguous.');
  const state = hasExactLabel(stateLabels[0], 'Recording') ? 'recording' : 'paused';
  invariant((state === 'recording' && pause === 1) || (state === 'paused' && resume === 1), 'Recording control and public state disagree.');
  return Object.freeze({ state, timerSeconds });
}

export function observeRecordingSurface(nodes) {
  const testIds = [
    'recording-timer',
    'recording-state',
    'recording-stop-save',
    'recording-pause-resume',
    'recording-discard',
  ];
  const counts = testIds.map((testId) => nodes.filter((node) => isMainaNode(node) && node.visible && hasExactTestId(node, testId)).length);
  invariant(counts.every((count) => count <= 1), 'Recording surface contains an ambiguous stable node.');
  if (counts.every((count) => count === 0)) return null;
  if (counts.some((count) => count === 0)) return null;
  return classifyRecordingSurface(nodes);
}

export function parsePublicRecordingCount(nodes) {
  const matches = [];
  for (const node of nodes) {
    if (!isMainaNode(node) || !node.visible || !hasExactTestId(node, 'recording-count')) continue;
    for (const label of exactLabels(node)) {
      const match = /^(\d+) recordings?$/.exec(label);
      if (match) matches.push(Number(match[1]));
    }
  }
  invariant(matches.length === 1, 'Public recording count is missing or ambiguous.');
  return exactCount(matches[0], 'Public recording count');
}

export function observeHomeSurface(nodes) {
  invariant(Array.isArray(nodes), 'UI nodes must be an array.');
  const home = actionableMatches(nodes, { label: 'Home', testId: 'main-tab-index' });
  const record = actionableMatches(nodes, { label: 'Record a meeting', testId: 'record-meeting' });
  const notifications = nodes.filter((node) => isMainaNode(node)
    && node.visible
    && node.enabled
    && node.clickable
    && node.bounds !== null
    && hasExactLabel(node, 'Notifications'));
  const countNodes = nodes.filter((node) => isMainaNode(node)
    && node.visible
    && hasExactTestId(node, 'recording-count'));
  invariant(home.length <= 1 && record.length <= 1 && notifications.length <= 1 && countNodes.length <= 1,
    'Home surface contains an ambiguous stable node.');
  if (home.length === 0 || !home[0].selected || record.length === 0 || notifications.length === 0 || countNodes.length === 0) {
    return null;
  }
  const recordingTestIds = new Set([
    'recording-timer',
    'recording-state',
    'recording-stop-save',
    'recording-pause-resume',
    'recording-discard',
  ]);
  if (nodes.some((node) => isMainaNode(node) && node.visible && recordingTestIds.has(testIdValue(node)))) return null;
  const permissionLabels = new Set(['Allow', 'While using the app', 'Only this time', 'Don’t allow', "Don't allow"]);
  const permissionPackages = new Set(['com.android.permissioncontroller', 'com.google.android.permissioncontroller']);
  if (nodes.some((node) => node.visible
    && permissionPackages.has(node.packageName)
    && [...exactLabels(node)].some((label) => permissionLabels.has(label)))) return null;
  const { left, top, right, bottom } = record[0].bounds;
  return Object.freeze({
    record: Object.freeze({ x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) }),
    recordingCount: parsePublicRecordingCount(nodes),
    legacyLoadedMarkerPresent: optionalUniqueMarker(nodes, 'meeting-list-loaded') === true,
  });
}

export function requireOneNewRecording(beforeCount, afterCount) {
  exactCount(beforeCount, 'Before recording count');
  exactCount(afterCount, 'After recording count');
  invariant(afterCount === beforeCount + 1, 'Process recovery did not preserve exactly one new recording.');
  return afterCount;
}

function meetingCardActions(nodes) {
  invariant(Array.isArray(nodes), 'UI nodes must be an array.');
  return nodes.filter((node) => isMainaNode(node)
    && node.visible
    && node.enabled
    && node.clickable
    && node.bounds !== null
    && hasExactTestId(node, 'meeting-card'));
}

function withinBounds(inner, outer) {
  return inner.left >= outer.left
    && inner.top >= outer.top
    && inner.right <= outer.right
    && inner.bottom <= outer.bottom;
}

export function readUniqueMarkerLabel(nodes, testId) {
  invariant(Array.isArray(nodes), 'UI nodes must be an array.');
  invariant(typeof testId === 'string' && testId.length > 0, 'Marker test ID is invalid.');
  const matches = nodes.filter((node) => isMainaNode(node) && node.visible && hasExactTestId(node, testId));
  invariant(matches.length === 1, `Marker ${testId} is missing or ambiguous.`);
  const labels = [...exactLabels(matches[0])].filter((label) => label.length > 0 && label.length <= 512);
  invariant(labels.length === 1, `Marker ${testId} label is missing or ambiguous.`);
  return labels[0];
}

export function readUniqueMarkerToken(nodes, prefix) {
  invariant(Array.isArray(nodes), 'UI nodes must be an array.');
  invariant(typeof prefix === 'string' && /^[a-z][a-z0-9-]{2,63}-$/u.test(prefix), 'Marker token prefix is invalid.');
  const matches = nodes.filter((node) => {
    if (!isMainaNode(node) || !node.visible) return false;
    const value = testIdValue(node);
    return value.startsWith(prefix);
  });
  invariant(matches.length === 1, `Marker ${prefix} token is missing or ambiguous.`);
  const value = testIdValue(matches[0]);
  const token = value.slice(prefix.length);
  invariant(/^[A-Za-z0-9._:-]{1,128}$/u.test(token), `Marker ${prefix} token is invalid.`);
  return token;
}

export function selectTopMeetingCard(nodes) {
  const cards = meetingCardActions(nodes);
  invariant(cards.length > 0, 'No stable meeting-card action is visible.');
  const sorted = [...cards].sort((left, right) => left.bounds.top - right.bounds.top || left.bounds.left - right.bounds.left);
  invariant(sorted.length === 1 || sorted[0].bounds.top !== sorted[1].bounds.top, 'Top meeting-card action is ambiguous.');
  const metadataNodes = nodes.filter((node) => node !== sorted[0]
    && isMainaNode(node)
    && node.visible
    && node.bounds !== null
    && withinBounds(node.bounds, sorted[0].bounds)
    && hasExactTestId(node, 'meeting-card-metadata'));
  const correlationNodes = nodes.filter((node) => node !== sorted[0]
    && isMainaNode(node)
    && node.visible
    && node.bounds !== null
    && withinBounds(node.bounds, sorted[0].bounds)
    && testIdValue(node).startsWith('meeting-card-correlation-'));
  invariant(metadataNodes.length === 1, 'Top meeting-card metadata is missing or ambiguous.');
  invariant(correlationNodes.length === 1, 'Top meeting-card correlation token is missing or ambiguous.');
  const privateMetadata = readUniqueMarkerLabel(metadataNodes, 'meeting-card-metadata');
  const privateCorrelationToken = readUniqueMarkerToken(correlationNodes, 'meeting-card-correlation-');
  const { left, top, right, bottom } = sorted[0].bounds;
  return Object.freeze({
    visibleCardCount: cards.length,
    privateCorrelationToken,
    privateMetadata,
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
    if (!isMainaNode(node) || !node.visible) continue;
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

export function classifyRecoveryDurability(nodes) {
  invariant(optionalUniqueMarker(nodes, 'meeting-recovery-root') === true, 'Recovery surface is absent.');
  const audioNodes = nodes.filter((node) => isMainaNode(node) && node.visible && hasExactTestId(node, 'meeting-recovery-audio'));
  const segmentNodes = nodes.filter((node) => isMainaNode(node) && node.visible && hasExactTestId(node, 'meeting-recovery-segments'));
  const retranscribe = actionableMatches(nodes, {
    label: 'Re-transcribe from saved audio',
    testId: 'meeting-recovery-retranscribe',
  });
  invariant(audioNodes.length === 1 && segmentNodes.length === 1 && retranscribe.length === 1, 'Recovery durability evidence is missing or ambiguous.');
  invariant([...exactLabels(audioNodes[0])].filter((label) => label === 'Audio available: Yes').length === 1, 'Recovery audio availability is not positive.');
  invariant([...exactLabels(segmentNodes[0])].filter((label) => /^Saved audio segments: [1-9]\d*$/.test(label)).length === 1, 'Recovery segment count is not positive.');
  return Object.freeze({ audioAvailable: 1, positiveSegments: 1, retranscribe: 1 });
}

export function classifySavedDetailDurability(nodes) {
  invariant(actionableMatches(nodes, { label: 'Delete meeting', testId: 'meeting-detail-delete' }).length === 1,
    'Saved detail surface is absent or ambiguous.');
  const audioNodes = nodes.filter((node) => isMainaNode(node) && node.visible && hasExactTestId(node, 'meeting-detail-audio-state'));
  invariant(audioNodes.length === 1, 'Saved detail audio evidence is missing or ambiguous.');
  const labels = [...exactLabels(audioNodes[0])];
  invariant(labels.length === 1
    && /^(?:[1-9]\d* transcript blocks|No transcript|Transcription in progress)(?: · [1-9]\d*% audio coverage)? · audio kept$/u.test(labels[0]),
  'Saved detail durable audio evidence is not positive.');
  return Object.freeze({ audioAvailable: 1, positiveSegments: 1, retranscribe: 0 });
}

export function requireNoActiveRecordingSurface(nodes) {
  const activeLabels = ['Stop and save', 'Pause', 'Resume', 'Discard this recording', 'Recording', 'Paused'];
  invariant(!nodes.some((node) => isMainaNode(node) && node.visible && activeLabels.some((label) => hasExactLabel(node, label))), 'Recovered detail still exposes an active recording surface.');
  return true;
}

export function classifyPowerState(powerOutput, displayOutput) {
  invariant(typeof powerOutput === 'string' && powerOutput.length > 0, 'Power state output must be nonempty text.');
  invariant(typeof displayOutput === 'string' && displayOutput.length > 0, 'Display state output must be nonempty text.');
  const normalizedPower = powerOutput.replace(/\r\n/gu, '\n');
  const normalizedDisplay = displayOutput.replace(/\r\n/gu, '\n');
  const wakefulness = [...normalizedPower.matchAll(/^ {2}mWakefulness=(Awake|Asleep|Dreaming|Dozing)$/gm)].map((match) => match[1]);
  invariant(wakefulness.length === 1, 'Power state is missing or ambiguous.');
  const wakefulnessChanging = [...normalizedPower.matchAll(/^ {2}mWakefulnessChanging=(true|false)$/gm)]
    .map((match) => match[1]);
  invariant(wakefulnessChanging.length === 1, 'Power transition state is missing or ambiguous.');

  const displayStateHeaders = [...normalizedDisplay.matchAll(/^Display States: size=([0-9]+)$/gm)];
  invariant(displayStateHeaders.length === 1 && displayStateHeaders[0][1] === '1', 'Display state section is missing or ambiguous.');
  const displayStateStart = displayStateHeaders[0].index;
  const displayAdapterStart = normalizedDisplay.indexOf('\nDisplay Adapters:', displayStateStart);
  invariant(displayAdapterStart > displayStateStart, 'Display state section boundary is missing or ambiguous.');
  const displayStateSection = normalizedDisplay.slice(displayStateStart, displayAdapterStart);
  const displayStateNames = '(UNKNOWN|OFF|ON|DOZE|DOZE_SUSPEND|VR|ON_SUSPEND|[0-9]+)';
  const floatValue = '(?:NaN|Infinity|-Infinity|-?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[Ee][+-]?[0-9]+)?)';
  const logicalDisplayRecord = new RegExp([
    '^Display States: size=1',
    '---------------------',
    '  Display Id=0',
    `  Display State=${displayStateNames}`,
    `  Display Brightness=${floatValue}`,
    `  Display SdrBrightness=${floatValue}`,
    '$',
  ].join('\\n'), 'u').exec(displayStateSection);
  invariant(logicalDisplayRecord !== null, 'Default display state is missing or ambiguous.');

  const controllerHeaders = [...normalizedDisplay.matchAll(/^Display Power Controllers: size=([0-9]+)$/gm)];
  invariant(controllerHeaders.length === 1 && controllerHeaders[0][1] === '1', 'Display power controller section is missing or ambiguous.');
  const controllerSection = normalizedDisplay.slice(controllerHeaders[0].index);
  const controllerMarkers = [...controllerSection.matchAll(/^Display Power Controller:$/gm)];
  const controllerPrefix = /^Display Power Controllers: size=1\n\nDisplay Power Controller:\n-------------------------\n {2}mDisplayId=0\n/u;
  const photonicHeadings = [...controllerSection.matchAll(/^Photonic Modulator State:$/gm)];
  const photonicState = new RegExp([
    '^Photonic Modulator State:',
    `  mPendingState=${displayStateNames}`,
    `  mPendingBacklight=${floatValue}`,
    `  mPendingSdrBacklight=${floatValue}`,
    `  mActualState=${displayStateNames}`,
    `  mActualBacklight=${floatValue}`,
    `  mActualSdrBacklight=${floatValue}`,
    '  mStateChangeInProgress=(true|false)',
    '  mBacklightChangeInProgress=(true|false)$',
  ].join('\\n'), 'mu').exec(controllerSection);
  invariant(controllerMarkers.length === 1 && controllerPrefix.test(controllerSection)
    && photonicHeadings.length === 1 && photonicState !== null,
  'Default display controller state is missing or ambiguous.');
  const pendingState = photonicState[1];
  const actualState = photonicState[2];
  if (wakefulnessChanging[0] === 'true' || photonicState[3] === 'true') return 'transitioning';
  invariant(pendingState === actualState, 'Pending and actual display states disagree.');

  const logicalState = logicalDisplayRecord[1];
  invariant(logicalState === actualState, 'Logical and actual display states disagree.');
  if (wakefulness[0] === 'Awake' && actualState === 'ON') return 'on';
  if ((wakefulness[0] === 'Asleep' || wakefulness[0] === 'Dozing') && actualState === 'OFF') return 'off';
  if (wakefulness[0] === 'Dozing' && ['ON', 'DOZE', 'DOZE_SUSPEND'].includes(actualState)) return 'ambient';
  throw new Error('Power state is not an exact on/off condition.');
}

const RECORDING_NOTIFICATION_ID = 7001;
const RECORDING_NOTIFICATION_CHANNEL = 'maina_recording';
const NOTIFICATION_STATE_BY_TITLE = new Map([
  ['Maina is ready', 'ready'],
  ['Maina is recording', 'recording'],
  ['Maina is paused', 'paused'],
  ['Maina is saving', 'saving'],
]);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactNotificationTitlePresent(record, title) {
  for (const prefix of ['android.title=String (', 'android.title=']) {
    let index = record.indexOf(prefix + title);
    while (index >= 0) {
      const end = index + prefix.length + title.length;
      const following = record.slice(end, end + 1);
      if (prefix.endsWith('(') ? following === ')' : /[\s,}]/.test(following)) return true;
      index = record.indexOf(prefix + title, end);
    }
  }
  return false;
}

export function classifyMainaRecordingNotification(notificationDump, packageName) {
  if (typeof notificationDump !== 'string' || typeof packageName !== 'string' || packageName.length === 0) {
    return 'unavailable/ambiguous';
  }
  const packagePattern = escapeRegex(packageName);
  const records = notificationDump.split(/(?=NotificationRecord\()/);
  const candidates = records.filter((record) => new RegExp(`pkg=${packagePattern}(?:[\\s,}\\]])`).test(record)
    && new RegExp(`(?:^|[\\s,])id=${RECORDING_NOTIFICATION_ID}(?=[\\s,])`, 'm').test(record)
    && new RegExp(`channel=${RECORDING_NOTIFICATION_CHANNEL}(?:[\\s,}\\]])`).test(record));
  if (candidates.length !== 1) return 'unavailable/ambiguous';
  const states = [...NOTIFICATION_STATE_BY_TITLE]
    .filter(([title]) => exactNotificationTitlePresent(candidates[0], title))
    .map(([, state]) => state);
  return states.length === 1 ? states[0] : 'unavailable/ambiguous';
}

export const androidLifecyclePolicy = Object.freeze({
  schemaVersion: 'maina.android-lifecycle-qualification-core.v1',
  exactTestIds: Object.freeze([
    'recording-timer',
    'recording-state',
    'recording-stop-save',
    'recording-pause-resume',
    'recording-discard',
    'recording-recovery-keep',
    'meeting-detail-delete',
    'meeting-detail-metadata',
    'meeting-detail-audio-state',
    'meeting-tab-transcript',
    'meeting-recovery-root',
    'meeting-recovery-metadata',
    'meeting-recovery-segments',
    'meeting-recovery-audio',
    'meeting-recovery-retranscribe',
    'meeting-recovery-open-saved',
    'record-meeting',
    'meeting-list-loaded',
    'recording-count',
    'meeting-card',
    'meeting-card-metadata',
  ]),
  processRecoveryRecordingDelta: 1,
  rawHierarchyPersistenceAllowed: false,
});
