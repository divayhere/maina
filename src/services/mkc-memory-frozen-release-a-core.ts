import type {
  FrozenRecallChapterV1,
  FrozenRecallOpenV1,
  FrozenRecallSource,
  FrozenRecallSourceOpenV1,
  QueryPlanV2,
  RecallCoverageReceiptV1,
  RecallExpansion,
  RecallConstraint,
} from '@/contracts/mkc-release-a.generated';

import { MkcReleaseAContractError } from './mkc-memory-release-a-core';

type JsonRecord = Record<string, unknown>;

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

function record(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MkcReleaseAContractError(field);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, allowed: readonly string[], field: string): void {
  const permitted = new Set(allowed);
  if (Object.keys(value).some((key) => !permitted.has(key))) throw new MkcReleaseAContractError(field);
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new MkcReleaseAContractError(field);
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  const result = string(value, field);
  if (!result.trim()) throw new MkcReleaseAContractError(field);
  return result;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : string(value, field);
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  return value === undefined ? undefined : nullableString(value, field);
}

function isoDate(value: unknown, field: string): string {
  const result = string(value, field);
  if (!Number.isFinite(Date.parse(result))) throw new MkcReleaseAContractError(field);
  return result;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new MkcReleaseAContractError(field);
  return Number(value);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new MkcReleaseAContractError(field);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new MkcReleaseAContractError(field);
  return value;
}

function checksum(value: unknown, field: string): string {
  const result = string(value, field);
  if (!CHECKSUM_PATTERN.test(result)) throw new MkcReleaseAContractError(field);
  return result;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new MkcReleaseAContractError(field);
  return value as T;
}

function array<T>(value: unknown, field: string, decode: (item: unknown, itemField: string) => T): T[] {
  if (!Array.isArray(value)) throw new MkcReleaseAContractError(field);
  return value.map((item, index) => decode(item, `${field}[${index}]`));
}

function stringArray(value: unknown, field: string): string[] {
  return array(value, field, string);
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, field);
}

function assertNotExpired(expiresAt: string, now = Date.now()): void {
  if (Date.parse(expiresAt) <= now) {
    throw new MkcReleaseAContractError('frozen.expires_at', 'This saved memory is no longer available.');
  }
}

function assertIdentity(actual: string, expected: string | undefined, field: string): void {
  if (expected !== undefined && actual !== expected) throw new MkcReleaseAContractError(field);
}

function decodeConstraint(value: unknown, field: string): RecallConstraint {
  const item = record(value, field);
  exactKeys(item, ['kind', 'value', 'source', 'removable'], field);
  return {
    kind: oneOf(item.kind, ['workspace', 'project', 'topic', 'source_family', 'source_type', 'date', 'deadline', 'fact_type'], `${field}.kind`),
    value: string(item.value, `${field}.value`),
    source: oneOf(item.source, ['explicit', 'inferred', 'inherited', 'default'], `${field}.source`),
    removable: boolean(item.removable, `${field}.removable`),
  };
}

function decodeExpansion(value: unknown, field: string): RecallExpansion {
  const item = record(value, field);
  exactKeys(item, ['original', 'expanded', 'kind', 'source', 'confidence'], field);
  return {
    original: string(item.original, `${field}.original`),
    expanded: string(item.expanded, `${field}.expanded`),
    kind: oneOf(item.kind, ['alias', 'typo', 'transliteration'], `${field}.kind`),
    source: oneOf(item.source, ['deterministic', 'registry', 'provider'], `${field}.source`),
    confidence: finiteNumber(item.confidence, `${field}.confidence`),
  };
}

function decodeQueryPlan(value: unknown, field: string): QueryPlanV2 {
  const item = record(value, field);
  exactKeys(item, [
    'schema_version', 'original_query', 'planner_version', 'planner_source', 'user_job', 'execution_strategy',
    'result_mode', 'coverage_mode', 'scope_strategy', 'sort', 'timezone', 'date_basis', 'occurred_from',
    'occurred_to_exclusive', 'deadline_from', 'deadline_to_exclusive', 'explicit_constraints',
    'inferred_constraints', 'exact_literals', 'exact_identifiers', 'aliases', 'typo_candidates', 'topical_query',
    'supporting_queries', 'source_families', 'source_types', 'fact_types', 'fact_owners', 'fact_statuses',
    'requested_count', 'intent', 'presentation_job', 'presentation_instructions',
  ], field);
  if (item.schema_version !== 'mkc.query-plan.v2') throw new MkcReleaseAContractError(`${field}.schema_version`);
  const optionalScope = item.scope_strategy === undefined
    ? undefined
    : oneOf(item.scope_strategy, ['ranked', 'full_if_within_budget'], `${field}.scope_strategy`);
  const optionalFactStatuses: QueryPlanV2['fact_statuses'] = item.fact_statuses === undefined
    ? undefined
    : array<'open' | 'completed' | 'cancelled'>(item.fact_statuses, `${field}.fact_statuses`, (entry, entryField) =>
      oneOf(entry, ['open', 'completed', 'cancelled'], entryField));
  const optionalPresentationJob = item.presentation_job === undefined
    ? undefined
    : oneOf(item.presentation_job, ['default', 'chronology', 'list', 'comparison'], `${field}.presentation_job`);
  return {
    schema_version: 'mkc.query-plan.v2',
    original_query: string(item.original_query, `${field}.original_query`),
    planner_version: nonEmptyString(item.planner_version, `${field}.planner_version`),
    planner_source: oneOf(item.planner_source, ['deterministic', 'provider_guarded', 'provider_fallback'], `${field}.planner_source`),
    user_job: oneOf(item.user_job, ['locate', 'collect', 'typed_memory', 'browse_history', 'research', 'answer'], `${field}.user_job`),
    execution_strategy: oneOf(item.execution_strategy, ['deterministic_list', 'typed_fact_lookup', 'focused_answer', 'research_bundle'], `${field}.execution_strategy`),
    result_mode: oneOf(item.result_mode, ['sources', 'passages', 'facts', 'bundle'], `${field}.result_mode`),
    coverage_mode: oneOf(item.coverage_mode, ['top_matches', 'all_filtered'], `${field}.coverage_mode`),
    ...(optionalScope === undefined ? {} : { scope_strategy: optionalScope }),
    sort: oneOf(item.sort, ['relevance', 'newest', 'oldest'], `${field}.sort`),
    timezone: nonEmptyString(item.timezone, `${field}.timezone`),
    date_basis: oneOf(item.date_basis, ['source_occurred_at', 'fact_deadline', 'source_and_fact'], `${field}.date_basis`),
    occurred_from: nullableString(item.occurred_from, `${field}.occurred_from`),
    occurred_to_exclusive: nullableString(item.occurred_to_exclusive, `${field}.occurred_to_exclusive`),
    ...(item.deadline_from === undefined ? {} : { deadline_from: optionalNullableString(item.deadline_from, `${field}.deadline_from`) }),
    ...(item.deadline_to_exclusive === undefined ? {} : { deadline_to_exclusive: optionalNullableString(item.deadline_to_exclusive, `${field}.deadline_to_exclusive`) }),
    explicit_constraints: array(item.explicit_constraints, `${field}.explicit_constraints`, decodeConstraint),
    inferred_constraints: array(item.inferred_constraints, `${field}.inferred_constraints`, decodeConstraint),
    exact_literals: stringArray(item.exact_literals, `${field}.exact_literals`),
    exact_identifiers: stringArray(item.exact_identifiers, `${field}.exact_identifiers`),
    aliases: array(item.aliases, `${field}.aliases`, decodeExpansion),
    typo_candidates: array(item.typo_candidates, `${field}.typo_candidates`, decodeExpansion),
    topical_query: string(item.topical_query, `${field}.topical_query`),
    supporting_queries: stringArray(item.supporting_queries, `${field}.supporting_queries`),
    source_families: array(item.source_families, `${field}.source_families`, (entry, entryField) =>
      oneOf(entry, ['all', 'meetings', 'documents', 'notes', 'email'], entryField)),
    source_types: stringArray(item.source_types, `${field}.source_types`),
    fact_types: array(item.fact_types, `${field}.fact_types`, (entry, entryField) =>
      oneOf(entry, ['decision', 'action', 'question', 'claim', 'important_point'], entryField)),
    ...(item.fact_owners === undefined ? {} : { fact_owners: optionalStringArray(item.fact_owners, `${field}.fact_owners`) }),
    ...(optionalFactStatuses === undefined ? {} : { fact_statuses: optionalFactStatuses }),
    requested_count: item.requested_count === null ? null : integer(item.requested_count, `${field}.requested_count`),
    intent: oneOf(item.intent, ['decision', 'task', 'question', 'timeline', 'general'], `${field}.intent`),
    ...(optionalPresentationJob === undefined ? {} : { presentation_job: optionalPresentationJob }),
    ...(item.presentation_instructions === undefined ? {} : {
      presentation_instructions: optionalStringArray(item.presentation_instructions, `${field}.presentation_instructions`),
    }),
  };
}

function decodeCoverage(value: unknown, field: string): RecallCoverageReceiptV1 {
  const item = record(value, field);
  exactKeys(item, [
    'schema_version', 'mode', 'scope_source_count', 'inspected_source_count', 'returned_source_count',
    'source_census_complete', 'evidence_complete', 'evidence_source_count', 'evidence_passage_count',
    'unreadable_source_count', 'omitted_evidence_source_count', 'evidence_truncated', 'coverage_basis',
    'complete', 'truncated', 'continuation_available', 'exclusions', 'warnings',
  ], field);
  if (item.schema_version !== 'mkc.coverage-receipt.v1') throw new MkcReleaseAContractError(`${field}.schema_version`);
  return {
    schema_version: 'mkc.coverage-receipt.v1',
    mode: oneOf(item.mode, ['top_matches', 'all_filtered'], `${field}.mode`),
    scope_source_count: integer(item.scope_source_count, `${field}.scope_source_count`),
    inspected_source_count: integer(item.inspected_source_count, `${field}.inspected_source_count`),
    returned_source_count: integer(item.returned_source_count, `${field}.returned_source_count`),
    source_census_complete: boolean(item.source_census_complete, `${field}.source_census_complete`),
    evidence_complete: boolean(item.evidence_complete, `${field}.evidence_complete`),
    evidence_source_count: integer(item.evidence_source_count, `${field}.evidence_source_count`),
    evidence_passage_count: integer(item.evidence_passage_count, `${field}.evidence_passage_count`),
    unreadable_source_count: integer(item.unreadable_source_count, `${field}.unreadable_source_count`),
    omitted_evidence_source_count: integer(item.omitted_evidence_source_count, `${field}.omitted_evidence_source_count`),
    evidence_truncated: boolean(item.evidence_truncated, `${field}.evidence_truncated`),
    coverage_basis: oneOf(item.coverage_basis, ['ranked_retrieval', 'deterministic_source_census', 'typed_facts'], `${field}.coverage_basis`),
    complete: boolean(item.complete, `${field}.complete`),
    truncated: boolean(item.truncated, `${field}.truncated`),
    continuation_available: boolean(item.continuation_available, `${field}.continuation_available`),
    exclusions: stringArray(item.exclusions, `${field}.exclusions`),
    warnings: stringArray(item.warnings, `${field}.warnings`),
  };
}

function decodeFrozenSource(value: unknown, field: string): FrozenRecallSource {
  const item = record(value, field);
  exactKeys(item, [
    'source_key', 'title', 'source_type', 'occurred_at', 'workspace_key', 'project_key',
    'summary_text', 'score', 'match_reasons', 'evidence',
  ], field);
  return {
    source_key: nonEmptyString(item.source_key, `${field}.source_key`),
    title: string(item.title, `${field}.title`),
    source_type: nonEmptyString(item.source_type, `${field}.source_type`),
    occurred_at: isoDate(item.occurred_at, `${field}.occurred_at`),
    workspace_key: string(item.workspace_key, `${field}.workspace_key`),
    project_key: string(item.project_key, `${field}.project_key`),
    summary_text: nullableString(item.summary_text, `${field}.summary_text`),
    score: item.score === null ? null : finiteNumber(item.score, `${field}.score`),
    match_reasons: stringArray(item.match_reasons, `${field}.match_reasons`),
    evidence: array(item.evidence, `${field}.evidence`, (entry, entryField) => {
      const evidence = record(entry, entryField);
      exactKeys(evidence, ['evidence_id', 'evidence_kind', 'field_path', 'snippet', 'score'], entryField);
      return {
        evidence_id: nonEmptyString(evidence.evidence_id, `${entryField}.evidence_id`),
        evidence_kind: nonEmptyString(evidence.evidence_kind, `${entryField}.evidence_kind`),
        field_path: nullableString(evidence.field_path, `${entryField}.field_path`),
        snippet: string(evidence.snippet, `${entryField}.snippet`),
        score: finiteNumber(evidence.score, `${entryField}.score`),
      };
    }),
  };
}

function decodeIdentity(value: JsonRecord, field: string, expected: {
  searchId: string;
  resultSha256?: string;
  bundleSha256?: string;
  now?: number;
}) {
  const searchId = nonEmptyString(value.search_id, `${field}.search_id`);
  const resultSha256 = checksum(value.result_sha256, `${field}.result_sha256`);
  const bundleSha256 = checksum(value.bundle_sha256, `${field}.bundle_sha256`);
  const expiresAt = isoDate(value.expires_at, `${field}.expires_at`);
  assertIdentity(searchId, expected.searchId, `${field}.search_id`);
  assertIdentity(resultSha256, expected.resultSha256, `${field}.result_sha256`);
  assertIdentity(bundleSha256, expected.bundleSha256, `${field}.bundle_sha256`);
  assertNotExpired(expiresAt, expected.now);
  return { searchId, resultSha256, bundleSha256, expiresAt };
}

export function decodeFrozenRecallOpen(value: unknown, expected: {
  searchId: string;
  now?: number;
}): FrozenRecallOpenV1 {
  const body = record(value, 'frozen-open');
  exactKeys(body, [
    'schema_version', 'search_id', 'created_at', 'expires_at', 'result_sha256', 'bundle_sha256',
    'plan', 'coverage', 'source_count', 'fact_count', 'source_manifest_markdown', 'memory_bundle_markdown', 'bundle',
  ], 'frozen-open');
  if (body.schema_version !== 'mkc.frozen-recall-open.v1') throw new MkcReleaseAContractError('frozen-open.schema_version');
  const identity = decodeIdentity(body, 'frozen-open', expected);
  const bundle = record(body.bundle, 'frozen-open.bundle');
  exactKeys(bundle, [
    'token_budget', 'estimated_tokens', 'core_source_count', 'core_evidence_count', 'available_source_count',
    'available_evidence_count', 'omitted_from_core_source_count', 'truncated', 'recommended_next_chapter_id', 'chapters',
  ], 'frozen-open.bundle');
  return {
    schema_version: 'mkc.frozen-recall-open.v1',
    search_id: identity.searchId,
    created_at: isoDate(body.created_at, 'frozen-open.created_at'),
    expires_at: identity.expiresAt,
    result_sha256: identity.resultSha256,
    bundle_sha256: identity.bundleSha256,
    plan: decodeQueryPlan(body.plan, 'frozen-open.plan'),
    coverage: decodeCoverage(body.coverage, 'frozen-open.coverage'),
    source_count: integer(body.source_count, 'frozen-open.source_count'),
    fact_count: integer(body.fact_count, 'frozen-open.fact_count'),
    source_manifest_markdown: string(body.source_manifest_markdown, 'frozen-open.source_manifest_markdown'),
    memory_bundle_markdown: string(body.memory_bundle_markdown, 'frozen-open.memory_bundle_markdown'),
    bundle: {
      token_budget: integer(bundle.token_budget, 'frozen-open.bundle.token_budget'),
      estimated_tokens: integer(bundle.estimated_tokens, 'frozen-open.bundle.estimated_tokens'),
      core_source_count: integer(bundle.core_source_count, 'frozen-open.bundle.core_source_count'),
      core_evidence_count: integer(bundle.core_evidence_count, 'frozen-open.bundle.core_evidence_count'),
      available_source_count: integer(bundle.available_source_count, 'frozen-open.bundle.available_source_count'),
      available_evidence_count: integer(bundle.available_evidence_count, 'frozen-open.bundle.available_evidence_count'),
      omitted_from_core_source_count: integer(bundle.omitted_from_core_source_count, 'frozen-open.bundle.omitted_from_core_source_count'),
      truncated: boolean(bundle.truncated, 'frozen-open.bundle.truncated'),
      recommended_next_chapter_id: nullableString(bundle.recommended_next_chapter_id, 'frozen-open.bundle.recommended_next_chapter_id'),
      chapters: array(bundle.chapters, 'frozen-open.bundle.chapters', (entry, entryField) => {
        const chapter = record(entry, entryField);
        exactKeys(chapter, ['chapter_id', 'title', 'source_count', 'evidence_count', 'estimated_tokens', 'chapter_sha256'], entryField);
        return {
          chapter_id: nonEmptyString(chapter.chapter_id, `${entryField}.chapter_id`),
          title: string(chapter.title, `${entryField}.title`),
          source_count: integer(chapter.source_count, `${entryField}.source_count`),
          evidence_count: integer(chapter.evidence_count, `${entryField}.evidence_count`),
          estimated_tokens: integer(chapter.estimated_tokens, `${entryField}.estimated_tokens`),
          chapter_sha256: checksum(chapter.chapter_sha256, `${entryField}.chapter_sha256`),
        };
      }),
    },
  };
}

export function decodeFrozenRecallChapter(value: unknown, expected: {
  searchId: string;
  chapterId: string;
  resultSha256: string;
  bundleSha256: string;
  chapterSha256?: string;
  now?: number;
}): FrozenRecallChapterV1 {
  const body = record(value, 'frozen-chapter');
  exactKeys(body, [
    'chapter_id', 'title', 'source_keys', 'source_count', 'evidence_count', 'estimated_tokens', 'markdown',
    'chapter_sha256', 'schema_version', 'search_id', 'result_sha256', 'bundle_sha256', 'expires_at', 'coverage',
  ], 'frozen-chapter');
  if (body.schema_version !== 'mkc.frozen-recall-chapter.v1') throw new MkcReleaseAContractError('frozen-chapter.schema_version');
  const identity = decodeIdentity(body, 'frozen-chapter', expected);
  const chapterId = nonEmptyString(body.chapter_id, 'frozen-chapter.chapter_id');
  assertIdentity(chapterId, expected.chapterId, 'frozen-chapter.chapter_id');
  const chapterSha256 = checksum(body.chapter_sha256, 'frozen-chapter.chapter_sha256');
  assertIdentity(chapterSha256, expected.chapterSha256, 'frozen-chapter.chapter_sha256');
  return {
    schema_version: 'mkc.frozen-recall-chapter.v1',
    search_id: identity.searchId,
    result_sha256: identity.resultSha256,
    bundle_sha256: identity.bundleSha256,
    expires_at: identity.expiresAt,
    coverage: decodeCoverage(body.coverage, 'frozen-chapter.coverage'),
    chapter_id: chapterId,
    title: string(body.title, 'frozen-chapter.title'),
    source_keys: stringArray(body.source_keys, 'frozen-chapter.source_keys'),
    source_count: integer(body.source_count, 'frozen-chapter.source_count'),
    evidence_count: integer(body.evidence_count, 'frozen-chapter.evidence_count'),
    estimated_tokens: integer(body.estimated_tokens, 'frozen-chapter.estimated_tokens'),
    markdown: string(body.markdown, 'frozen-chapter.markdown'),
    chapter_sha256: chapterSha256,
  };
}

export function decodeFrozenRecallSource(value: unknown, expected: {
  searchId: string;
  sourceKey: string;
  resultSha256: string;
  bundleSha256: string;
  now?: number;
}): FrozenRecallSourceOpenV1 {
  const body = record(value, 'frozen-source');
  exactKeys(body, ['schema_version', 'search_id', 'result_sha256', 'bundle_sha256', 'expires_at', 'coverage', 'source'], 'frozen-source');
  if (body.schema_version !== 'mkc.frozen-recall-source.v1') throw new MkcReleaseAContractError('frozen-source.schema_version');
  const identity = decodeIdentity(body, 'frozen-source', expected);
  const source = decodeFrozenSource(body.source, 'frozen-source.source');
  assertIdentity(source.source_key, expected.sourceKey, 'frozen-source.source.source_key');
  return {
    schema_version: 'mkc.frozen-recall-source.v1',
    search_id: identity.searchId,
    result_sha256: identity.resultSha256,
    bundle_sha256: identity.bundleSha256,
    expires_at: identity.expiresAt,
    coverage: decodeCoverage(body.coverage, 'frozen-source.coverage'),
    source,
  };
}

export function buildFrozenRecallOpenPath(searchId: string): string {
  return `/v1/recall/searches/${encodeURIComponent(nonEmptyString(searchId, 'searchId'))}/open`;
}

export function buildFrozenRecallChapterPath(searchId: string, chapterId: string): string {
  return `/v1/recall/searches/${encodeURIComponent(nonEmptyString(searchId, 'searchId'))}` +
    `/bundle/chapters/${encodeURIComponent(nonEmptyString(chapterId, 'chapterId'))}`;
}

export function buildFrozenRecallSourcePath(searchId: string, sourceKey: string): string {
  return `/v1/recall/searches/${encodeURIComponent(nonEmptyString(searchId, 'searchId'))}` +
    `/sources/${encodeURIComponent(nonEmptyString(sourceKey, 'sourceKey'))}`;
}
