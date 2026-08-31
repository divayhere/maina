const MKC_WEB_BASE_URL = 'https://maina-knowledge-cloud-web.maina-knowledge-cloud.workers.dev';

function safeSegment(value: string): string {
  if (!value.trim()) throw new Error('Memory Web identity is required.');
  return encodeURIComponent(value);
}

export type MkcMemoryWebTarget =
  | { kind: 'home' }
  | { kind: 'meetings' }
  | { kind: 'meeting'; sourceKey: string }
  | { kind: 'source'; sourceKey: string }
  | { kind: 'recall'; searchId: string }
  | { kind: 'saved-recalls' }
  | { kind: 'saved-recall'; definitionId: string };

export function buildMkcMemoryWebUrl(target: MkcMemoryWebTarget): string {
  switch (target.kind) {
    case 'home': return MKC_WEB_BASE_URL;
    case 'meetings': return `${MKC_WEB_BASE_URL}/meetings`;
    case 'meeting': return `${MKC_WEB_BASE_URL}/meetings/${safeSegment(target.sourceKey)}`;
    case 'source': return `${MKC_WEB_BASE_URL}/source/${safeSegment(target.sourceKey)}`;
    case 'recall': return `${MKC_WEB_BASE_URL}/recall?search_id=${safeSegment(target.searchId)}`;
    case 'saved-recalls': return `${MKC_WEB_BASE_URL}/smart-recalls`;
    case 'saved-recall': return `${MKC_WEB_BASE_URL}/smart-recalls/${safeSegment(target.definitionId)}`;
  }
}
