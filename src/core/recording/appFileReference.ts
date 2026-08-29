const DOCUMENT_REFERENCE_PREFIX = 'maina-document:///';

function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function cleanRelativePath(value: string): string | null {
  const raw = value.split(/[?#]/, 1)[0];
  const hadTrailingSlash = raw.endsWith('/');
  const withoutQuery = raw.replace(/^\/+/, '');
  if (!withoutQuery || withoutQuery.includes('\0')) return null;
  const parts = withoutQuery.split('/');
  if (parts.some((part) => part === '..')) return null;
  const cleaned = parts.filter((part) => part !== '.' && part !== '').join('/');
  return cleaned && hadTrailingSlash ? `${cleaned}/` : cleaned;
}

/** Stores an app-owned Documents URL without a volatile container prefix. */
export function toPortableDocumentReference(
  value: string | null | undefined,
  currentDocumentDirectory: string | null | undefined,
): string | null {
  if (!value) return null;
  if (value.startsWith(DOCUMENT_REFERENCE_PREFIX)) {
    const relative = cleanRelativePath(value.slice(DOCUMENT_REFERENCE_PREFIX.length));
    return relative ? `${DOCUMENT_REFERENCE_PREFIX}${relative}` : value;
  }
  const root = currentDocumentDirectory ? withTrailingSlash(currentDocumentDirectory) : null;
  let relative: string | null = null;
  if (root && value.startsWith(root)) {
    relative = cleanRelativePath(value.slice(root.length));
  } else {
    const marker = '/Documents/';
    const markerIndex = value.indexOf(marker);
    if (markerIndex >= 0) relative = cleanRelativePath(value.slice(markerIndex + marker.length));
  }
  return relative ? `${DOCUMENT_REFERENCE_PREFIX}${relative}` : value;
}

export function resolveDocumentReference(
  value: string | null | undefined,
  currentDocumentDirectory: string | null | undefined,
): string | null {
  if (!value) return null;
  if (!currentDocumentDirectory) return value;
  const portable = toPortableDocumentReference(value, currentDocumentDirectory);
  if (!portable?.startsWith(DOCUMENT_REFERENCE_PREFIX)) return value;
  const relative = cleanRelativePath(portable.slice(DOCUMENT_REFERENCE_PREFIX.length));
  if (!relative) return value;
  return `${withTrailingSlash(currentDocumentDirectory)}${relative}`;
}

export function isPortableDocumentReference(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith(DOCUMENT_REFERENCE_PREFIX));
}
