/* eslint-disable @typescript-eslint/array-type */
// Generated from Maina Knowledge Cloud 57cbb52. Do not edit by hand.
// Run: npm run import:mkc-release-a

export type RecallIntent = "decision" | "task" | "question" | "timeline" | "general";

export const RECALL_SEARCH_REQUEST_VERSION = "mkc.recall-search-request.v1" as const;
export const QUERY_PLAN_VERSION = "mkc.query-plan.v2" as const;
export const FROZEN_SEARCH_RESULT_VERSION = "mkc.frozen-search-result.v1" as const;
export const COVERAGE_RECEIPT_VERSION = "mkc.coverage-receipt.v1" as const;
export const EVIDENCE_BUNDLE_VERSION = "mkc.evidence-bundle.v1" as const;
export const FROZEN_RECALL_OPEN_VERSION = "mkc.frozen-recall-open.v1" as const;
export const FROZEN_RECALL_CHAPTER_VERSION = "mkc.frozen-recall-chapter.v1" as const;
export const FROZEN_RECALL_SOURCE_VERSION = "mkc.frozen-recall-source.v1" as const;

export type SourceFamily =
  | "all"
  | "meetings"
  | "documents"
  | "notes"
  | "email";

export type RecallUserJob =
  | "locate"
  | "collect"
  | "typed_memory"
  | "browse_history"
  | "research"
  | "answer";

export type RecallResultMode = "sources" | "passages" | "facts" | "bundle";
export type RecallCoverageMode = "top_matches" | "all_filtered";
export type RecallSort = "relevance" | "newest" | "oldest";
export type RecallExecutionStrategy =
  | "deterministic_list"
  | "typed_fact_lookup"
  | "focused_answer"
  | "research_bundle";
export type RecallPresentationJob = "default" | "chronology" | "list" | "comparison";

export type RecallConstraint = {
  kind: "workspace" | "project" | "topic" | "source_family" | "source_type" | "date" | "deadline" | "fact_type";
  value: string;
  source: "explicit" | "inferred" | "inherited" | "default";
  removable: boolean;
};

export type RecallExpansion = {
  original: string;
  expanded: string;
  kind: "alias" | "typo" | "transliteration";
  source: "deterministic" | "registry" | "provider";
  confidence: number;
};

export type QueryPlanV2 = {
  schema_version: typeof QUERY_PLAN_VERSION;
  original_query: string;
  planner_version: string;
  planner_source: "deterministic" | "provider_guarded" | "provider_fallback";
  user_job: RecallUserJob;
  execution_strategy: RecallExecutionStrategy;
  result_mode: RecallResultMode;
  coverage_mode: RecallCoverageMode;
  scope_strategy?: "ranked" | "full_if_within_budget";
  sort: RecallSort;
  timezone: string;
  date_basis: "source_occurred_at" | "fact_deadline" | "source_and_fact";
  occurred_from: string | null;
  occurred_to_exclusive: string | null;
  deadline_from?: string | null;
  deadline_to_exclusive?: string | null;
  explicit_constraints: RecallConstraint[];
  inferred_constraints: RecallConstraint[];
  exact_literals: string[];
  exact_identifiers: string[];
  aliases: RecallExpansion[];
  typo_candidates: RecallExpansion[];
  topical_query: string;
  supporting_queries: string[];
  source_families: SourceFamily[];
  source_types: string[];
  fact_types: Array<"decision" | "action" | "question" | "claim" | "important_point">;
  fact_owners?: string[];
  fact_statuses?: Array<"open" | "completed" | "cancelled">;
  requested_count: number | null;
  intent: RecallIntent;
  presentation_job?: RecallPresentationJob;
  presentation_instructions?: string[];
};

export type RecallSearchRequestV1 = {
  schema_version?: typeof RECALL_SEARCH_REQUEST_VERSION;
  query: string;
  timezone?: string;
  explicit_filters?: {
    workspace_keys?: string[];
    project_keys?: string[];
    topic_keys?: string[];
    source_families?: SourceFamily[];
    source_types?: string[];
    occurred_date_from?: string;
    occurred_date_to?: string;
  };
  requested_mode?: "auto" | RecallResultMode;
  coverage?: "auto" | RecallCoverageMode;
  sort?: RecallSort;
  page_size?: number;
  cursor?: string;
};

export type FrozenRecallSource = {
  source_key: string;
  title: string;
  source_type: string;
  occurred_at: string;
  workspace_key: string;
  project_key: string;
  summary_text: string | null;
  score: number | null;
  match_reasons: string[];
  evidence: Array<{
    evidence_id: string;
    evidence_kind: string;
    field_path: string | null;
    snippet: string;
    score: number;
  }>;
};

export type FrozenRecallFact = {
  evidence_id: string | null;
  source_key: string;
  source_title: string;
  source_type: string;
  occurred_at: string;
  project_key: string;
  fact_type: "decision" | "action" | "question" | "claim" | "important_point";
  text: string;
  owner: string | null;
  deadline: string | null;
  deadline_at: string | null;
  status: "open" | "completed" | "cancelled" | null;
  confidence: number;
};

export type RecallCoverageReceiptV1 = {
  schema_version: typeof COVERAGE_RECEIPT_VERSION;
  mode: RecallCoverageMode;
  scope_source_count: number;
  inspected_source_count: number;
  returned_source_count: number;
  source_census_complete: boolean;
  evidence_complete: boolean;
  evidence_source_count: number;
  evidence_passage_count: number;
  unreadable_source_count: number;
  omitted_evidence_source_count: number;
  evidence_truncated: boolean;
  coverage_basis: "ranked_retrieval" | "deterministic_source_census" | "typed_facts";
  /** Compatibility alias for source_census_complete. */
  complete: boolean;
  truncated: boolean;
  continuation_available: boolean;
  exclusions: string[];
  warnings: string[];
};

export type EvidenceBundleChapterV1 = {
  chapter_id: string;
  title: string;
  source_keys: string[];
  source_count: number;
  evidence_count: number;
  estimated_tokens: number;
  markdown: string;
  chapter_sha256: string;
};

export type FrozenRecallOpenV1 = {
  schema_version: typeof FROZEN_RECALL_OPEN_VERSION;
  search_id: string;
  created_at: string;
  expires_at: string;
  result_sha256: string;
  bundle_sha256: string;
  plan: QueryPlanV2;
  coverage: RecallCoverageReceiptV1;
  source_count: number;
  fact_count: number;
  source_manifest_markdown: string;
  memory_bundle_markdown: string;
  bundle: {
    token_budget: number;
    estimated_tokens: number;
    core_source_count: number;
    core_evidence_count: number;
    available_source_count: number;
    available_evidence_count: number;
    omitted_from_core_source_count: number;
    truncated: boolean;
    recommended_next_chapter_id: string | null;
    chapters: Array<{
      chapter_id: string;
      title: string;
      source_count: number;
      evidence_count: number;
      estimated_tokens: number;
      chapter_sha256: string;
    }>;
  };
};

export type FrozenRecallChapterV1 = EvidenceBundleChapterV1 & {
  schema_version: typeof FROZEN_RECALL_CHAPTER_VERSION;
  search_id: string;
  result_sha256: string;
  bundle_sha256: string;
  expires_at: string;
  coverage: RecallCoverageReceiptV1;
};

export type FrozenRecallSourceOpenV1 = {
  schema_version: typeof FROZEN_RECALL_SOURCE_VERSION;
  search_id: string;
  result_sha256: string;
  bundle_sha256: string;
  expires_at: string;
  coverage: RecallCoverageReceiptV1;
  source: FrozenRecallSource;
};

export type MeetingReadiness = "ready" | "transcript_only" | "processing" | "summary_failed";

export type MeetingLibraryItem = {
  source_key: string;
  title: string;
  occurred_at: string;
  ingested_at: string;
  readiness: MeetingReadiness;
  duration_seconds: number | null;
  provenance: { kind: "maina_app"; platform: "android" | "ios" | null };
  summary_preview: string | null;
  counts: { decisions: number; todos: number; open_questions: number };
};

export type MeetingLibraryResponse = {
  schema_version: "mkc.meeting-library.v1";
  filters: {
    query: string | null;
    occurred_from: string | null;
    occurred_to_exclusive: string | null;
    readiness: string | null;
    sort: "newest" | "oldest";
  };
  total: number;
  meetings: MeetingLibraryItem[];
  page: { size: number; has_more: boolean; next_cursor: string | null };
};

export type MeetingTranscriptUnit = {
  block_key: string;
  kind: string;
  text: string;
  started_at: string | null;
  ended_at: string | null;
};

export type MeetingTranscriptPage = {
  schema_version: "mkc.meeting-transcript-page.v1";
  source_key: string;
  transcript_sha256: string;
  correction_key: string | null;
  total_units: number;
  units: MeetingTranscriptUnit[];
  page: { size: number; has_more: boolean; next_cursor: string | null };
};

export type MeetingDetailResponse = {
  schema_version: "mkc.meeting-detail.v1";
  source_key: string;
  title: string;
  occurred_at: string;
  ingested_at: string;
  readiness: MeetingReadiness;
  duration_seconds: number | null;
  provenance: {
    kind: "maina_app";
    platform: "android" | "ios" | null;
    captured_at: string | null;
    client_schema_version: string | null;
  };
  workspace: Record<string, unknown>;
  project: Record<string, unknown>;
  topics: Array<Record<string, unknown>>;
  summary: string | null;
  decisions: string[];
  todos: string[];
  open_questions: string[];
  important_points: string[];
  transcript: {
    blocks: Array<MeetingTranscriptUnit & { metadata?: Record<string, unknown> }>;
    correction: { correction_key: string; body: string; occurred_at: string } | null;
    continuation: {
      schema_version: "mkc.meeting-transcript-page.v1";
      total_units: number;
      transcript_sha256: string;
      url: string;
    };
  };
  corrections: Array<Record<string, unknown>>;
  current_field_versions: Array<Record<string, unknown>>;
  correction_targets_url: string;
};

export type FrozenRecallSourceResponse = {
  schema_version: "mkc.frozen-recall-source.v1";
  search_id: string;
  result_sha256: string;
  bundle_sha256: string;
  expires_at: string;
  coverage: RecallCoverageReceiptV1;
  source: FrozenRecallSource;
};
