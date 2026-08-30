#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const orderedParameters = [
  'generation',
  'requiresNetwork',
  'notBeforeAt',
  'scheduleRevision',
  'previousWorkId',
  'previousNotBeforeAt',
  'previousScheduleRevision',
  'schedulerProtocolVersion',
];

function assertOrdered(label, source, parameters = orderedParameters) {
  let cursor = -1;
  for (const parameter of parameters) {
    const next = source.indexOf(parameter, cursor + 1);
    if (next < 0) throw new Error(`${label} is missing ${parameter}.`);
    if (next <= cursor) throw new Error(`${label} has an invalid ${parameter} order.`);
    cursor = next;
  }
}

function sliceFrom(relativePath, marker, length = 2_500) {
  const file = path.join(project, relativePath);
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${relativePath} is missing ${marker}.`);
  return source.slice(start, start + length);
}

assertOrdered(
  'public SchedulePipelineWake type',
  sliceFrom('modules/maina-recorder/src/index.ts', 'export type SchedulePipelineWake'),
);
assertOrdered(
  'shared native invocation',
  sliceFrom('src/hardware/pipelineWake.ts', 'nativeModule.schedulePipelineWake('),
  orderedParameters.map((parameter) => parameter === 'schedulerProtocolVersion' ? '2' : `input.${parameter}`),
);

const kotlin = path.join(
  project,
  'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt',
);
if (existsSync(kotlin)) {
  assertOrdered(
    'Android Expo module signature',
    sliceFrom(
      'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt',
      'AsyncFunction("schedulePipelineWake")',
    ),
  );
}

const swift = path.join(project, 'modules/maina-recorder/ios/MainaRecorderModule.swift');
if (existsSync(swift)) {
  assertOrdered(
    'iOS Expo module signature',
    sliceFrom('modules/maina-recorder/ios/MainaRecorderModule.swift', 'AsyncFunction("schedulePipelineWake")'),
  );
}

console.log('Pipeline wake native API parameter order is aligned.');
