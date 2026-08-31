/* eslint-disable @typescript-eslint/array-type */
// Generated from Maina Knowledge Cloud b879876506aaf7a18f4c2d26b9c5442629f68190. Do not edit by hand.
// Run: npm run import:mkc-memory-contracts

export type MkcMemoryContractSchema = Record<string, unknown>;

export type MemoryPulseV1 = {
  schema_version: "mkc.memory-pulse.v1";
  observed_at: string;
  timezone: string;
  window: {
    since: string;
    basis: "last_visit" | "default_7_days";
    today_start: string;
    next_seven_days_exclusive: string;
  };
  recent: {
    meetings: Array<{
        source_key: string;
        title: string;
        source_type: string;
        occurred_at: string;
        ingested_at: string;
        summary_text: string | null;
        workspace_key: string;
        project_key: string;
      }>;
    documents: Array<{
        source_key: string;
        title: string;
        source_type: string;
        occurred_at: string;
        ingested_at: string;
        summary_text: string | null;
        workspace_key: string;
        project_key: string;
      }>;
    decisions: Array<{
        identity_key: string;
        source_key: string;
        source_title: string;
        source_type: string;
        occurred_at: string;
        fact_type: "decision" | "action" | "question" | "claim" | "important_point";
        text: string;
        owner_text: string | null;
        deadline_text: string | null;
        deadline_at: string | null;
        status: "open" | "completed" | "cancelled" | null;
        confidence: number;
        field_path: string;
        fact_created_at: string;
      }>;
    open_questions: Array<{
        identity_key: string;
        source_key: string;
        source_title: string;
        source_type: string;
        occurred_at: string;
        fact_type: "decision" | "action" | "question" | "claim" | "important_point";
        text: string;
        owner_text: string | null;
        deadline_text: string | null;
        deadline_at: string | null;
        status: "open" | "completed" | "cancelled" | null;
        confidence: number;
        field_path: string;
        fact_created_at: string;
      }>;
    changed_decisions: Array<{
        source_key: string;
        source_title: string;
        occurred_at: string;
        correction_key: string;
        body: string;
        previous_correction_key: string;
        previous_body: string | null;
        corrected_at: string;
      }>;
  };
  commitments: {
    known_open_count: number;
    returned_open_count: number;
    open_actions_truncated: boolean;
    overdue_count: number;
    due_next_seven_days_count: number;
    without_owner_count: number;
    without_deadline_count: number;
    overdue: Array<{
        identity_key: string;
        source_key: string;
        source_title: string;
        occurred_at: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        deadline_at: string | null;
        status: "open" | "completed" | "cancelled" | null;
        confidence: number;
      }>;
    due_next_seven_days: Array<{
        identity_key: string;
        source_key: string;
        source_title: string;
        occurred_at: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        deadline_at: string | null;
        status: "open" | "completed" | "cancelled" | null;
        confidence: number;
      }>;
    without_owner: Array<{
        identity_key: string;
        source_key: string;
        source_title: string;
        occurred_at: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        deadline_at: string | null;
        status: "open" | "completed" | "cancelled" | null;
        confidence: number;
      }>;
    without_deadline: Array<{
        identity_key: string;
        source_key: string;
        source_title: string;
        occurred_at: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        deadline_at: string | null;
        status: "open" | "completed" | "cancelled" | null;
        confidence: number;
      }>;
    recently_closed: Array<{
        identity_key: string;
        source_key: string;
        source_title: string;
        source_type: string;
        occurred_at: string;
        fact_type: "decision" | "action" | "question" | "claim" | "important_point";
        text: string;
        owner_text: string | null;
        deadline_text: string | null;
        deadline_at: string | null;
        status: "open" | "completed" | "cancelled" | null;
        confidence: number;
        field_path: string;
        fact_created_at: string;
      }>;
    coverage: {
      indexed_action_count: number;
      indexed_action_with_owner_count: number;
      indexed_deadline_text_count: number;
      normalized_deadline_count: number;
      warnings: Array<string>;
    };
  };
  learning: {
    recent_sources: Array<{
        source_key: string;
        title: string;
        source_type: string;
        occurred_at: string;
        ingested_at: string;
        summary_text: string | null;
        workspace_key: string;
        project_key: string;
      }>;
    open_questions: Array<{
        identity_key: string;
        source_key: string;
        source_title: string;
        source_type: string;
        occurred_at: string;
        fact_type: "decision" | "action" | "question" | "claim" | "important_point";
        text: string;
        owner_text: string | null;
        deadline_text: string | null;
        deadline_at: string | null;
        status: "open" | "completed" | "cancelled" | null;
        confidence: number;
        field_path: string;
        fact_created_at: string;
      }>;
  };
  attention: {
    intake_files: Array<{
        job_id: string;
        job_status: "awaiting_upload" | "staged";
        principal_label: string;
        workspace_key: string;
        workspace_name: string;
        project_key: string;
        project_name: string;
        file_id: string;
        client_file_id: string | null;
        file_name: string;
        content_type: string;
        declared_size_bytes: number;
        uploaded_size_bytes: number | null;
        upload_status: "pending" | "uploaded";
        uploaded_at: string | null;
        promotion_state: string;
        promotion_path: string | null;
        conversion_format: string | null;
        conversion_tokens: number | null;
        conversion_attempt_count: number;
        conversion_enqueued_at: string | null;
        conversion_started_at: string | null;
        conversion_finished_at: string | null;
        conversion_error_code: string | null;
        conversion_error_message: string | null;
        promoted_source_key: string | null;
      }>;
    semantic_sources: Array<{
        source_key: string;
        title: string;
        occurred_at: string;
        semantic_status: string;
        vector_state: string | null;
        error_code: string | null;
      }>;
  };
  quick_recalls: Array<{
      key: string;
      label: string;
      query: string;
    }>;
};

export type MemoryPulseViewedV1 = {
  viewed_at: string;
};

export type SmartRecallListV1 = {
  schema_version: "mkc.smart-recall-list.v1";
  smart_recalls: Array<{
      id: string;
      name: string;
      original_query: string;
      explicit_filters: {
        workspace_keys?: Array<string>;
        project_keys?: Array<string>;
        topic_keys?: Array<string>;
        source_families?: Array<"all" | "meetings" | "documents" | "notes" | "email">;
        source_types?: Array<string>;
        occurred_date_from?: string;
        occurred_date_to?: string;
      };
      requested_mode: "auto" | "sources" | "passages" | "facts" | "bundle" | null;
      requested_coverage: "auto" | "top_matches" | "all_filtered" | null;
      requested_sort: "relevance" | "newest" | "oldest" | null;
      last_plan_version: string | null;
      last_search_id: string | null;
      last_result_sha256: string | null;
      last_bundle_sha256: string | null;
      last_corpus_watermark: string | null;
      last_delta: {
        schema_version: "mkc.smart-recall-delta.v1";
        comparable_to_previous: boolean;
        comparability_reason: "first_run" | "planner_version_changed" | "scope_or_coverage_changed" | null;
        knowledge_changed: boolean;
        baseline: {
          sources: number;
          facts: number;
          corrections: number;
        };
        new_sources: Array<{
            source_key: string;
            canonical_sha256: string;
            deleted_at: string | null;
          }>;
        removed_sources: Array<{
            source_key: string;
            canonical_sha256: string;
            deleted_at: string | null;
          }>;
        revised_sources: Array<{
            before: {
              source_key: string;
              canonical_sha256: string;
              deleted_at: string | null;
            };
            after: {
              source_key: string;
              canonical_sha256: string;
              deleted_at: string | null;
            };
          }>;
        new_facts: Array<{
            identity: string;
            source_key: string;
            fact_type: string;
            text: string;
            owner: string | null;
            deadline: string | null;
            status: string | null;
            field_path: string;
          }>;
        removed_facts: Array<{
            identity: string;
            source_key: string;
            fact_type: string;
            text: string;
            owner: string | null;
            deadline: string | null;
            status: string | null;
            field_path: string;
          }>;
        changed_decisions: Array<{
            identity: string;
            source_key: string;
            fact_type: string;
            text: string;
            owner: string | null;
            deadline: string | null;
            status: string | null;
            field_path: string;
          }>;
        actions_opened: Array<{
            identity: string;
            source_key: string;
            fact_type: string;
            text: string;
            owner: string | null;
            deadline: string | null;
            status: string | null;
            field_path: string;
          }>;
        actions_completed: Array<{
            identity: string;
            source_key: string;
            fact_type: string;
            text: string;
            owner: string | null;
            deadline: string | null;
            status: string | null;
            field_path: string;
          }>;
        actions_cancelled: Array<{
            identity: string;
            source_key: string;
            fact_type: string;
            text: string;
            owner: string | null;
            deadline: string | null;
            status: string | null;
            field_path: string;
          }>;
        new_questions: Array<{
            identity: string;
            source_key: string;
            fact_type: string;
            text: string;
            owner: string | null;
            deadline: string | null;
            status: string | null;
            field_path: string;
          }>;
        new_corrections: Array<{
            identity: string;
            source_key: string;
            correction_key: string;
            canonical_sha256: string;
            field_path: string;
            supersedes_correction_key: string | null;
          }>;
      } | null;
      last_viewed_at: string | null;
      created_at: string;
      updated_at: string;
    }>;
};

export type SmartRecallDefinitionV1 = {
  id: string;
  name: string;
  original_query: string;
  explicit_filters: {
    workspace_keys?: Array<string>;
    project_keys?: Array<string>;
    topic_keys?: Array<string>;
    source_families?: Array<"all" | "meetings" | "documents" | "notes" | "email">;
    source_types?: Array<string>;
    occurred_date_from?: string;
    occurred_date_to?: string;
  };
  requested_mode: "auto" | "sources" | "passages" | "facts" | "bundle" | null;
  requested_coverage: "auto" | "top_matches" | "all_filtered" | null;
  requested_sort: "relevance" | "newest" | "oldest" | null;
  last_plan_version: string | null;
  last_search_id: string | null;
  last_result_sha256: string | null;
  last_bundle_sha256: string | null;
  last_corpus_watermark: string | null;
  last_delta: {
    schema_version: "mkc.smart-recall-delta.v1";
    comparable_to_previous: boolean;
    comparability_reason: "first_run" | "planner_version_changed" | "scope_or_coverage_changed" | null;
    knowledge_changed: boolean;
    baseline: {
      sources: number;
      facts: number;
      corrections: number;
    };
    new_sources: Array<{
        source_key: string;
        canonical_sha256: string;
        deleted_at: string | null;
      }>;
    removed_sources: Array<{
        source_key: string;
        canonical_sha256: string;
        deleted_at: string | null;
      }>;
    revised_sources: Array<{
        before: {
          source_key: string;
          canonical_sha256: string;
          deleted_at: string | null;
        };
        after: {
          source_key: string;
          canonical_sha256: string;
          deleted_at: string | null;
        };
      }>;
    new_facts: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    removed_facts: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    changed_decisions: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    actions_opened: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    actions_completed: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    actions_cancelled: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    new_questions: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    new_corrections: Array<{
        identity: string;
        source_key: string;
        correction_key: string;
        canonical_sha256: string;
        field_path: string;
        supersedes_correction_key: string | null;
      }>;
  } | null;
  last_viewed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SmartRecallRunV1 = {
  schema_version: "mkc.smart-recall-run.v1";
  smart_recall: {
    id: string;
    name: string;
    original_query: string;
    explicit_filters: {
      workspace_keys?: Array<string>;
      project_keys?: Array<string>;
      topic_keys?: Array<string>;
      source_families?: Array<"all" | "meetings" | "documents" | "notes" | "email">;
      source_types?: Array<string>;
      occurred_date_from?: string;
      occurred_date_to?: string;
    };
    requested_mode: "auto" | "sources" | "passages" | "facts" | "bundle" | null;
    requested_coverage: "auto" | "top_matches" | "all_filtered" | null;
    requested_sort: "relevance" | "newest" | "oldest" | null;
    last_plan_version: string | null;
    last_search_id: string | null;
    last_result_sha256: string | null;
    last_bundle_sha256: string | null;
    last_corpus_watermark: string | null;
    last_delta: {
      schema_version: "mkc.smart-recall-delta.v1";
      comparable_to_previous: boolean;
      comparability_reason: "first_run" | "planner_version_changed" | "scope_or_coverage_changed" | null;
      knowledge_changed: boolean;
      baseline: {
        sources: number;
        facts: number;
        corrections: number;
      };
      new_sources: Array<{
          source_key: string;
          canonical_sha256: string;
          deleted_at: string | null;
        }>;
      removed_sources: Array<{
          source_key: string;
          canonical_sha256: string;
          deleted_at: string | null;
        }>;
      revised_sources: Array<{
          before: {
            source_key: string;
            canonical_sha256: string;
            deleted_at: string | null;
          };
          after: {
            source_key: string;
            canonical_sha256: string;
            deleted_at: string | null;
          };
        }>;
      new_facts: Array<{
          identity: string;
          source_key: string;
          fact_type: string;
          text: string;
          owner: string | null;
          deadline: string | null;
          status: string | null;
          field_path: string;
        }>;
      removed_facts: Array<{
          identity: string;
          source_key: string;
          fact_type: string;
          text: string;
          owner: string | null;
          deadline: string | null;
          status: string | null;
          field_path: string;
        }>;
      changed_decisions: Array<{
          identity: string;
          source_key: string;
          fact_type: string;
          text: string;
          owner: string | null;
          deadline: string | null;
          status: string | null;
          field_path: string;
        }>;
      actions_opened: Array<{
          identity: string;
          source_key: string;
          fact_type: string;
          text: string;
          owner: string | null;
          deadline: string | null;
          status: string | null;
          field_path: string;
        }>;
      actions_completed: Array<{
          identity: string;
          source_key: string;
          fact_type: string;
          text: string;
          owner: string | null;
          deadline: string | null;
          status: string | null;
          field_path: string;
        }>;
      actions_cancelled: Array<{
          identity: string;
          source_key: string;
          fact_type: string;
          text: string;
          owner: string | null;
          deadline: string | null;
          status: string | null;
          field_path: string;
        }>;
      new_questions: Array<{
          identity: string;
          source_key: string;
          fact_type: string;
          text: string;
          owner: string | null;
          deadline: string | null;
          status: string | null;
          field_path: string;
        }>;
      new_corrections: Array<{
          identity: string;
          source_key: string;
          correction_key: string;
          canonical_sha256: string;
          field_path: string;
          supersedes_correction_key: string | null;
        }>;
    } | null;
    last_viewed_at: string | null;
    created_at: string;
    updated_at: string;
  };
  run: {
    id: string;
    search_id: string;
    created_at: string;
    result_sha256: string;
    bundle_sha256: string;
    planner_version: string;
    resolved_window: {
      occurred_from: string | null;
      occurred_to_exclusive: string | null;
      deadline_from: string | null;
      deadline_to_exclusive: string | null;
    };
    coverage: {
      schema_version: "mkc.coverage-receipt.v1";
      mode: "top_matches" | "all_filtered";
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
      complete: boolean;
      truncated: boolean;
      continuation_available: boolean;
      exclusions: Array<string>;
      warnings: Array<string>;
    };
  };
  delta: {
    schema_version: "mkc.smart-recall-delta.v1";
    comparable_to_previous: boolean;
    comparability_reason: "first_run" | "planner_version_changed" | "scope_or_coverage_changed" | null;
    knowledge_changed: boolean;
    baseline: {
      sources: number;
      facts: number;
      corrections: number;
    };
    new_sources: Array<{
        source_key: string;
        canonical_sha256: string;
        deleted_at: string | null;
      }>;
    removed_sources: Array<{
        source_key: string;
        canonical_sha256: string;
        deleted_at: string | null;
      }>;
    revised_sources: Array<{
        before: {
          source_key: string;
          canonical_sha256: string;
          deleted_at: string | null;
        };
        after: {
          source_key: string;
          canonical_sha256: string;
          deleted_at: string | null;
        };
      }>;
    new_facts: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    removed_facts: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    changed_decisions: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    actions_opened: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    actions_completed: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    actions_cancelled: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    new_questions: Array<{
        identity: string;
        source_key: string;
        fact_type: string;
        text: string;
        owner: string | null;
        deadline: string | null;
        status: string | null;
        field_path: string;
      }>;
    new_corrections: Array<{
        identity: string;
        source_key: string;
        correction_key: string;
        canonical_sha256: string;
        field_path: string;
        supersedes_correction_key: string | null;
      }>;
  };
  frozen_recall: {
    schema_version: "mkc.frozen-recall-open.v1";
    search_id: string;
    created_at: string;
    expires_at: string;
    result_sha256: string;
    bundle_sha256: string;
    plan: {
      schema_version: "mkc.query-plan.v2";
      original_query: string;
      planner_version: string;
      planner_source: "deterministic" | "provider_guarded" | "provider_fallback";
      user_job: "locate" | "collect" | "typed_memory" | "browse_history" | "research" | "answer";
      execution_strategy: "deterministic_list" | "typed_fact_lookup" | "focused_answer" | "research_bundle";
      result_mode: "sources" | "passages" | "facts" | "bundle";
      coverage_mode: "top_matches" | "all_filtered";
      scope_strategy?: "ranked" | "full_if_within_budget";
      sort: "relevance" | "newest" | "oldest";
      timezone: string;
      date_basis: "source_occurred_at" | "fact_deadline" | "source_and_fact";
      occurred_from: string | null;
      occurred_to_exclusive: string | null;
      deadline_from?: string | null;
      deadline_to_exclusive?: string | null;
      explicit_constraints: Array<{
          kind: "workspace" | "project" | "topic" | "source_family" | "source_type" | "date" | "deadline" | "fact_type";
          value: string;
          source: "explicit" | "inferred" | "inherited" | "default";
          removable: boolean;
        }>;
      inferred_constraints: Array<{
          kind: "workspace" | "project" | "topic" | "source_family" | "source_type" | "date" | "deadline" | "fact_type";
          value: string;
          source: "explicit" | "inferred" | "inherited" | "default";
          removable: boolean;
        }>;
      exact_literals: Array<string>;
      exact_identifiers: Array<string>;
      aliases: Array<{
          original: string;
          expanded: string;
          kind: "alias" | "typo" | "transliteration";
          source: "deterministic" | "registry" | "provider";
          confidence: number;
        }>;
      typo_candidates: Array<{
          original: string;
          expanded: string;
          kind: "alias" | "typo" | "transliteration";
          source: "deterministic" | "registry" | "provider";
          confidence: number;
        }>;
      topical_query: string;
      supporting_queries: Array<string>;
      source_families: Array<"all" | "meetings" | "documents" | "notes" | "email">;
      source_types: Array<string>;
      fact_types: Array<"decision" | "action" | "question" | "claim" | "important_point">;
      fact_owners?: Array<string>;
      fact_statuses?: Array<"open" | "completed" | "cancelled">;
      requested_count: number | null;
      intent: "decision" | "task" | "question" | "timeline" | "general";
      presentation_job?: "default" | "chronology" | "list" | "comparison";
      presentation_instructions?: Array<string>;
    };
    coverage: {
      schema_version: "mkc.coverage-receipt.v1";
      mode: "top_matches" | "all_filtered";
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
      complete: boolean;
      truncated: boolean;
      continuation_available: boolean;
      exclusions: Array<string>;
      warnings: Array<string>;
    };
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
  handoff: {
    mode: "prepare_for_meeting";
    instruction: string;
    search_id: string;
    result_sha256: string;
    bundle_sha256: string;
    expires_at: string;
  } | null;
};

export const MKC_MEMORY_CONTRACT_SCHEMAS: Readonly<Record<"memoryPulse" | "memoryPulseViewed" | "smartRecallList" | "smartRecallDetail" | "smartRecallRun", MkcMemoryContractSchema>> = {
  "memoryPulse": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "schema_version": {
        "type": "string",
        "const": "mkc.memory-pulse.v1"
      },
      "observed_at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
      },
      "timezone": {
        "type": "string"
      },
      "window": {
        "type": "object",
        "properties": {
          "since": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
          },
          "basis": {
            "type": "string",
            "enum": [
              "last_visit",
              "default_7_days"
            ]
          },
          "today_start": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
          },
          "next_seven_days_exclusive": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
          }
        },
        "required": [
          "since",
          "basis",
          "today_start",
          "next_seven_days_exclusive"
        ],
        "additionalProperties": false
      },
      "recent": {
        "type": "object",
        "properties": {
          "meetings": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "source_key": {
                  "type": "string"
                },
                "title": {
                  "type": "string"
                },
                "source_type": {
                  "type": "string"
                },
                "occurred_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "ingested_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "summary_text": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "workspace_key": {
                  "type": "string"
                },
                "project_key": {
                  "type": "string"
                }
              },
              "required": [
                "source_key",
                "title",
                "source_type",
                "occurred_at",
                "ingested_at",
                "summary_text",
                "workspace_key",
                "project_key"
              ],
              "additionalProperties": false
            }
          },
          "documents": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "source_key": {
                  "type": "string"
                },
                "title": {
                  "type": "string"
                },
                "source_type": {
                  "type": "string"
                },
                "occurred_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "ingested_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "summary_text": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "workspace_key": {
                  "type": "string"
                },
                "project_key": {
                  "type": "string"
                }
              },
              "required": [
                "source_key",
                "title",
                "source_type",
                "occurred_at",
                "ingested_at",
                "summary_text",
                "workspace_key",
                "project_key"
              ],
              "additionalProperties": false
            }
          },
          "decisions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity_key": {
                  "type": "string"
                },
                "source_key": {
                  "type": "string"
                },
                "source_title": {
                  "type": "string"
                },
                "source_type": {
                  "type": "string"
                },
                "occurred_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "fact_type": {
                  "type": "string",
                  "enum": [
                    "decision",
                    "action",
                    "question",
                    "claim",
                    "important_point"
                  ]
                },
                "text": {
                  "type": "string"
                },
                "owner_text": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline_text": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string",
                      "enum": [
                        "open",
                        "completed",
                        "cancelled"
                      ]
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "confidence": {
                  "type": "number"
                },
                "field_path": {
                  "type": "string"
                },
                "fact_created_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                }
              },
              "required": [
                "identity_key",
                "source_key",
                "source_title",
                "source_type",
                "occurred_at",
                "fact_type",
                "text",
                "owner_text",
                "deadline_text",
                "deadline_at",
                "status",
                "confidence",
                "field_path",
                "fact_created_at"
              ],
              "additionalProperties": false
            }
          },
          "open_questions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity_key": {
                  "type": "string"
                },
                "source_key": {
                  "type": "string"
                },
                "source_title": {
                  "type": "string"
                },
                "source_type": {
                  "type": "string"
                },
                "occurred_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "fact_type": {
                  "type": "string",
                  "enum": [
                    "decision",
                    "action",
                    "question",
                    "claim",
                    "important_point"
                  ]
                },
                "text": {
                  "type": "string"
                },
                "owner_text": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline_text": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string",
                      "enum": [
                        "open",
                        "completed",
                        "cancelled"
                      ]
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "confidence": {
                  "type": "number"
                },
                "field_path": {
                  "type": "string"
                },
                "fact_created_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                }
              },
              "required": [
                "identity_key",
                "source_key",
                "source_title",
                "source_type",
                "occurred_at",
                "fact_type",
                "text",
                "owner_text",
                "deadline_text",
                "deadline_at",
                "status",
                "confidence",
                "field_path",
                "fact_created_at"
              ],
              "additionalProperties": false
            }
          },
          "changed_decisions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "source_key": {
                  "type": "string"
                },
                "source_title": {
                  "type": "string"
                },
                "occurred_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "correction_key": {
                  "type": "string"
                },
                "body": {
                  "type": "string"
                },
                "previous_correction_key": {
                  "type": "string"
                },
                "previous_body": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "corrected_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                }
              },
              "required": [
                "source_key",
                "source_title",
                "occurred_at",
                "correction_key",
                "body",
                "previous_correction_key",
                "previous_body",
                "corrected_at"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "meetings",
          "documents",
          "decisions",
          "open_questions",
          "changed_decisions"
        ],
        "additionalProperties": false
      },
      "commitments": {
        "type": "object",
        "properties": {
          "known_open_count": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "returned_open_count": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "open_actions_truncated": {
            "type": "boolean"
          },
          "overdue_count": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "due_next_seven_days_count": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "without_owner_count": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "without_deadline_count": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "overdue": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity_key": {
                  "type": "string"
                },
                "source_key": {
                  "type": "string"
                },
                "source_title": {
                  "type": "string"
                },
                "occurred_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "text": {
                  "type": "string"
                },
                "owner": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string",
                      "enum": [
                        "open",
                        "completed",
                        "cancelled"
                      ]
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "confidence": {
                  "type": "number"
                }
              },
              "required": [
                "identity_key",
                "source_key",
                "source_title",
                "occurred_at",
                "text",
                "owner",
                "deadline",
                "deadline_at",
                "status",
                "confidence"
              ],
              "additionalProperties": false
            }
          },
          "due_next_seven_days": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity_key": {
                  "type": "string"
                },
                "source_key": {
                  "type": "string"
                },
                "source_title": {
                  "type": "string"
                },
                "occurred_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "text": {
                  "type": "string"
                },
                "owner": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string",
                      "enum": [
                        "open",
                        "completed",
                        "cancelled"
                      ]
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "confidence": {
                  "type": "number"
                }
              },
              "required": [
                "identity_key",
                "source_key",
                "source_title",
                "occurred_at",
                "text",
                "owner",
                "deadline",
                "deadline_at",
                "status",
                "confidence"
              ],
              "additionalProperties": false
            }
          },
          "without_owner": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity_key": {
                  "type": "string"
                },
                "source_key": {
                  "type": "string"
                },
                "source_title": {
                  "type": "string"
                },
                "occurred_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "text": {
                  "type": "string"
                },
                "owner": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string",
                      "enum": [
                        "open",
                        "completed",
                        "cancelled"
                      ]
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "confidence": {
                  "type": "number"
                }
              },
              "required": [
                "identity_key",
                "source_key",
                "source_title",
                "occurred_at",
                "text",
                "owner",
                "deadline",
                "deadline_at",
                "status",
                "confidence"
              ],
              "additionalProperties": false
            }
          },
          "without_deadline": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity_key": {
                  "type": "string"
                },
                "source_key": {
                  "type": "string"
                },
                "source_title": {
                  "type": "string"
                },
                "occurred_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "text": {
                  "type": "string"
                },
                "owner": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string",
                      "enum": [
                        "open",
                        "completed",
                        "cancelled"
                      ]
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "confidence": {
                  "type": "number"
                }
              },
              "required": [
                "identity_key",
                "source_key",
                "source_title",
                "occurred_at",
                "text",
                "owner",
                "deadline",
                "deadline_at",
                "status",
                "confidence"
              ],
              "additionalProperties": false
            }
          },
          "recently_closed": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity_key": {
                  "type": "string"
                },
                "source_key": {
                  "type": "string"
                },
                "source_title": {
                  "type": "string"
                },
                "source_type": {
                  "type": "string"
                },
                "occurred_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "fact_type": {
                  "type": "string",
                  "enum": [
                    "decision",
                    "action",
                    "question",
                    "claim",
                    "important_point"
                  ]
                },
                "text": {
                  "type": "string"
                },
                "owner_text": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline_text": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string",
                      "enum": [
                        "open",
                        "completed",
                        "cancelled"
                      ]
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "confidence": {
                  "type": "number"
                },
                "field_path": {
                  "type": "string"
                },
                "fact_created_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                }
              },
              "required": [
                "identity_key",
                "source_key",
                "source_title",
                "source_type",
                "occurred_at",
                "fact_type",
                "text",
                "owner_text",
                "deadline_text",
                "deadline_at",
                "status",
                "confidence",
                "field_path",
                "fact_created_at"
              ],
              "additionalProperties": false
            }
          },
          "coverage": {
            "type": "object",
            "properties": {
              "indexed_action_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "indexed_action_with_owner_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "indexed_deadline_text_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "normalized_deadline_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "warnings": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "required": [
              "indexed_action_count",
              "indexed_action_with_owner_count",
              "indexed_deadline_text_count",
              "normalized_deadline_count",
              "warnings"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "known_open_count",
          "returned_open_count",
          "open_actions_truncated",
          "overdue_count",
          "due_next_seven_days_count",
          "without_owner_count",
          "without_deadline_count",
          "overdue",
          "due_next_seven_days",
          "without_owner",
          "without_deadline",
          "recently_closed",
          "coverage"
        ],
        "additionalProperties": false
      },
      "learning": {
        "type": "object",
        "properties": {
          "recent_sources": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "source_key": {
                  "type": "string"
                },
                "title": {
                  "type": "string"
                },
                "source_type": {
                  "type": "string"
                },
                "occurred_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "ingested_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "summary_text": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "workspace_key": {
                  "type": "string"
                },
                "project_key": {
                  "type": "string"
                }
              },
              "required": [
                "source_key",
                "title",
                "source_type",
                "occurred_at",
                "ingested_at",
                "summary_text",
                "workspace_key",
                "project_key"
              ],
              "additionalProperties": false
            }
          },
          "open_questions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity_key": {
                  "type": "string"
                },
                "source_key": {
                  "type": "string"
                },
                "source_title": {
                  "type": "string"
                },
                "source_type": {
                  "type": "string"
                },
                "occurred_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "fact_type": {
                  "type": "string",
                  "enum": [
                    "decision",
                    "action",
                    "question",
                    "claim",
                    "important_point"
                  ]
                },
                "text": {
                  "type": "string"
                },
                "owner_text": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline_text": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string",
                      "enum": [
                        "open",
                        "completed",
                        "cancelled"
                      ]
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "confidence": {
                  "type": "number"
                },
                "field_path": {
                  "type": "string"
                },
                "fact_created_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                }
              },
              "required": [
                "identity_key",
                "source_key",
                "source_title",
                "source_type",
                "occurred_at",
                "fact_type",
                "text",
                "owner_text",
                "deadline_text",
                "deadline_at",
                "status",
                "confidence",
                "field_path",
                "fact_created_at"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "recent_sources",
          "open_questions"
        ],
        "additionalProperties": false
      },
      "attention": {
        "type": "object",
        "properties": {
          "intake_files": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "job_id": {
                  "type": "string"
                },
                "job_status": {
                  "type": "string",
                  "enum": [
                    "awaiting_upload",
                    "staged"
                  ]
                },
                "principal_label": {
                  "type": "string"
                },
                "workspace_key": {
                  "type": "string"
                },
                "workspace_name": {
                  "type": "string"
                },
                "project_key": {
                  "type": "string"
                },
                "project_name": {
                  "type": "string"
                },
                "file_id": {
                  "type": "string"
                },
                "client_file_id": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "file_name": {
                  "type": "string"
                },
                "content_type": {
                  "type": "string"
                },
                "declared_size_bytes": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "uploaded_size_bytes": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "upload_status": {
                  "type": "string",
                  "enum": [
                    "pending",
                    "uploaded"
                  ]
                },
                "uploaded_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "promotion_state": {
                  "type": "string"
                },
                "promotion_path": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "conversion_format": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "conversion_tokens": {
                  "anyOf": [
                    {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "conversion_attempt_count": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "conversion_enqueued_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "conversion_started_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "conversion_finished_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "conversion_error_code": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "conversion_error_message": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "promoted_source_key": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "job_id",
                "job_status",
                "principal_label",
                "workspace_key",
                "workspace_name",
                "project_key",
                "project_name",
                "file_id",
                "client_file_id",
                "file_name",
                "content_type",
                "declared_size_bytes",
                "uploaded_size_bytes",
                "upload_status",
                "uploaded_at",
                "promotion_state",
                "promotion_path",
                "conversion_format",
                "conversion_tokens",
                "conversion_attempt_count",
                "conversion_enqueued_at",
                "conversion_started_at",
                "conversion_finished_at",
                "conversion_error_code",
                "conversion_error_message",
                "promoted_source_key"
              ],
              "additionalProperties": false
            }
          },
          "semantic_sources": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "source_key": {
                  "type": "string"
                },
                "title": {
                  "type": "string"
                },
                "occurred_at": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                "semantic_status": {
                  "type": "string"
                },
                "vector_state": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "error_code": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "source_key",
                "title",
                "occurred_at",
                "semantic_status",
                "vector_state",
                "error_code"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "intake_files",
          "semantic_sources"
        ],
        "additionalProperties": false
      },
      "quick_recalls": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "key": {
              "type": "string"
            },
            "label": {
              "type": "string"
            },
            "query": {
              "type": "string"
            }
          },
          "required": [
            "key",
            "label",
            "query"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": [
      "schema_version",
      "observed_at",
      "timezone",
      "window",
      "recent",
      "commitments",
      "learning",
      "attention",
      "quick_recalls"
    ],
    "additionalProperties": false
  },
  "memoryPulseViewed": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "viewed_at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
      }
    },
    "required": [
      "viewed_at"
    ],
    "additionalProperties": false
  },
  "smartRecallList": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "schema_version": {
        "type": "string",
        "const": "mkc.smart-recall-list.v1"
      },
      "smart_recalls": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "original_query": {
              "type": "string"
            },
            "explicit_filters": {
              "type": "object",
              "properties": {
                "workspace_keys": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "project_keys": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "topic_keys": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "source_families": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "enum": [
                      "all",
                      "meetings",
                      "documents",
                      "notes",
                      "email"
                    ]
                  }
                },
                "source_types": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "occurred_date_from": {
                  "type": "string",
                  "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                },
                "occurred_date_to": {
                  "type": "string",
                  "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                }
              },
              "additionalProperties": false
            },
            "requested_mode": {
              "anyOf": [
                {
                  "type": "string",
                  "enum": [
                    "auto",
                    "sources",
                    "passages",
                    "facts",
                    "bundle"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "requested_coverage": {
              "anyOf": [
                {
                  "type": "string",
                  "enum": [
                    "auto",
                    "top_matches",
                    "all_filtered"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "requested_sort": {
              "anyOf": [
                {
                  "type": "string",
                  "enum": [
                    "relevance",
                    "newest",
                    "oldest"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "last_plan_version": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "last_search_id": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "last_result_sha256": {
              "anyOf": [
                {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "last_bundle_sha256": {
              "anyOf": [
                {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "last_corpus_watermark": {
              "anyOf": [
                {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "last_delta": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "schema_version": {
                      "type": "string",
                      "const": "mkc.smart-recall-delta.v1"
                    },
                    "comparable_to_previous": {
                      "type": "boolean"
                    },
                    "comparability_reason": {
                      "anyOf": [
                        {
                          "type": "string",
                          "enum": [
                            "first_run",
                            "planner_version_changed",
                            "scope_or_coverage_changed"
                          ]
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "knowledge_changed": {
                      "type": "boolean"
                    },
                    "baseline": {
                      "type": "object",
                      "properties": {
                        "sources": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "facts": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "corrections": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        }
                      },
                      "required": [
                        "sources",
                        "facts",
                        "corrections"
                      ],
                      "additionalProperties": false
                    },
                    "new_sources": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "source_key": {
                            "type": "string"
                          },
                          "canonical_sha256": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          },
                          "deleted_at": {
                            "anyOf": [
                              {
                                "type": "string",
                                "format": "date-time",
                                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          }
                        },
                        "required": [
                          "source_key",
                          "canonical_sha256",
                          "deleted_at"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "removed_sources": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "source_key": {
                            "type": "string"
                          },
                          "canonical_sha256": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          },
                          "deleted_at": {
                            "anyOf": [
                              {
                                "type": "string",
                                "format": "date-time",
                                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          }
                        },
                        "required": [
                          "source_key",
                          "canonical_sha256",
                          "deleted_at"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "revised_sources": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "before": {
                            "type": "object",
                            "properties": {
                              "source_key": {
                                "type": "string"
                              },
                              "canonical_sha256": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                              },
                              "deleted_at": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "format": "date-time",
                                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              }
                            },
                            "required": [
                              "source_key",
                              "canonical_sha256",
                              "deleted_at"
                            ],
                            "additionalProperties": false
                          },
                          "after": {
                            "type": "object",
                            "properties": {
                              "source_key": {
                                "type": "string"
                              },
                              "canonical_sha256": {
                                "type": "string",
                                "pattern": "^[a-f0-9]{64}$"
                              },
                              "deleted_at": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "format": "date-time",
                                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              }
                            },
                            "required": [
                              "source_key",
                              "canonical_sha256",
                              "deleted_at"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "required": [
                          "before",
                          "after"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "new_facts": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "identity": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          },
                          "source_key": {
                            "type": "string"
                          },
                          "fact_type": {
                            "type": "string"
                          },
                          "text": {
                            "type": "string"
                          },
                          "owner": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "deadline": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "status": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "field_path": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "identity",
                          "source_key",
                          "fact_type",
                          "text",
                          "owner",
                          "deadline",
                          "status",
                          "field_path"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "removed_facts": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "identity": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          },
                          "source_key": {
                            "type": "string"
                          },
                          "fact_type": {
                            "type": "string"
                          },
                          "text": {
                            "type": "string"
                          },
                          "owner": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "deadline": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "status": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "field_path": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "identity",
                          "source_key",
                          "fact_type",
                          "text",
                          "owner",
                          "deadline",
                          "status",
                          "field_path"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "changed_decisions": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "identity": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          },
                          "source_key": {
                            "type": "string"
                          },
                          "fact_type": {
                            "type": "string"
                          },
                          "text": {
                            "type": "string"
                          },
                          "owner": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "deadline": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "status": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "field_path": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "identity",
                          "source_key",
                          "fact_type",
                          "text",
                          "owner",
                          "deadline",
                          "status",
                          "field_path"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "actions_opened": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "identity": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          },
                          "source_key": {
                            "type": "string"
                          },
                          "fact_type": {
                            "type": "string"
                          },
                          "text": {
                            "type": "string"
                          },
                          "owner": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "deadline": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "status": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "field_path": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "identity",
                          "source_key",
                          "fact_type",
                          "text",
                          "owner",
                          "deadline",
                          "status",
                          "field_path"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "actions_completed": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "identity": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          },
                          "source_key": {
                            "type": "string"
                          },
                          "fact_type": {
                            "type": "string"
                          },
                          "text": {
                            "type": "string"
                          },
                          "owner": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "deadline": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "status": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "field_path": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "identity",
                          "source_key",
                          "fact_type",
                          "text",
                          "owner",
                          "deadline",
                          "status",
                          "field_path"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "actions_cancelled": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "identity": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          },
                          "source_key": {
                            "type": "string"
                          },
                          "fact_type": {
                            "type": "string"
                          },
                          "text": {
                            "type": "string"
                          },
                          "owner": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "deadline": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "status": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "field_path": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "identity",
                          "source_key",
                          "fact_type",
                          "text",
                          "owner",
                          "deadline",
                          "status",
                          "field_path"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "new_questions": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "identity": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          },
                          "source_key": {
                            "type": "string"
                          },
                          "fact_type": {
                            "type": "string"
                          },
                          "text": {
                            "type": "string"
                          },
                          "owner": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "deadline": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "status": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "field_path": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "identity",
                          "source_key",
                          "fact_type",
                          "text",
                          "owner",
                          "deadline",
                          "status",
                          "field_path"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "new_corrections": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "identity": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          },
                          "source_key": {
                            "type": "string"
                          },
                          "correction_key": {
                            "type": "string"
                          },
                          "canonical_sha256": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          },
                          "field_path": {
                            "type": "string"
                          },
                          "supersedes_correction_key": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          }
                        },
                        "required": [
                          "identity",
                          "source_key",
                          "correction_key",
                          "canonical_sha256",
                          "field_path",
                          "supersedes_correction_key"
                        ],
                        "additionalProperties": false
                      }
                    }
                  },
                  "required": [
                    "schema_version",
                    "comparable_to_previous",
                    "comparability_reason",
                    "knowledge_changed",
                    "baseline",
                    "new_sources",
                    "removed_sources",
                    "revised_sources",
                    "new_facts",
                    "removed_facts",
                    "changed_decisions",
                    "actions_opened",
                    "actions_completed",
                    "actions_cancelled",
                    "new_questions",
                    "new_corrections"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "null"
                }
              ]
            },
            "last_viewed_at": {
              "anyOf": [
                {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "created_at": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
            },
            "updated_at": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
            }
          },
          "required": [
            "id",
            "name",
            "original_query",
            "explicit_filters",
            "requested_mode",
            "requested_coverage",
            "requested_sort",
            "last_plan_version",
            "last_search_id",
            "last_result_sha256",
            "last_bundle_sha256",
            "last_corpus_watermark",
            "last_delta",
            "last_viewed_at",
            "created_at",
            "updated_at"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": [
      "schema_version",
      "smart_recalls"
    ],
    "additionalProperties": false
  },
  "smartRecallDetail": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "name": {
        "type": "string"
      },
      "original_query": {
        "type": "string"
      },
      "explicit_filters": {
        "type": "object",
        "properties": {
          "workspace_keys": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "project_keys": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "topic_keys": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "source_families": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "all",
                "meetings",
                "documents",
                "notes",
                "email"
              ]
            }
          },
          "source_types": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "occurred_date_from": {
            "type": "string",
            "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
          },
          "occurred_date_to": {
            "type": "string",
            "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
          }
        },
        "additionalProperties": false
      },
      "requested_mode": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "auto",
              "sources",
              "passages",
              "facts",
              "bundle"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "requested_coverage": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "auto",
              "top_matches",
              "all_filtered"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "requested_sort": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "relevance",
              "newest",
              "oldest"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "last_plan_version": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "last_search_id": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "last_result_sha256": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          {
            "type": "null"
          }
        ]
      },
      "last_bundle_sha256": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          {
            "type": "null"
          }
        ]
      },
      "last_corpus_watermark": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          {
            "type": "null"
          }
        ]
      },
      "last_delta": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "schema_version": {
                "type": "string",
                "const": "mkc.smart-recall-delta.v1"
              },
              "comparable_to_previous": {
                "type": "boolean"
              },
              "comparability_reason": {
                "anyOf": [
                  {
                    "type": "string",
                    "enum": [
                      "first_run",
                      "planner_version_changed",
                      "scope_or_coverage_changed"
                    ]
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "knowledge_changed": {
                "type": "boolean"
              },
              "baseline": {
                "type": "object",
                "properties": {
                  "sources": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "facts": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "corrections": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  }
                },
                "required": [
                  "sources",
                  "facts",
                  "corrections"
                ],
                "additionalProperties": false
              },
              "new_sources": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "source_key": {
                      "type": "string"
                    },
                    "canonical_sha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "deleted_at": {
                      "anyOf": [
                        {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "source_key",
                    "canonical_sha256",
                    "deleted_at"
                  ],
                  "additionalProperties": false
                }
              },
              "removed_sources": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "source_key": {
                      "type": "string"
                    },
                    "canonical_sha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "deleted_at": {
                      "anyOf": [
                        {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "source_key",
                    "canonical_sha256",
                    "deleted_at"
                  ],
                  "additionalProperties": false
                }
              },
              "revised_sources": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "before": {
                      "type": "object",
                      "properties": {
                        "source_key": {
                          "type": "string"
                        },
                        "canonical_sha256": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "deleted_at": {
                          "anyOf": [
                            {
                              "type": "string",
                              "format": "date-time",
                              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "source_key",
                        "canonical_sha256",
                        "deleted_at"
                      ],
                      "additionalProperties": false
                    },
                    "after": {
                      "type": "object",
                      "properties": {
                        "source_key": {
                          "type": "string"
                        },
                        "canonical_sha256": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "deleted_at": {
                          "anyOf": [
                            {
                              "type": "string",
                              "format": "date-time",
                              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "source_key",
                        "canonical_sha256",
                        "deleted_at"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "before",
                    "after"
                  ],
                  "additionalProperties": false
                }
              },
              "new_facts": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "identity": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "source_key": {
                      "type": "string"
                    },
                    "fact_type": {
                      "type": "string"
                    },
                    "text": {
                      "type": "string"
                    },
                    "owner": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "deadline": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "status": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "field_path": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "identity",
                    "source_key",
                    "fact_type",
                    "text",
                    "owner",
                    "deadline",
                    "status",
                    "field_path"
                  ],
                  "additionalProperties": false
                }
              },
              "removed_facts": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "identity": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "source_key": {
                      "type": "string"
                    },
                    "fact_type": {
                      "type": "string"
                    },
                    "text": {
                      "type": "string"
                    },
                    "owner": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "deadline": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "status": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "field_path": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "identity",
                    "source_key",
                    "fact_type",
                    "text",
                    "owner",
                    "deadline",
                    "status",
                    "field_path"
                  ],
                  "additionalProperties": false
                }
              },
              "changed_decisions": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "identity": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "source_key": {
                      "type": "string"
                    },
                    "fact_type": {
                      "type": "string"
                    },
                    "text": {
                      "type": "string"
                    },
                    "owner": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "deadline": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "status": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "field_path": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "identity",
                    "source_key",
                    "fact_type",
                    "text",
                    "owner",
                    "deadline",
                    "status",
                    "field_path"
                  ],
                  "additionalProperties": false
                }
              },
              "actions_opened": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "identity": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "source_key": {
                      "type": "string"
                    },
                    "fact_type": {
                      "type": "string"
                    },
                    "text": {
                      "type": "string"
                    },
                    "owner": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "deadline": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "status": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "field_path": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "identity",
                    "source_key",
                    "fact_type",
                    "text",
                    "owner",
                    "deadline",
                    "status",
                    "field_path"
                  ],
                  "additionalProperties": false
                }
              },
              "actions_completed": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "identity": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "source_key": {
                      "type": "string"
                    },
                    "fact_type": {
                      "type": "string"
                    },
                    "text": {
                      "type": "string"
                    },
                    "owner": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "deadline": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "status": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "field_path": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "identity",
                    "source_key",
                    "fact_type",
                    "text",
                    "owner",
                    "deadline",
                    "status",
                    "field_path"
                  ],
                  "additionalProperties": false
                }
              },
              "actions_cancelled": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "identity": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "source_key": {
                      "type": "string"
                    },
                    "fact_type": {
                      "type": "string"
                    },
                    "text": {
                      "type": "string"
                    },
                    "owner": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "deadline": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "status": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "field_path": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "identity",
                    "source_key",
                    "fact_type",
                    "text",
                    "owner",
                    "deadline",
                    "status",
                    "field_path"
                  ],
                  "additionalProperties": false
                }
              },
              "new_questions": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "identity": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "source_key": {
                      "type": "string"
                    },
                    "fact_type": {
                      "type": "string"
                    },
                    "text": {
                      "type": "string"
                    },
                    "owner": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "deadline": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "status": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "field_path": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "identity",
                    "source_key",
                    "fact_type",
                    "text",
                    "owner",
                    "deadline",
                    "status",
                    "field_path"
                  ],
                  "additionalProperties": false
                }
              },
              "new_corrections": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "identity": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "source_key": {
                      "type": "string"
                    },
                    "correction_key": {
                      "type": "string"
                    },
                    "canonical_sha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "field_path": {
                      "type": "string"
                    },
                    "supersedes_correction_key": {
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "identity",
                    "source_key",
                    "correction_key",
                    "canonical_sha256",
                    "field_path",
                    "supersedes_correction_key"
                  ],
                  "additionalProperties": false
                }
              }
            },
            "required": [
              "schema_version",
              "comparable_to_previous",
              "comparability_reason",
              "knowledge_changed",
              "baseline",
              "new_sources",
              "removed_sources",
              "revised_sources",
              "new_facts",
              "removed_facts",
              "changed_decisions",
              "actions_opened",
              "actions_completed",
              "actions_cancelled",
              "new_questions",
              "new_corrections"
            ],
            "additionalProperties": false
          },
          {
            "type": "null"
          }
        ]
      },
      "last_viewed_at": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
          },
          {
            "type": "null"
          }
        ]
      },
      "created_at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
      },
      "updated_at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
      }
    },
    "required": [
      "id",
      "name",
      "original_query",
      "explicit_filters",
      "requested_mode",
      "requested_coverage",
      "requested_sort",
      "last_plan_version",
      "last_search_id",
      "last_result_sha256",
      "last_bundle_sha256",
      "last_corpus_watermark",
      "last_delta",
      "last_viewed_at",
      "created_at",
      "updated_at"
    ],
    "additionalProperties": false
  },
  "smartRecallRun": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "schema_version": {
        "type": "string",
        "const": "mkc.smart-recall-run.v1"
      },
      "smart_recall": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "original_query": {
            "type": "string"
          },
          "explicit_filters": {
            "type": "object",
            "properties": {
              "workspace_keys": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "project_keys": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "topic_keys": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "source_families": {
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "all",
                    "meetings",
                    "documents",
                    "notes",
                    "email"
                  ]
                }
              },
              "source_types": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "occurred_date_from": {
                "type": "string",
                "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              },
              "occurred_date_to": {
                "type": "string",
                "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
              }
            },
            "additionalProperties": false
          },
          "requested_mode": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "auto",
                  "sources",
                  "passages",
                  "facts",
                  "bundle"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "requested_coverage": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "auto",
                  "top_matches",
                  "all_filtered"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "requested_sort": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "relevance",
                  "newest",
                  "oldest"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "last_plan_version": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "last_search_id": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "last_result_sha256": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "last_bundle_sha256": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "last_corpus_watermark": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "last_delta": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "schema_version": {
                    "type": "string",
                    "const": "mkc.smart-recall-delta.v1"
                  },
                  "comparable_to_previous": {
                    "type": "boolean"
                  },
                  "comparability_reason": {
                    "anyOf": [
                      {
                        "type": "string",
                        "enum": [
                          "first_run",
                          "planner_version_changed",
                          "scope_or_coverage_changed"
                        ]
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "knowledge_changed": {
                    "type": "boolean"
                  },
                  "baseline": {
                    "type": "object",
                    "properties": {
                      "sources": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991
                      },
                      "facts": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991
                      },
                      "corrections": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991
                      }
                    },
                    "required": [
                      "sources",
                      "facts",
                      "corrections"
                    ],
                    "additionalProperties": false
                  },
                  "new_sources": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "source_key": {
                          "type": "string"
                        },
                        "canonical_sha256": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "deleted_at": {
                          "anyOf": [
                            {
                              "type": "string",
                              "format": "date-time",
                              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "source_key",
                        "canonical_sha256",
                        "deleted_at"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "removed_sources": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "source_key": {
                          "type": "string"
                        },
                        "canonical_sha256": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "deleted_at": {
                          "anyOf": [
                            {
                              "type": "string",
                              "format": "date-time",
                              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "source_key",
                        "canonical_sha256",
                        "deleted_at"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "revised_sources": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "before": {
                          "type": "object",
                          "properties": {
                            "source_key": {
                              "type": "string"
                            },
                            "canonical_sha256": {
                              "type": "string",
                              "pattern": "^[a-f0-9]{64}$"
                            },
                            "deleted_at": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "format": "date-time",
                                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            }
                          },
                          "required": [
                            "source_key",
                            "canonical_sha256",
                            "deleted_at"
                          ],
                          "additionalProperties": false
                        },
                        "after": {
                          "type": "object",
                          "properties": {
                            "source_key": {
                              "type": "string"
                            },
                            "canonical_sha256": {
                              "type": "string",
                              "pattern": "^[a-f0-9]{64}$"
                            },
                            "deleted_at": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "format": "date-time",
                                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            }
                          },
                          "required": [
                            "source_key",
                            "canonical_sha256",
                            "deleted_at"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "required": [
                        "before",
                        "after"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "new_facts": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "identity": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "source_key": {
                          "type": "string"
                        },
                        "fact_type": {
                          "type": "string"
                        },
                        "text": {
                          "type": "string"
                        },
                        "owner": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "deadline": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "status": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "field_path": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "identity",
                        "source_key",
                        "fact_type",
                        "text",
                        "owner",
                        "deadline",
                        "status",
                        "field_path"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "removed_facts": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "identity": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "source_key": {
                          "type": "string"
                        },
                        "fact_type": {
                          "type": "string"
                        },
                        "text": {
                          "type": "string"
                        },
                        "owner": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "deadline": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "status": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "field_path": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "identity",
                        "source_key",
                        "fact_type",
                        "text",
                        "owner",
                        "deadline",
                        "status",
                        "field_path"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "changed_decisions": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "identity": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "source_key": {
                          "type": "string"
                        },
                        "fact_type": {
                          "type": "string"
                        },
                        "text": {
                          "type": "string"
                        },
                        "owner": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "deadline": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "status": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "field_path": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "identity",
                        "source_key",
                        "fact_type",
                        "text",
                        "owner",
                        "deadline",
                        "status",
                        "field_path"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "actions_opened": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "identity": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "source_key": {
                          "type": "string"
                        },
                        "fact_type": {
                          "type": "string"
                        },
                        "text": {
                          "type": "string"
                        },
                        "owner": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "deadline": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "status": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "field_path": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "identity",
                        "source_key",
                        "fact_type",
                        "text",
                        "owner",
                        "deadline",
                        "status",
                        "field_path"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "actions_completed": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "identity": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "source_key": {
                          "type": "string"
                        },
                        "fact_type": {
                          "type": "string"
                        },
                        "text": {
                          "type": "string"
                        },
                        "owner": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "deadline": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "status": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "field_path": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "identity",
                        "source_key",
                        "fact_type",
                        "text",
                        "owner",
                        "deadline",
                        "status",
                        "field_path"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "actions_cancelled": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "identity": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "source_key": {
                          "type": "string"
                        },
                        "fact_type": {
                          "type": "string"
                        },
                        "text": {
                          "type": "string"
                        },
                        "owner": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "deadline": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "status": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "field_path": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "identity",
                        "source_key",
                        "fact_type",
                        "text",
                        "owner",
                        "deadline",
                        "status",
                        "field_path"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "new_questions": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "identity": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "source_key": {
                          "type": "string"
                        },
                        "fact_type": {
                          "type": "string"
                        },
                        "text": {
                          "type": "string"
                        },
                        "owner": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "deadline": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "status": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "field_path": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "identity",
                        "source_key",
                        "fact_type",
                        "text",
                        "owner",
                        "deadline",
                        "status",
                        "field_path"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "new_corrections": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "identity": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "source_key": {
                          "type": "string"
                        },
                        "correction_key": {
                          "type": "string"
                        },
                        "canonical_sha256": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "field_path": {
                          "type": "string"
                        },
                        "supersedes_correction_key": {
                          "anyOf": [
                            {
                              "type": "string"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "identity",
                        "source_key",
                        "correction_key",
                        "canonical_sha256",
                        "field_path",
                        "supersedes_correction_key"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "schema_version",
                  "comparable_to_previous",
                  "comparability_reason",
                  "knowledge_changed",
                  "baseline",
                  "new_sources",
                  "removed_sources",
                  "revised_sources",
                  "new_facts",
                  "removed_facts",
                  "changed_decisions",
                  "actions_opened",
                  "actions_completed",
                  "actions_cancelled",
                  "new_questions",
                  "new_corrections"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "last_viewed_at": {
            "anyOf": [
              {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
              },
              {
                "type": "null"
              }
            ]
          },
          "created_at": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
          }
        },
        "required": [
          "id",
          "name",
          "original_query",
          "explicit_filters",
          "requested_mode",
          "requested_coverage",
          "requested_sort",
          "last_plan_version",
          "last_search_id",
          "last_result_sha256",
          "last_bundle_sha256",
          "last_corpus_watermark",
          "last_delta",
          "last_viewed_at",
          "created_at",
          "updated_at"
        ],
        "additionalProperties": false
      },
      "run": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "search_id": {
            "type": "string"
          },
          "created_at": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
          },
          "result_sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "bundle_sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "planner_version": {
            "type": "string"
          },
          "resolved_window": {
            "type": "object",
            "properties": {
              "occurred_from": {
                "anyOf": [
                  {
                    "type": "string",
                    "format": "date-time",
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "occurred_to_exclusive": {
                "anyOf": [
                  {
                    "type": "string",
                    "format": "date-time",
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "deadline_from": {
                "anyOf": [
                  {
                    "type": "string",
                    "format": "date-time",
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "deadline_to_exclusive": {
                "anyOf": [
                  {
                    "type": "string",
                    "format": "date-time",
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "occurred_from",
              "occurred_to_exclusive",
              "deadline_from",
              "deadline_to_exclusive"
            ],
            "additionalProperties": false
          },
          "coverage": {
            "type": "object",
            "properties": {
              "schema_version": {
                "type": "string",
                "const": "mkc.coverage-receipt.v1"
              },
              "mode": {
                "type": "string",
                "enum": [
                  "top_matches",
                  "all_filtered"
                ]
              },
              "scope_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "inspected_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "returned_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "source_census_complete": {
                "type": "boolean"
              },
              "evidence_complete": {
                "type": "boolean"
              },
              "evidence_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "evidence_passage_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "unreadable_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "omitted_evidence_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "evidence_truncated": {
                "type": "boolean"
              },
              "coverage_basis": {
                "type": "string",
                "enum": [
                  "ranked_retrieval",
                  "deterministic_source_census",
                  "typed_facts"
                ]
              },
              "complete": {
                "type": "boolean"
              },
              "truncated": {
                "type": "boolean"
              },
              "continuation_available": {
                "type": "boolean"
              },
              "exclusions": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "warnings": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "required": [
              "schema_version",
              "mode",
              "scope_source_count",
              "inspected_source_count",
              "returned_source_count",
              "source_census_complete",
              "evidence_complete",
              "evidence_source_count",
              "evidence_passage_count",
              "unreadable_source_count",
              "omitted_evidence_source_count",
              "evidence_truncated",
              "coverage_basis",
              "complete",
              "truncated",
              "continuation_available",
              "exclusions",
              "warnings"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "id",
          "search_id",
          "created_at",
          "result_sha256",
          "bundle_sha256",
          "planner_version",
          "resolved_window",
          "coverage"
        ],
        "additionalProperties": false
      },
      "delta": {
        "type": "object",
        "properties": {
          "schema_version": {
            "type": "string",
            "const": "mkc.smart-recall-delta.v1"
          },
          "comparable_to_previous": {
            "type": "boolean"
          },
          "comparability_reason": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "first_run",
                  "planner_version_changed",
                  "scope_or_coverage_changed"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "knowledge_changed": {
            "type": "boolean"
          },
          "baseline": {
            "type": "object",
            "properties": {
              "sources": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "facts": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "corrections": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "sources",
              "facts",
              "corrections"
            ],
            "additionalProperties": false
          },
          "new_sources": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "source_key": {
                  "type": "string"
                },
                "canonical_sha256": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "deleted_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "source_key",
                "canonical_sha256",
                "deleted_at"
              ],
              "additionalProperties": false
            }
          },
          "removed_sources": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "source_key": {
                  "type": "string"
                },
                "canonical_sha256": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "deleted_at": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "source_key",
                "canonical_sha256",
                "deleted_at"
              ],
              "additionalProperties": false
            }
          },
          "revised_sources": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "before": {
                  "type": "object",
                  "properties": {
                    "source_key": {
                      "type": "string"
                    },
                    "canonical_sha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "deleted_at": {
                      "anyOf": [
                        {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "source_key",
                    "canonical_sha256",
                    "deleted_at"
                  ],
                  "additionalProperties": false
                },
                "after": {
                  "type": "object",
                  "properties": {
                    "source_key": {
                      "type": "string"
                    },
                    "canonical_sha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "deleted_at": {
                      "anyOf": [
                        {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "source_key",
                    "canonical_sha256",
                    "deleted_at"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "before",
                "after"
              ],
              "additionalProperties": false
            }
          },
          "new_facts": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "source_key": {
                  "type": "string"
                },
                "fact_type": {
                  "type": "string"
                },
                "text": {
                  "type": "string"
                },
                "owner": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "field_path": {
                  "type": "string"
                }
              },
              "required": [
                "identity",
                "source_key",
                "fact_type",
                "text",
                "owner",
                "deadline",
                "status",
                "field_path"
              ],
              "additionalProperties": false
            }
          },
          "removed_facts": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "source_key": {
                  "type": "string"
                },
                "fact_type": {
                  "type": "string"
                },
                "text": {
                  "type": "string"
                },
                "owner": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "field_path": {
                  "type": "string"
                }
              },
              "required": [
                "identity",
                "source_key",
                "fact_type",
                "text",
                "owner",
                "deadline",
                "status",
                "field_path"
              ],
              "additionalProperties": false
            }
          },
          "changed_decisions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "source_key": {
                  "type": "string"
                },
                "fact_type": {
                  "type": "string"
                },
                "text": {
                  "type": "string"
                },
                "owner": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "field_path": {
                  "type": "string"
                }
              },
              "required": [
                "identity",
                "source_key",
                "fact_type",
                "text",
                "owner",
                "deadline",
                "status",
                "field_path"
              ],
              "additionalProperties": false
            }
          },
          "actions_opened": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "source_key": {
                  "type": "string"
                },
                "fact_type": {
                  "type": "string"
                },
                "text": {
                  "type": "string"
                },
                "owner": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "field_path": {
                  "type": "string"
                }
              },
              "required": [
                "identity",
                "source_key",
                "fact_type",
                "text",
                "owner",
                "deadline",
                "status",
                "field_path"
              ],
              "additionalProperties": false
            }
          },
          "actions_completed": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "source_key": {
                  "type": "string"
                },
                "fact_type": {
                  "type": "string"
                },
                "text": {
                  "type": "string"
                },
                "owner": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "field_path": {
                  "type": "string"
                }
              },
              "required": [
                "identity",
                "source_key",
                "fact_type",
                "text",
                "owner",
                "deadline",
                "status",
                "field_path"
              ],
              "additionalProperties": false
            }
          },
          "actions_cancelled": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "source_key": {
                  "type": "string"
                },
                "fact_type": {
                  "type": "string"
                },
                "text": {
                  "type": "string"
                },
                "owner": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "field_path": {
                  "type": "string"
                }
              },
              "required": [
                "identity",
                "source_key",
                "fact_type",
                "text",
                "owner",
                "deadline",
                "status",
                "field_path"
              ],
              "additionalProperties": false
            }
          },
          "new_questions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "source_key": {
                  "type": "string"
                },
                "fact_type": {
                  "type": "string"
                },
                "text": {
                  "type": "string"
                },
                "owner": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "deadline": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "field_path": {
                  "type": "string"
                }
              },
              "required": [
                "identity",
                "source_key",
                "fact_type",
                "text",
                "owner",
                "deadline",
                "status",
                "field_path"
              ],
              "additionalProperties": false
            }
          },
          "new_corrections": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "identity": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "source_key": {
                  "type": "string"
                },
                "correction_key": {
                  "type": "string"
                },
                "canonical_sha256": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "field_path": {
                  "type": "string"
                },
                "supersedes_correction_key": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "identity",
                "source_key",
                "correction_key",
                "canonical_sha256",
                "field_path",
                "supersedes_correction_key"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "schema_version",
          "comparable_to_previous",
          "comparability_reason",
          "knowledge_changed",
          "baseline",
          "new_sources",
          "removed_sources",
          "revised_sources",
          "new_facts",
          "removed_facts",
          "changed_decisions",
          "actions_opened",
          "actions_completed",
          "actions_cancelled",
          "new_questions",
          "new_corrections"
        ],
        "additionalProperties": false
      },
      "frozen_recall": {
        "type": "object",
        "properties": {
          "schema_version": {
            "type": "string",
            "const": "mkc.frozen-recall-open.v1"
          },
          "search_id": {
            "type": "string"
          },
          "created_at": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
          },
          "expires_at": {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
          },
          "result_sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "bundle_sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "plan": {
            "type": "object",
            "properties": {
              "schema_version": {
                "type": "string",
                "const": "mkc.query-plan.v2"
              },
              "original_query": {
                "type": "string"
              },
              "planner_version": {
                "type": "string"
              },
              "planner_source": {
                "type": "string",
                "enum": [
                  "deterministic",
                  "provider_guarded",
                  "provider_fallback"
                ]
              },
              "user_job": {
                "type": "string",
                "enum": [
                  "locate",
                  "collect",
                  "typed_memory",
                  "browse_history",
                  "research",
                  "answer"
                ]
              },
              "execution_strategy": {
                "type": "string",
                "enum": [
                  "deterministic_list",
                  "typed_fact_lookup",
                  "focused_answer",
                  "research_bundle"
                ]
              },
              "result_mode": {
                "type": "string",
                "enum": [
                  "sources",
                  "passages",
                  "facts",
                  "bundle"
                ]
              },
              "coverage_mode": {
                "type": "string",
                "enum": [
                  "top_matches",
                  "all_filtered"
                ]
              },
              "scope_strategy": {
                "type": "string",
                "enum": [
                  "ranked",
                  "full_if_within_budget"
                ]
              },
              "sort": {
                "type": "string",
                "enum": [
                  "relevance",
                  "newest",
                  "oldest"
                ]
              },
              "timezone": {
                "type": "string"
              },
              "date_basis": {
                "type": "string",
                "enum": [
                  "source_occurred_at",
                  "fact_deadline",
                  "source_and_fact"
                ]
              },
              "occurred_from": {
                "anyOf": [
                  {
                    "type": "string",
                    "format": "date-time",
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "occurred_to_exclusive": {
                "anyOf": [
                  {
                    "type": "string",
                    "format": "date-time",
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "deadline_from": {
                "anyOf": [
                  {
                    "type": "string",
                    "format": "date-time",
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "deadline_to_exclusive": {
                "anyOf": [
                  {
                    "type": "string",
                    "format": "date-time",
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "explicit_constraints": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "workspace",
                        "project",
                        "topic",
                        "source_family",
                        "source_type",
                        "date",
                        "deadline",
                        "fact_type"
                      ]
                    },
                    "value": {
                      "type": "string"
                    },
                    "source": {
                      "type": "string",
                      "enum": [
                        "explicit",
                        "inferred",
                        "inherited",
                        "default"
                      ]
                    },
                    "removable": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "kind",
                    "value",
                    "source",
                    "removable"
                  ],
                  "additionalProperties": false
                }
              },
              "inferred_constraints": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "workspace",
                        "project",
                        "topic",
                        "source_family",
                        "source_type",
                        "date",
                        "deadline",
                        "fact_type"
                      ]
                    },
                    "value": {
                      "type": "string"
                    },
                    "source": {
                      "type": "string",
                      "enum": [
                        "explicit",
                        "inferred",
                        "inherited",
                        "default"
                      ]
                    },
                    "removable": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "kind",
                    "value",
                    "source",
                    "removable"
                  ],
                  "additionalProperties": false
                }
              },
              "exact_literals": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "exact_identifiers": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "aliases": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "original": {
                      "type": "string"
                    },
                    "expanded": {
                      "type": "string"
                    },
                    "kind": {
                      "type": "string",
                      "enum": [
                        "alias",
                        "typo",
                        "transliteration"
                      ]
                    },
                    "source": {
                      "type": "string",
                      "enum": [
                        "deterministic",
                        "registry",
                        "provider"
                      ]
                    },
                    "confidence": {
                      "type": "number"
                    }
                  },
                  "required": [
                    "original",
                    "expanded",
                    "kind",
                    "source",
                    "confidence"
                  ],
                  "additionalProperties": false
                }
              },
              "typo_candidates": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "original": {
                      "type": "string"
                    },
                    "expanded": {
                      "type": "string"
                    },
                    "kind": {
                      "type": "string",
                      "enum": [
                        "alias",
                        "typo",
                        "transliteration"
                      ]
                    },
                    "source": {
                      "type": "string",
                      "enum": [
                        "deterministic",
                        "registry",
                        "provider"
                      ]
                    },
                    "confidence": {
                      "type": "number"
                    }
                  },
                  "required": [
                    "original",
                    "expanded",
                    "kind",
                    "source",
                    "confidence"
                  ],
                  "additionalProperties": false
                }
              },
              "topical_query": {
                "type": "string"
              },
              "supporting_queries": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "source_families": {
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "all",
                    "meetings",
                    "documents",
                    "notes",
                    "email"
                  ]
                }
              },
              "source_types": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "fact_types": {
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "decision",
                    "action",
                    "question",
                    "claim",
                    "important_point"
                  ]
                }
              },
              "fact_owners": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "fact_statuses": {
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "open",
                    "completed",
                    "cancelled"
                  ]
                }
              },
              "requested_count": {
                "anyOf": [
                  {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "intent": {
                "type": "string",
                "enum": [
                  "decision",
                  "task",
                  "question",
                  "timeline",
                  "general"
                ]
              },
              "presentation_job": {
                "type": "string",
                "enum": [
                  "default",
                  "chronology",
                  "list",
                  "comparison"
                ]
              },
              "presentation_instructions": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "required": [
              "schema_version",
              "original_query",
              "planner_version",
              "planner_source",
              "user_job",
              "execution_strategy",
              "result_mode",
              "coverage_mode",
              "sort",
              "timezone",
              "date_basis",
              "occurred_from",
              "occurred_to_exclusive",
              "explicit_constraints",
              "inferred_constraints",
              "exact_literals",
              "exact_identifiers",
              "aliases",
              "typo_candidates",
              "topical_query",
              "supporting_queries",
              "source_families",
              "source_types",
              "fact_types",
              "requested_count",
              "intent"
            ],
            "additionalProperties": false
          },
          "coverage": {
            "type": "object",
            "properties": {
              "schema_version": {
                "type": "string",
                "const": "mkc.coverage-receipt.v1"
              },
              "mode": {
                "type": "string",
                "enum": [
                  "top_matches",
                  "all_filtered"
                ]
              },
              "scope_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "inspected_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "returned_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "source_census_complete": {
                "type": "boolean"
              },
              "evidence_complete": {
                "type": "boolean"
              },
              "evidence_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "evidence_passage_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "unreadable_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "omitted_evidence_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "evidence_truncated": {
                "type": "boolean"
              },
              "coverage_basis": {
                "type": "string",
                "enum": [
                  "ranked_retrieval",
                  "deterministic_source_census",
                  "typed_facts"
                ]
              },
              "complete": {
                "type": "boolean"
              },
              "truncated": {
                "type": "boolean"
              },
              "continuation_available": {
                "type": "boolean"
              },
              "exclusions": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "warnings": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "required": [
              "schema_version",
              "mode",
              "scope_source_count",
              "inspected_source_count",
              "returned_source_count",
              "source_census_complete",
              "evidence_complete",
              "evidence_source_count",
              "evidence_passage_count",
              "unreadable_source_count",
              "omitted_evidence_source_count",
              "evidence_truncated",
              "coverage_basis",
              "complete",
              "truncated",
              "continuation_available",
              "exclusions",
              "warnings"
            ],
            "additionalProperties": false
          },
          "source_count": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "fact_count": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "source_manifest_markdown": {
            "type": "string"
          },
          "memory_bundle_markdown": {
            "type": "string"
          },
          "bundle": {
            "type": "object",
            "properties": {
              "token_budget": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "estimated_tokens": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "core_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "core_evidence_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "available_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "available_evidence_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "omitted_from_core_source_count": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "truncated": {
                "type": "boolean"
              },
              "recommended_next_chapter_id": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "chapters": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "chapter_id": {
                      "type": "string"
                    },
                    "title": {
                      "type": "string"
                    },
                    "source_count": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "evidence_count": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "estimated_tokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "chapter_sha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    }
                  },
                  "required": [
                    "chapter_id",
                    "title",
                    "source_count",
                    "evidence_count",
                    "estimated_tokens",
                    "chapter_sha256"
                  ],
                  "additionalProperties": false
                }
              }
            },
            "required": [
              "token_budget",
              "estimated_tokens",
              "core_source_count",
              "core_evidence_count",
              "available_source_count",
              "available_evidence_count",
              "omitted_from_core_source_count",
              "truncated",
              "recommended_next_chapter_id",
              "chapters"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schema_version",
          "search_id",
          "created_at",
          "expires_at",
          "result_sha256",
          "bundle_sha256",
          "plan",
          "coverage",
          "source_count",
          "fact_count",
          "source_manifest_markdown",
          "memory_bundle_markdown",
          "bundle"
        ],
        "additionalProperties": false
      },
      "handoff": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "mode": {
                "type": "string",
                "const": "prepare_for_meeting"
              },
              "instruction": {
                "type": "string"
              },
              "search_id": {
                "type": "string"
              },
              "result_sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "bundle_sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "expires_at": {
                "type": "string",
                "format": "date-time",
                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
              }
            },
            "required": [
              "mode",
              "instruction",
              "search_id",
              "result_sha256",
              "bundle_sha256",
              "expires_at"
            ],
            "additionalProperties": false
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "required": [
      "schema_version",
      "smart_recall",
      "run",
      "delta",
      "frozen_recall",
      "handoff"
    ],
    "additionalProperties": false
  }
};
