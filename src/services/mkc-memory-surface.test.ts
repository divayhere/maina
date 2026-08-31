// @ts-nocheck -- Vitest executes this build-graph audit in Node; the app TSConfig intentionally omits Node globals.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const routeFiles = [
  'app/memory/index.tsx',
  'app/memory/meetings.tsx',
  'app/memory/meeting/[source-key].tsx',
  'app/memory/pulse.tsx',
  'app/memory/saved-recalls.tsx',
  'app/memory/saved-recall/[definition-id].tsx',
  'app/memory/recall/[search-id].tsx',
];

describe('default-off mobile Memory surface', () => {
  it('owns one nested native Stack route family without platform-specific route drift', () => {
    const files = Object.fromEntries(routeFiles.map((path) => [path, readFileSync(resolve(root, path), 'utf8')]));
    expect(Object.keys(files)).toEqual(routeFiles);
    expect(files['app/memory/index.tsx']).toContain('mobileMemorySurfaceV1');
    expect(files['app/memory/meetings.tsx']).toContain('mobileCloudMeetingsV1');
    expect(files['app/memory/pulse.tsx']).toContain('mobileMemoryPulseV1');
    expect(files['app/memory/saved-recalls.tsx']).toContain('mobileSavedRecallsV1');
    expect(files['app/memory/saved-recall/[definition-id].tsx']).toContain('mobileSavedRecallsV1');
    expect(files['app/memory/recall/[search-id].tsx']).toContain('mobileFrozenHandoffV1');
    expect(Object.values(files).join('\n')).not.toMatch(/Platform\.OS|BackHandler|PanResponder/);
  });

  it('contains no Memory background poller, pipeline scheduler, or automatic Smart Recall execution', () => {
    const sources = [
      ...routeFiles.map((path) => readFileSync(resolve(root, path), 'utf8')),
      readFileSync(resolve(root, 'services/mkc-memory-releases.ts'), 'utf8'),
      readFileSync(resolve(root, 'hooks/useMemoryResource.ts'), 'utf8'),
    ].join('\n');
    expect(sources).not.toMatch(/setInterval|registerBackground|requestDurablePipelineWake|scheduleNativePipelineWake/);
    const detail = readFileSync(resolve(root, 'app/memory/saved-recall/[definition-id].tsx'), 'utf8');
    expect(detail.match(/runSavedSmartRecall\(/g)).toHaveLength(1);
    expect(detail.match(/prepareSavedSmartRecall\(/g)).toHaveLength(1);
    expect(detail).not.toMatch(/useEffect/);
    expect(sources).toContain("action === 'run'");
    expect(sources).toContain("action === 'prepare'");
  });

  it('keeps Pulse/Recall refresh independent of the recording and cloud outbox stores', () => {
    const releases = readFileSync(resolve(root, 'services/mkc-memory-releases.ts'), 'utf8');
    expect(releases).not.toMatch(/meetingPacket|pipelineWake|mainaKnowledgeCloud|recording/);
    expect(releases).toContain("kind: 'pulse'");
    expect(releases).toContain("kind: 'saved-recalls'");
  });
});
