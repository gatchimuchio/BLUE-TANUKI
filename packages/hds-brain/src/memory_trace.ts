import { createHash } from "node:crypto";
import type { InboundRequest } from "@blue-tanuki/protocol";
import type {
  HDSProcessDefinition,
  MemoryHit,
  MemoryReadPolicy,
  MemorySearchPlan,
  MemoryTrace,
} from "./types.js";
import type { MemoryEntry } from "./long-term-memory/index.js";
import {
  fReferenceForId,
  fReferencesFromText,
  idFromFReference,
  referenceIdFromInput,
} from "./f_reference.js";

export interface MemoryReaderPort {
  recent(n: number): readonly unknown[];
  all?: () => readonly unknown[];
  findByRequestId?: (request_id: string) => unknown | null;
  findByTag?: (tag: string, limit?: number) => readonly unknown[];
  verify?: () => boolean;
}

export function buildMemoryTrace(
  req: InboundRequest,
  process: HDSProcessDefinition,
  reader?: MemoryReaderPort,
): MemoryTrace {
  const policy = process.memory_policy;
  const source_integrity_verified = Boolean(
    policy.enabled &&
    policy.allowed_sources.includes("hds_ltm") &&
    reader &&
    readerIntegrityVerified(reader),
  );
  const search_plan = createSearchPlan(req, process, source_integrity_verified);
  if (!source_integrity_verified || !reader) {
    return emptyTrace(policy, process.process_id, search_plan);
  }

  const candidates = collectCandidates(reader, policy);
  const hits: MemoryHit[] = [];
  const seen = new Set<string>();

  const add = (entry: MemoryEntry, reason: MemoryHit["reason"], matched_on?: string): void => {
    if (hits.length >= policy.max_hits) return;
    if (seen.has(entry.entry_hash)) return;
    seen.add(entry.entry_hash);
    hits.push({
      source: "hds_ltm",
      memory_id: entry.request_id,
      f_reference: fReferenceForId(entry.request_id),
      entry_hash: entry.entry_hash,
      reason,
      matched_on,
      provenance: {
        source_store: "hds_ltm",
        record_id: entry.request_id,
        version: entry.entry_hash,
        source_ref: fReferenceForId(entry.request_id),
        captured_at_ms: entry.timestamp,
        ...(entry.process ? {
          source_process_id: entry.process.process_id,
          source_process_version: entry.process.version,
        } : {}),
        ...(entry.actor ? { source_actor_kind: entry.actor.actor_kind } : {}),
        ...(entry.commit ? {
          source_decision: entry.commit.decision,
          source_decision_hash: entry.commit.hash,
        } : {}),
      },
      summary: {
        goal: entry.goal,
        problem_definition_id: entry.problem_definition_id,
        abstraction: entry.abstraction,
      },
      summary_projection: summaryProjectionSource(entry),
    });
  };

  if (policy.retrieval_modes.includes("exact")) {
    for (const ref of exactKeys(req)) {
      const exact = referenceIdFromInput(ref);
      const direct = reader.findByRequestId?.(exact);
      if (isMemoryEntry(direct)) add(direct, "exact", ref);
      for (const entry of candidates) {
        if (entry.request_id === exact || fReferenceForId(entry.request_id) === ref) {
          add(entry, "exact", ref);
        }
      }
    }
  }

  if (policy.retrieval_modes.includes("tag")) {
    const tags = tagKeys(req, process);
    for (const tag of tags) {
      const direct = reader.findByTag?.(tag, policy.max_hits);
      if (direct) {
        for (const entry of direct) if (isMemoryEntry(entry)) add(entry, "tag", tag);
      }
      for (const entry of candidates) {
        if (entryMatchesTag(entry, tag)) add(entry, "tag", tag);
      }
    }
  }

  if (policy.retrieval_modes.includes("recent")) {
    for (const entry of reader.recent(policy.max_hits)) {
      if (isMemoryEntry(entry)) add(entry, "recent");
    }
  }

  return {
    policy_id: policy.policy_id,
    process_id: process.process_id,
    search_plan,
    used_for_authority: false,
    hits,
  };
}

function emptyTrace(
  policy: MemoryReadPolicy,
  process_id: string,
  search_plan: MemorySearchPlan,
): MemoryTrace {
  return {
    policy_id: policy.policy_id,
    process_id,
    search_plan,
    used_for_authority: false,
    hits: [],
  };
}

function createSearchPlan(
  req: InboundRequest,
  process: HDSProcessDefinition,
  source_integrity_verified: boolean,
): MemorySearchPlan {
  const policy = process.memory_policy;
  const explicit_references_requested = exactKeys(req).length > 0;
  const purpose = "current_request_citation_context" as const;
  const query_digest = digest(req.content);
  const allowed_sources = source_integrity_verified
    ? ["hds_ltm"] as const
    : [] as const;
  const retrieval_modes = policy.enabled ? [...policy.retrieval_modes] : [];
  const application_scope_id = digest(JSON.stringify({
    request_id: req.id,
    process_id: process.process_id,
    policy_id: policy.policy_id,
    query_digest,
  }));
  const plan_id = digest(JSON.stringify({
    purpose,
    request_id: req.id,
    process_id: process.process_id,
    query_digest,
    explicit_references_requested,
    application_scope_id,
    allowed_sources,
    retrieval_modes,
    max_hits: Math.max(0, policy.max_hits),
    source_integrity_verified,
  }));
  return {
    plan_id,
    purpose,
    request_id: req.id,
    process_id: process.process_id,
    query_digest,
    explicit_references_requested,
    application_scope_id,
    allowed_sources: [...allowed_sources],
    retrieval_modes,
    max_hits: Math.max(0, policy.max_hits),
    source_integrity_verified,
    used_for_authority: false,
  };
}

function summaryProjectionSource(entry: MemoryEntry): MemoryHit["summary_projection"] {
  const omittedSource = {
    closure: entry.closure,
    actor: {
      actor_id: entry.actor?.actor_id ?? null,
      channel: entry.actor?.channel ?? null,
      trust_level: entry.actor?.trust_level ?? null,
    },
    process_kind: entry.process?.process_kind ?? null,
    commit_reason: entry.commit?.reason ?? null,
    tags: entry.tags ?? [],
    index: entry.index,
    prev_hash: entry.prev_hash,
  };
  return {
    included_fields: ["goal", "problem_definition_id", "abstraction"],
    included_source_digest: digest(JSON.stringify({
      goal: entry.goal,
      problem_definition_id: entry.problem_definition_id,
      abstraction: entry.abstraction,
    })),
    omitted_source_fields: [
      "closure.x",
      "closure.r",
      "closure.m",
      "actor.actor_id",
      "actor.channel",
      "actor.trust_level",
      "process.process_kind",
      "commit.reason",
      "tags",
      "index",
      "prev_hash",
    ],
    omitted_source_digest: digest(JSON.stringify(omittedSource)),
  };
}

function readerIntegrityVerified(reader: MemoryReaderPort): boolean {
  try {
    return typeof reader.verify === "function" && reader.verify() === true;
  } catch {
    return false;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function collectCandidates(reader: MemoryReaderPort, policy: MemoryReadPolicy): MemoryEntry[] {
  const raw = reader.all ? reader.all() : reader.recent(Math.max(policy.max_hits * 5, policy.max_hits));
  return raw.filter(isMemoryEntry).slice(-Math.max(policy.max_hits * 20, policy.max_hits));
}

function exactKeys(req: InboundRequest): string[] {
  const meta = req.metadata ?? {};
  const refs = new Set<string>();
  for (const value of [
    stringField(meta, "request_id"),
    stringField(meta, "source_request_id"),
    stringField(meta, "reference_request_id"),
    stringField(meta, "blue_tanuki.reference_request_id"),
  ]) {
    if (!value) continue;
    const id = idFromFReference(value);
    refs.add(id ? fReferenceForId(id) : value);
  }
  for (const ref of fReferencesFromText(req.content)) refs.add(ref);
  return Array.from(refs);
}

function tagKeys(req: InboundRequest, process: HDSProcessDefinition): string[] {
  const tags = new Set<string>();
  tags.add(req.channel.toLowerCase());
  tags.add(req.user.toLowerCase());
  tags.add(process.process_kind);
  const tool = toolName(req.content) ?? toolNameFromMetadata(req.metadata ?? {});
  if (tool) tags.add(tool.toLowerCase());
  return Array.from(tags).filter((tag) => tag.length > 0);
}

function entryMatchesTag(entry: MemoryEntry, tag: string): boolean {
  const hay = [
    entry.goal,
    entry.problem_definition_id,
    entry.abstraction,
    entry.actor?.actor_id ?? "",
    entry.actor?.actor_kind ?? "",
    entry.actor?.trust_level ?? "",
    entry.process?.process_id ?? "",
    entry.process?.process_kind ?? "",
    ...(entry.tags ?? []),
    ...entry.closure.x,
    ...entry.closure.r,
    ...entry.closure.m,
  ].join("\n").toLowerCase();
  return hay.includes(tag.toLowerCase());
}

function toolName(content: string): string | undefined {
  const match = /^(?:tool:([A-Za-z0-9_.-]+)|\/tool\s+([A-Za-z0-9_.-]+))/.exec(content.trim());
  return match?.[1] ?? match?.[2];
}

function toolNameFromMetadata(meta: Record<string, unknown>): string | undefined {
  const raw = meta["blue_tanuki.tool_call"] ?? meta.tool_call;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = (raw as Record<string, unknown>).tool_name ?? (raw as Record<string, unknown>).tool;
  return typeof value === "string" ? value : undefined;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<MemoryEntry>;
  return typeof v.request_id === "string" && typeof v.entry_hash === "string" && typeof v.goal === "string" && typeof v.problem_definition_id === "string" && typeof v.abstraction === "string" && Boolean(v.closure);
}
