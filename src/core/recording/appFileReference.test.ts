import { describe, expect, it } from 'vitest';
import {
  isPortableDocumentReference,
  resolveDocumentReference,
  toPortableDocumentReference,
} from './appFileReference';

const current = 'file:///var/mobile/Containers/Data/Application/NEW/Documents/';

describe('portable app-owned file references', () => {
  it('stores a current Documents URL without its container UUID', () => {
    expect(toPortableDocumentReference(`${current}rec-meeting-1/`, current))
      .toBe('maina-document:///rec-meeting-1/');
  });
  it('rebases a stale iOS container URL', () => {
    const stale = 'file:///var/mobile/Containers/Data/Application/OLD/Documents/rec-meeting-1/capture-00000.wav';
    expect(resolveDocumentReference(stale, current)).toBe(`${current}rec-meeting-1/capture-00000.wav`);
  });
  it('resolves a portable reference idempotently', () => {
    const stored = 'maina-document:///rec-meeting-1';
    expect(toPortableDocumentReference(stored, current)).toBe(stored);
    expect(resolveDocumentReference(stored, current)).toBe(`${current}rec-meeting-1`);
    expect(isPortableDocumentReference(stored)).toBe(true);
  });
  it('rejects path traversal and ignores external files', () => {
    expect(toPortableDocumentReference('file:///tmp/external.wav', current)).toBe('file:///tmp/external.wav');
    expect(resolveDocumentReference('maina-document:///../outside.wav', current))
      .toBe('maina-document:///../outside.wav');
  });
});
