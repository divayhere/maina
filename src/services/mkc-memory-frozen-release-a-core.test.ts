import { describe, expect, it } from 'vitest';

import {
  frozenBundleSha256,
  frozenChapterSha256,
  frozenRecallChapterFixture,
  frozenRecallOpenFixture,
  frozenRecallSourceFixture,
  frozenResultSha256,
} from './__fixtures__/mkc-release-a-fixtures';
import {
  buildFrozenRecallChapterPath,
  buildFrozenRecallOpenPath,
  buildFrozenRecallSourcePath,
  decodeFrozenRecallChapter,
  decodeFrozenRecallOpen,
  decodeFrozenRecallSource,
} from './mkc-memory-frozen-release-a-core';
import { MkcReleaseAContractError } from './mkc-memory-release-a-core';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const validNow = Date.parse('2026-08-30T00:00:00.000Z');

describe('MKC Release A frozen Recall boundary', () => {
  it('builds opaque, credential-free, encoded frozen paths', () => {
    expect(buildFrozenRecallOpenPath('search/id one'))
      .toBe('/v1/recall/searches/search%2Fid%20one/open');
    expect(buildFrozenRecallChapterPath('search/id', 'chapter one'))
      .toBe('/v1/recall/searches/search%2Fid/bundle/chapters/chapter%20one');
    expect(buildFrozenRecallSourcePath('search/id', 'meeting:maina/id'))
      .toBe('/v1/recall/searches/search%2Fid/sources/meeting%3Amaina%2Fid');
  });

  it('strictly decodes open, chapter and source fixtures', () => {
    expect(decodeFrozenRecallOpen(frozenRecallOpenFixture, {
      searchId: frozenRecallOpenFixture.search_id,
      now: validNow,
    })).toEqual(frozenRecallOpenFixture);
    expect(decodeFrozenRecallChapter(frozenRecallChapterFixture, {
      searchId: frozenRecallOpenFixture.search_id,
      chapterId: frozenRecallChapterFixture.chapter_id,
      resultSha256: frozenResultSha256,
      bundleSha256: frozenBundleSha256,
      chapterSha256: frozenChapterSha256,
      now: validNow,
    })).toEqual(frozenRecallChapterFixture);
    expect(decodeFrozenRecallSource(frozenRecallSourceFixture, {
      searchId: frozenRecallOpenFixture.search_id,
      sourceKey: frozenRecallSourceFixture.source.source_key,
      resultSha256: frozenResultSha256,
      bundleSha256: frozenBundleSha256,
      now: validNow,
    })).toEqual(frozenRecallSourceFixture);
  });

  it('fails closed on missing or malformed checksums', () => {
    const missing = clone(frozenRecallOpenFixture) as unknown as Record<string, unknown>;
    delete missing.bundle_sha256;
    expect(() => decodeFrozenRecallOpen(missing, {
      searchId: frozenRecallOpenFixture.search_id,
      now: validNow,
    })).toThrow(MkcReleaseAContractError);
    expect(() => decodeFrozenRecallOpen({ ...frozenRecallOpenFixture, result_sha256: 'short' }, {
      searchId: frozenRecallOpenFixture.search_id,
      now: validNow,
    })).toThrow(MkcReleaseAContractError);
  });

  it('fails closed on expired frozen data, including cached data', () => {
    expect(() => decodeFrozenRecallOpen({
      ...frozenRecallOpenFixture,
      expires_at: '2026-08-29T00:00:00.000Z',
    }, {
      searchId: frozenRecallOpenFixture.search_id,
      now: validNow,
    })).toThrowError('This saved memory is no longer available.');
  });

  it('binds every continuation to search, result and bundle identity', () => {
    expect(() => decodeFrozenRecallChapter(frozenRecallChapterFixture, {
      searchId: 'search-foreign',
      chapterId: frozenRecallChapterFixture.chapter_id,
      resultSha256: frozenResultSha256,
      bundleSha256: frozenBundleSha256,
      now: validNow,
    })).toThrow(MkcReleaseAContractError);
    expect(() => decodeFrozenRecallChapter(frozenRecallChapterFixture, {
      searchId: frozenRecallOpenFixture.search_id,
      chapterId: frozenRecallChapterFixture.chapter_id,
      resultSha256: 'e'.repeat(64),
      bundleSha256: frozenBundleSha256,
      now: validNow,
    })).toThrow(MkcReleaseAContractError);
    expect(() => decodeFrozenRecallSource(frozenRecallSourceFixture, {
      searchId: frozenRecallOpenFixture.search_id,
      sourceKey: frozenRecallSourceFixture.source.source_key,
      resultSha256: frozenResultSha256,
      bundleSha256: 'e'.repeat(64),
      now: validNow,
    })).toThrow(MkcReleaseAContractError);
  });

  it('rejects stale chapter identity and source substitution', () => {
    expect(() => decodeFrozenRecallChapter(frozenRecallChapterFixture, {
      searchId: frozenRecallOpenFixture.search_id,
      chapterId: 'chapter-new',
      resultSha256: frozenResultSha256,
      bundleSha256: frozenBundleSha256,
      chapterSha256: frozenChapterSha256,
      now: validNow,
    })).toThrow(MkcReleaseAContractError);
    expect(() => decodeFrozenRecallChapter(frozenRecallChapterFixture, {
      searchId: frozenRecallOpenFixture.search_id,
      chapterId: frozenRecallChapterFixture.chapter_id,
      resultSha256: frozenResultSha256,
      bundleSha256: frozenBundleSha256,
      chapterSha256: 'e'.repeat(64),
      now: validNow,
    })).toThrow(MkcReleaseAContractError);
    expect(() => decodeFrozenRecallSource(frozenRecallSourceFixture, {
      searchId: frozenRecallOpenFixture.search_id,
      sourceKey: 'meeting:maina:other',
      resultSha256: frozenResultSha256,
      bundleSha256: frozenBundleSha256,
      now: validNow,
    })).toThrow(MkcReleaseAContractError);
  });

  it('rejects incomplete coverage and unknown response fields', () => {
    const incomplete = clone(frozenRecallOpenFixture);
    (incomplete.coverage as unknown as Record<string, unknown>).evidence_complete = 'yes';
    expect(() => decodeFrozenRecallOpen(incomplete, {
      searchId: frozenRecallOpenFixture.search_id,
      now: validNow,
    })).toThrow(MkcReleaseAContractError);
    expect(() => decodeFrozenRecallOpen({ ...frozenRecallOpenFixture, extra: true }, {
      searchId: frozenRecallOpenFixture.search_id,
      now: validNow,
    })).toThrow(MkcReleaseAContractError);
  });
});
