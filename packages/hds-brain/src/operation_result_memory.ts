import { createHash } from "node:crypto";
import {
  MEMORY_COMMIT_V2_SCHEMA_VERSION, memoryCommitContentDigest, parseMemoryCommitV2,
  parseMemoryUpdateReceipt, type MemoryCommitV2, type MemoryCommitJsonValue,
  type MemoryUpdateReceiptV1, type OperationPlanCheckpoint,
} from "@blue-tanuki/protocol";

type Plan = OperationPlanCheckpoint["plans"][number];
type Binding = Plan["bindings"][number];
type ShellExecObservation = NonNullable<OperationPlanCheckpoint["shell_exec_result_observations"]>[number];
const BROWSER_READ_CONTEXT_MAX_CHARS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

interface BrowserReadResultObservation {
  readonly schema_version: "browser-read-result-observation.v1";
  readonly record_type: "browser_read_observation";
  readonly plan_id_digest: string;
  readonly plan_revision_digest: string;
  readonly step_id_digest: string;
  readonly step_digest: string;
  readonly operation: "browser.read";
  readonly command_digest: string;
  readonly delivery_digest: string;
  readonly result_digest: string;
  readonly requested_origin: string;
  readonly final_origin: string;
  readonly navigation: "http_get";
  readonly tab_scope: "not_applicable";
  readonly frame_scope: "not_applicable";
  readonly credential_context: "no_tool_supplied_credentials";
  readonly evidence_source: "EXTERNAL_EVIDENCE" | "FIXTURE";
  readonly observed_at_ms: number;
  readonly page_text_excerpt: string;
  readonly page_text_excerpt_chars: number;
  readonly page_text_sha256: string;
  readonly page_text_excerpt_sha256: string;
  readonly source_truncated: boolean;
  readonly page_content_is_untrusted: true;
  readonly adoption_status: "observation_only";
  readonly used_as_world_truth: false;
  readonly used_for_authority: false;
  readonly may_execute: false;
}

export function browserReadResultObservation(
  p: Plan,
  b: Binding,
  result: Plan["results"][number],
): BrowserReadResultObservation {
  if (!b.delivery_digest || !b.result_digest) throw new Error("plan_memory_browser_read_binding_invalid");
  const output = result.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("plan_memory_browser_read_result_invalid");
  }
  const value = output as Record<string, unknown>;
  const observation = value.observation;
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error("plan_memory_browser_read_observation_invalid");
  }
  const metadata = observation as Record<string, unknown>;
  if (typeof value.text !== "string" || value.text.length > 50_000 || typeof value.url !== "string" ||
      typeof value.truncated !== "boolean" || metadata.schema_version !== "blue-tanuki.browser-observation.v1" ||
      metadata.navigation !== "http_get" || metadata.tab_scope !== "not_applicable" ||
      metadata.frame_scope !== "not_applicable" || metadata.credential_context !== "no_tool_supplied_credentials" ||
      (metadata.evidence_source !== "EXTERNAL_EVIDENCE" && metadata.evidence_source !== "FIXTURE") ||
      metadata.page_content_is_untrusted !== true || metadata.used_for_authority !== false || metadata.may_execute !== false ||
      typeof metadata.observed_at !== "string" || typeof metadata.requested_origin !== "string" ||
      typeof metadata.final_origin !== "string") {
    throw new Error("plan_memory_browser_read_observation_invalid");
  }
  const observedAtMs = Date.parse(metadata.observed_at);
  const requestedOrigin = new URL(metadata.requested_origin);
  const finalOrigin = new URL(metadata.final_origin);
  const finalUrl = new URL(value.url);
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0 || new Date(observedAtMs).toISOString() !== metadata.observed_at ||
      result.observed_at_ms < observedAtMs ||
      requestedOrigin.origin !== metadata.requested_origin || finalOrigin.origin !== metadata.final_origin ||
      !["http:", "https:"].includes(requestedOrigin.protocol) || !["http:", "https:"].includes(finalUrl.protocol) ||
      finalUrl.origin !== finalOrigin.origin || finalUrl.username || finalUrl.password) {
    throw new Error("plan_memory_browser_read_origin_or_time_invalid");
  }
  const text = value.text;
  const evidenceSource = metadata.evidence_source as "EXTERNAL_EVIDENCE" | "FIXTURE";
  const excerpt = text.slice(0, BROWSER_READ_CONTEXT_MAX_CHARS);
  const sha256 = (input: string) => createHash("sha256").update(input, "utf8").digest("hex");
  return {
    schema_version: "browser-read-result-observation.v1",
    record_type: "browser_read_observation",
    plan_id_digest: createHash("sha256").update(JSON.stringify(p.revisions[0]!.plan.plan_id), "utf8").digest("hex"),
    plan_revision_digest: b.revision_digest,
    step_id_digest: createHash("sha256").update(JSON.stringify(b.step_id), "utf8").digest("hex"),
    step_digest: b.step_digest,
    operation: "browser.read",
    command_digest: b.command_digest,
    delivery_digest: b.delivery_digest,
    result_digest: b.result_digest,
    requested_origin: requestedOrigin.origin,
    final_origin: finalOrigin.origin,
    navigation: "http_get",
    tab_scope: "not_applicable",
    frame_scope: "not_applicable",
    credential_context: "no_tool_supplied_credentials",
    evidence_source: evidenceSource,
    observed_at_ms: observedAtMs,
    page_text_excerpt: excerpt,
    page_text_excerpt_chars: excerpt.length,
    page_text_sha256: sha256(text),
    page_text_excerpt_sha256: sha256(excerpt),
    source_truncated: value.truncated || text.length > BROWSER_READ_CONTEXT_MAX_CHARS,
    page_content_is_untrusted: true,
    adoption_status: "observation_only",
    used_as_world_truth: false,
    used_for_authority: false,
    may_execute: false,
  };
}

/** 実作用の結果記録はMを非権威に保ち、記録だけで権限や成功判定を発行しない。 */
export function resultMemoryEligible(b: Binding): boolean {
  if (b.operation === "github.write") {
    if (!b.execution_admission || !b.execution_admission.task_identity_digest ||
        !b.delivery_digest || !b.result_digest || !b.operation_plan_binding_digest ||
        b.result_observed_at_ms === undefined) return false;
    if (b.status === "verified") return b.github_write_result?.mutation_status === "provider_accepted";
    if (b.status === "provider_rejected") return b.github_write_result?.mutation_status === "provider_rejected";
    return (b.status === "outcome_unknown" || b.status === "verification_failed") && !b.github_write_result;
  }
  const replyDraftReadback = b.prepared_step.operation === "gmail.write" &&
    b.prepared_step.parameters?.operation === "draft.create" &&
    typeof b.prepared_step.parameters.reply_to_message_id === "string" &&
    b.prepared_step.preparation?.validation?.length === 1 &&
    b.prepared_step.preparation.validation[0]?.method === "gmail_reply_draft_result_matches" &&
    isRecord(b.prepared_step.preparation.validation[0]?.expected) &&
    b.prepared_step.preparation.validation[0]?.expected.schema_version === "blue-tanuki.gmail-reply-draft-result-validation.v2";
  if (b.status === "verified") return b.operation === "file.search" || b.operation === "file.write" ||
    b.operation === "file.delete" || b.operation === "file.edit" || b.operation === "browser.read" ||
    b.operation === "gmail.write" && b.prepared_step.operation === "gmail.write" &&
      (replyDraftReadback || b.prepared_step.parameters?.operation === "draft.send" ||
        b.prepared_step.parameters?.operation === "message.send" ||
        b.prepared_step.parameters?.operation === "message.trash" ||
        b.prepared_step.parameters?.operation === "message.modify") && !!b.execution_admission?.task_identity_digest &&
      !!b.operation_plan_binding_digest && !!b.delivery_digest && !!b.result_digest &&
      b.result_observed_at_ms !== undefined;
  return b.status === "outcome_unknown" && !!b.execution_admission && !!b.delivery_digest && !!b.result_digest;
}

/** Jが受領済みの実結果を非権威観測として固定する。意味採用・任意記憶変更の入口ではない。 */
export function resultObservation(p: Plan, b: Binding) {
  const result = p.results.find((r) => r.step_id === b.step_id);
  if (b.operation === "github.write" && resultMemoryEligible(b)) {
    const summary = b.github_write_result;
    const effectObservation = b.status === "verified" ? "reported_success"
      : b.status === "provider_rejected" ? "reported_rejection" : "unknown";
    return {
      schema_version: "github-write-outcome-observation.v1", record_type: "github_write_outcome_observation",
      task_identity_digest: b.execution_admission!.task_identity_digest!,
      plan_id_digest: createHash("sha256").update(JSON.stringify(p.revisions[0]!.plan.plan_id), "utf8").digest("hex"),
      plan_revision_digest: b.revision_digest,
      step_id_digest: createHash("sha256").update(JSON.stringify(b.step_id), "utf8").digest("hex"),
      step_digest: b.step_digest,
      operation: b.operation,
      plan_binding_status: b.status,
      command_digest: b.command_digest,
      operation_plan_binding_digest: b.operation_plan_binding_digest ?? null,
      target_identity_digest: summary?.target_identity_digest ?? null,
      request_payload_digest: summary?.request_payload_digest ?? null,
      provider_result_digest: summary?.provider_result_digest ?? null,
      provider_mutation_status: summary?.mutation_status ?? null,
      provider_http_status: summary?.http_status ?? null,
      delivery_digest: b.delivery_digest!,
      result_digest: b.result_digest!,
      observed_at_ms: b.result_observed_at_ms ?? null,
      effect_observation: effectObservation,
      adoption_status: "observation_only",
      used_as_world_truth: false,
      used_for_authority: false,
      may_execute: false,
    };
  }
  if (b.status === "outcome_unknown" && b.execution_admission && b.delivery_digest && b.result_digest) {
    return {
      schema_version: "operation-action-outcome.v1", record_type: "action_outcome_observation",
      plan_revision_digest: b.revision_digest, step_review_request_id: b.request_id,
      command_id: b.command_id, upstream_commit_hash: b.commit_hash, operation: b.operation,
      delivery_digest: b.delivery_digest, result_digest: b.result_digest,
      plan_binding_status: "outcome_unknown", effect_observation: "unknown",
      adoption_status: "observation_only", used_as_world_truth: false,
      used_for_authority: false, may_execute: false,
    };
  }
  if (b.status !== "verified" || !b.execution_admission || !b.delivery_digest || !b.result_digest ||
      !result) throw new Error("plan_memory_observation_not_eligible");
  if (b.operation === "file.write" || b.operation === "file.delete" || b.operation === "file.edit") {
    return {
      schema_version: "operation-action-result.v1", record_type: "action_result_observation",
      plan_revision_digest: b.revision_digest, step_review_request_id: b.request_id,
      command_id: b.command_id, upstream_commit_hash: b.commit_hash, operation: b.operation,
      delivery_digest: b.delivery_digest, result_digest: b.result_digest,
      plan_binding_status: "verified", plan_validation_status: "matched",
      effect_observation: "reported_success", observed_at_ms: result.observed_at_ms,
      adoption_status: "observation_only", used_as_world_truth: false,
      used_for_authority: false, may_execute: false,
    };
  }
  if (b.operation === "gmail.write" && b.prepared_step.operation === "gmail.write" &&
      b.prepared_step.parameters?.operation === "message.send") {
    const rawOutput: unknown = result.output;
    if (!isRecord(rawOutput) || !isRecord(rawOutput.result)) {
      throw new Error("plan_memory_gmail_message_send_result_invalid");
    }
    const output = rawOutput;
    const receipt = rawOutput.result;
    const validation = b.prepared_step.preparation?.validation ?? [];
    const expected = validation.length === 1 && isRecord(validation[0]?.expected) ? validation[0]!.expected : undefined;
    const resultKeys = ["account_identity_digest", "label_ids_digest", "may_execute", "provider_state_digest",
      "request_payload_digest", "sent_confirmed", "sent_label_confirmed", "sent_message_identity_digest",
      "target_identity_digest", "thread_identity_digest", "used_for_authority"];
    const outputKeys = ["api_host", "method", "mode", "mutation_sent", "mutation_status", "operation", "path_digest",
      "request_status", "result", "result_digest", "service", "status", "truncated"];
    if (!expected || expected.schema_version !== "blue-tanuki.gmail-message-send-result-validation.v1" ||
        expected.operation !== "message.send" || !hasExactKeys(receipt, resultKeys) ||
        !hasExactKeys(output, outputKeys, ["content_type", "google_request_id"]) ||
        !isDigest(receipt.account_identity_digest) || !isDigest(receipt.label_ids_digest) ||
        !isDigest(receipt.provider_state_digest) || !isDigest(receipt.request_payload_digest) ||
        !isDigest(receipt.sent_message_identity_digest) || !isDigest(receipt.target_identity_digest) ||
        !isDigest(receipt.thread_identity_digest) ||
        receipt.target_identity_digest !== expected.target_identity_digest ||
        receipt.request_payload_digest !== expected.request_payload_digest ||
        receipt.sent_confirmed !== true || receipt.sent_label_confirmed !== true ||
        receipt.used_for_authority !== false || receipt.may_execute !== false ||
        output.service !== "gmail" || output.mode !== "write" || output.operation !== "message.send" ||
        output.api_host !== "gmail.googleapis.com" || output.method !== "POST" ||
        output.path_digest !== stableDigest("/gmail/v1/users/me/messages/send") || output.request_status !== "ok" ||
        output.mutation_sent !== true || output.mutation_status !== "confirmed" ||
        typeof output.status !== "number" || !Number.isInteger(output.status) || output.status < 200 || output.status >= 300 ||
        output.truncated !== false || !isDigest(output.result_digest) || output.result_digest !== stableDigest(receipt) ||
        (output.content_type !== undefined && typeof output.content_type !== "string") ||
        (output.google_request_id !== undefined && typeof output.google_request_id !== "string")) {
      throw new Error("plan_memory_gmail_message_send_result_invalid");
    }
    return {
      schema_version: "operation-action-result.v1", record_type: "action_result_observation",
      task_identity_digest: b.execution_admission?.task_identity_digest,
      plan_id_digest: createHash("sha256").update(JSON.stringify(p.revisions[0]!.plan.plan_id), "utf8").digest("hex"),
      plan_revision_digest: b.revision_digest, step_review_request_id: b.request_id,
      command_id: b.command_id, upstream_commit_hash: b.commit_hash, operation: "gmail.write.message.send",
      step_id_digest: createHash("sha256").update(JSON.stringify(b.step_id), "utf8").digest("hex"),
      step_digest: b.step_digest, command_digest: b.command_digest,
      operation_plan_binding_digest: b.operation_plan_binding_digest!,
      delivery_digest: b.delivery_digest!, result_digest: b.result_digest!,
      plan_binding_status: "verified", plan_validation_status: "matched",
      target_identity_digest: receipt.target_identity_digest,
      provider_state_digest: receipt.provider_state_digest,
      effect_observation: "reported_success", observed_at_ms: result.observed_at_ms,
      adoption_status: "observation_only", used_as_world_truth: false,
      used_for_authority: false, may_execute: false,
    };
  }
  if (b.operation === "gmail.write" && b.prepared_step.operation === "gmail.write" &&
      b.prepared_step.parameters?.operation === "draft.send") {
    const rawOutput: unknown = result.output;
    if (!isRecord(rawOutput) || !isRecord(rawOutput.result)) {
      throw new Error("plan_memory_gmail_draft_send_result_invalid");
    }
    const output = rawOutput;
    const receipt = rawOutput.result;
    const draftId = b.prepared_step.parameters.draft_id;
    const draftIdentityDigest = typeof draftId === "string"
      ? createHash("sha256").update(draftId, "utf8").digest("hex") : "";
    const targetIdentityDigest = stableDigest({ schema_version: "blue-tanuki.gmail-write-target-identity.v3",
      service: "gmail", operation: "draft.send", draft_id: draftId });
    const resultKeys = ["account_identity_digest", "draft_identity_digest", "draft_message_identity_digest",
      "draft_provider_state_digest", "label_ids_digest", "may_execute", "provider_raw_digest",
      "provider_state_digest", "request_payload_digest", "sent_confirmed", "sent_label_confirmed",
      "sent_message_identity_digest", "target_identity_digest", "thread_identity_digest", "used_for_authority"];
    const outputKeys = ["api_host", "method", "mode", "mutation_sent",
      "mutation_status", "operation", "path_digest", "request_status", "result", "result_digest", "service",
      "status", "truncated"];
    const providerRawDigest = receipt.provider_raw_digest;
    const threadIdentityDigest = receipt.thread_identity_digest;
    const accountIdentityDigest = receipt.account_identity_digest;
    const messageIdentityDigest = receipt.draft_message_identity_digest;
    const expectedRequestDigest = typeof draftId === "string" && isDigest(providerRawDigest) && isDigest(threadIdentityDigest)
      ? stableDigest({ schema_version: "blue-tanuki.gmail-draft-send-payload.v2", draft_id: draftId,
        provider_raw_digest: providerRawDigest, thread_identity_digest: threadIdentityDigest }) : "";
    const expectedDraftStateDigest = isDigest(accountIdentityDigest) && isDigest(messageIdentityDigest) &&
        isDigest(threadIdentityDigest) && isDigest(providerRawDigest)
      ? stableDigest({ schema_version: "blue-tanuki.gmail-draft-provider-state.v2",
        account_identity_digest: accountIdentityDigest, draft_identity_digest: draftIdentityDigest,
        message_identity_digest: messageIdentityDigest, thread_identity_digest: threadIdentityDigest,
        raw_digest: providerRawDigest }) : "";
    const expectedPath = "/gmail/v1/users/me/drafts/send";
    if (typeof draftId !== "string" || !draftId.trim() || draftId !== draftId.trim() || draftId.length > 256 ||
        /[\r\n]/.test(draftId) || !hasExactKeys(receipt, resultKeys) ||
        !hasExactKeys(output, outputKeys, ["content_type", "google_request_id"]) ||
        receipt.target_identity_digest !== targetIdentityDigest || receipt.draft_identity_digest !== draftIdentityDigest ||
        !isDigest(accountIdentityDigest) || !isDigest(messageIdentityDigest) || !isDigest(providerRawDigest) ||
        !isDigest(threadIdentityDigest) || receipt.request_payload_digest !== expectedRequestDigest ||
        receipt.draft_provider_state_digest !== expectedDraftStateDigest ||
        !isDigest(receipt.sent_message_identity_digest) || !isDigest(receipt.label_ids_digest) ||
        !isDigest(receipt.provider_state_digest) || receipt.sent_label_confirmed !== true || receipt.sent_confirmed !== true ||
        receipt.used_for_authority !== false || receipt.may_execute !== false ||
        output.service !== "gmail" || output.mode !== "write" || output.operation !== "draft.send" ||
        output.api_host !== "gmail.googleapis.com" || output.method !== "POST" ||
        output.path_digest !== stableDigest(expectedPath) || output.request_status !== "ok" ||
        output.mutation_sent !== true || output.mutation_status !== "confirmed" ||
        typeof output.status !== "number" || !Number.isInteger(output.status) || output.status < 200 || output.status >= 300 ||
        output.truncated !== false || !isDigest(output.result_digest) || output.result_digest !== stableDigest(receipt) ||
        (output.content_type !== undefined && typeof output.content_type !== "string") ||
        (output.google_request_id !== undefined && typeof output.google_request_id !== "string")) {
      throw new Error("plan_memory_gmail_draft_send_result_invalid");
    }
    return {
      schema_version: "operation-action-result.v1", record_type: "action_result_observation",
      task_identity_digest: b.execution_admission?.task_identity_digest,
      plan_id_digest: createHash("sha256").update(JSON.stringify(p.revisions[0]!.plan.plan_id), "utf8").digest("hex"),
      plan_revision_digest: b.revision_digest, step_review_request_id: b.request_id,
      command_id: b.command_id, upstream_commit_hash: b.commit_hash, operation: "gmail.write.draft.send",
      step_id_digest: createHash("sha256").update(JSON.stringify(b.step_id), "utf8").digest("hex"),
      step_digest: b.step_digest, command_digest: b.command_digest,
      operation_plan_binding_digest: b.operation_plan_binding_digest!,
      delivery_digest: b.delivery_digest!, result_digest: b.result_digest!,
      plan_binding_status: "verified", plan_validation_status: "matched",
      target_identity_digest: receipt.target_identity_digest,
      provider_state_digest: receipt.provider_state_digest,
      effect_observation: "reported_success", observed_at_ms: result.observed_at_ms,
      adoption_status: "observation_only", used_as_world_truth: false,
      used_for_authority: false, may_execute: false,
    };
  }
  if (b.operation === "gmail.write" && b.prepared_step.operation === "gmail.write" &&
      b.prepared_step.parameters?.operation === "draft.create" &&
      typeof b.prepared_step.parameters.reply_to_message_id === "string") {
    if (!result) throw new Error("plan_memory_gmail_reply_draft_result_invalid");
    const rawOutput: unknown = result.output;
    if (!isRecord(rawOutput) || !isRecord(rawOutput.result)) {
      throw new Error("plan_memory_gmail_reply_draft_result_invalid");
    }
    const output = rawOutput;
    const receipt = rawOutput.result;
    const validation = b.prepared_step.preparation?.validation ?? [];
    const expected = validation.length === 1 && isRecord(validation[0]?.expected) ? validation[0]!.expected : undefined;
    const resultKeys = ["account_identity_digest", "created_draft_identity_digest", "created_message_identity_digest",
      "draft_readback_confirmed", "label_ids_digest", "may_execute", "provider_state_digest", "request_payload_digest",
      "source_message_identity_digest", "source_thread_identity_digest", "target_identity_digest", "thread_confirmed",
      "used_for_authority"];
    const outputKeys = ["api_host", "content_type", "google_request_id", "method", "mode", "mutation_sent",
      "mutation_status", "operation", "path_digest", "request_status", "result", "result_digest", "service",
      "status", "truncated"];
    const sourceMessageIdentityDigest = createHash("sha256")
      .update(b.prepared_step.parameters.reply_to_message_id, "utf8").digest("hex");
    const providerStateDigest = isDigest(receipt.account_identity_digest) &&
        isDigest(receipt.source_thread_identity_digest) && isDigest(receipt.created_draft_identity_digest) &&
        isDigest(receipt.created_message_identity_digest) && isDigest(receipt.label_ids_digest)
      ? stableDigest({ schema_version: "blue-tanuki.gmail-reply-draft-provider-state.v2",
        account_identity_digest: receipt.account_identity_digest,
        source_message_identity_digest: sourceMessageIdentityDigest,
        source_thread_identity_digest: receipt.source_thread_identity_digest,
        created_draft_identity_digest: receipt.created_draft_identity_digest,
        created_message_identity_digest: receipt.created_message_identity_digest,
        label_ids_digest: receipt.label_ids_digest }) : "";
    if (!expected || expected.schema_version !== "blue-tanuki.gmail-reply-draft-result-validation.v2" ||
        expected.operation !== "draft.create" || validation[0]?.method !== "gmail_reply_draft_result_matches" ||
        !hasExactKeys(receipt, resultKeys) || !hasExactKeys(output, outputKeys) ||
        !isDigest(receipt.account_identity_digest) || !isDigest(receipt.created_draft_identity_digest) ||
        !isDigest(receipt.created_message_identity_digest) || !isDigest(receipt.label_ids_digest) ||
        !isDigest(receipt.provider_state_digest) || receipt.provider_state_digest !== providerStateDigest ||
        !isDigest(receipt.request_payload_digest) || receipt.source_message_identity_digest !== sourceMessageIdentityDigest ||
        !isDigest(receipt.source_thread_identity_digest) || !isDigest(receipt.target_identity_digest) ||
        receipt.draft_readback_confirmed !== true || receipt.thread_confirmed !== true ||
        receipt.used_for_authority !== false || receipt.may_execute !== false ||
        output.service !== "gmail" || output.mode !== "write" || output.operation !== "draft.create" ||
        output.api_host !== "gmail.googleapis.com" || output.method !== "POST" ||
        output.path_digest !== stableDigest("/gmail/v1/users/me/drafts") || output.request_status !== "ok" ||
        output.mutation_sent !== true || output.mutation_status !== "confirmed" ||
        typeof output.status !== "number" || !Number.isInteger(output.status) || output.status < 200 || output.status >= 300 ||
        output.truncated !== false || !isDigest(output.result_digest) || output.result_digest !== stableDigest(receipt) ||
        (output.content_type !== null && typeof output.content_type !== "string") ||
        (output.google_request_id !== null && typeof output.google_request_id !== "string")) {
      throw new Error("plan_memory_gmail_reply_draft_result_invalid");
    }
    return {
      schema_version: "operation-action-result.v1", record_type: "action_result_observation",
      task_identity_digest: b.execution_admission?.task_identity_digest,
      plan_id_digest: createHash("sha256").update(JSON.stringify(p.revisions[0]!.plan.plan_id), "utf8").digest("hex"),
      plan_revision_digest: b.revision_digest, step_review_request_id: b.request_id,
      command_id: b.command_id, upstream_commit_hash: b.commit_hash, operation: "gmail.write.draft.create",
      step_id_digest: createHash("sha256").update(JSON.stringify(b.step_id), "utf8").digest("hex"),
      step_digest: b.step_digest, command_digest: b.command_digest,
      operation_plan_binding_digest: b.operation_plan_binding_digest!,
      delivery_digest: b.delivery_digest!, result_digest: b.result_digest!,
      plan_binding_status: "verified", plan_validation_status: "matched",
      account_identity_digest: receipt.account_identity_digest,
      source_message_identity_digest: receipt.source_message_identity_digest,
      source_thread_identity_digest: receipt.source_thread_identity_digest,
      created_draft_identity_digest: receipt.created_draft_identity_digest,
      created_message_identity_digest: receipt.created_message_identity_digest,
      label_ids_digest: receipt.label_ids_digest,
      target_identity_digest: receipt.target_identity_digest,
      request_payload_digest: receipt.request_payload_digest,
      provider_state_digest: receipt.provider_state_digest,
      draft_readback_confirmed: true, thread_confirmed: true,
      effect_observation: "reported_success", observed_at_ms: result.observed_at_ms,
      adoption_status: "observation_only", used_as_world_truth: false,
      used_for_authority: false, may_execute: false,
    };
  }
  if (b.operation === "gmail.write" && b.prepared_step.operation === "gmail.write" &&
      b.prepared_step.parameters?.operation === "message.trash") {
    const rawOutput: unknown = result.output;
    if (!isRecord(rawOutput)) {
      throw new Error("plan_memory_gmail_message_trash_result_invalid");
    }
    const rawReceipt = rawOutput.result;
    if (!isRecord(rawReceipt)) throw new Error("plan_memory_gmail_message_trash_result_invalid");
    const output = rawOutput;
    const receipt = rawReceipt;
    const messageId = b.prepared_step.parameters.message_id;
    const messageIdentityDigest = typeof messageId === "string"
      ? createHash("sha256").update(messageId, "utf8").digest("hex") : "";
    const targetIdentityDigest = stableDigest({ schema_version: "blue-tanuki.gmail-write-target-identity.v5",
      service: "gmail", operation: "message.trash", message_identity_digest: messageIdentityDigest });
    const resultKeys = ["label_ids_digest", "may_execute", "message_identity_digest", "provider_state_digest",
      "target_identity_digest", "thread_identity_digest", "trash_confirmed", "used_for_authority"];
    const outputKeys = ["api_host", "method", "mode", "mutation_sent", "mutation_status", "operation", "path_digest",
      "request_status", "result", "result_digest", "service", "status", "truncated"];
    if (typeof messageId !== "string" || messageId.length === 0 || !messageIdentityDigest ||
        !hasExactKeys(receipt, resultKeys) || !hasExactKeys(output, outputKeys,
      ["content_type", "google_request_id"]) ||
        receipt.message_identity_digest !== messageIdentityDigest || receipt.target_identity_digest !== targetIdentityDigest ||
        !isDigest(receipt.thread_identity_digest) || !isDigest(receipt.label_ids_digest) ||
        !isDigest(receipt.provider_state_digest) || receipt.trash_confirmed !== true ||
        receipt.used_for_authority !== false || receipt.may_execute !== false ||
        output.service !== "gmail" || output.mode !== "write" || output.operation !== "message.trash" ||
        output.api_host !== "gmail.googleapis.com" || output.method !== "POST" ||
        output.path_digest !== stableDigest(`/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/trash`) ||
        output.request_status !== "ok" || output.mutation_sent !== true || output.mutation_status !== "confirmed" ||
        typeof output.status !== "number" || !Number.isInteger(output.status) || output.status < 200 || output.status >= 300 ||
        output.truncated !== false || !isDigest(output.result_digest) || output.result_digest !== stableDigest(receipt) ||
        (output.content_type !== undefined && typeof output.content_type !== "string") ||
        (output.google_request_id !== undefined && typeof output.google_request_id !== "string")) {
      throw new Error("plan_memory_gmail_message_trash_result_invalid");
    }
    return {
      schema_version: "operation-action-result.v1", record_type: "action_result_observation",
      task_identity_digest: b.execution_admission?.task_identity_digest,
      plan_id_digest: createHash("sha256").update(JSON.stringify(p.revisions[0]!.plan.plan_id), "utf8").digest("hex"),
      plan_revision_digest: b.revision_digest, step_review_request_id: b.request_id,
      command_id: b.command_id, upstream_commit_hash: b.commit_hash, operation: "gmail.write.message.trash",
      step_id_digest: createHash("sha256").update(JSON.stringify(b.step_id), "utf8").digest("hex"),
      step_digest: b.step_digest, command_digest: b.command_digest,
      operation_plan_binding_digest: b.operation_plan_binding_digest!,
      delivery_digest: b.delivery_digest!, result_digest: b.result_digest!,
      plan_binding_status: "verified", plan_validation_status: "matched",
      target_identity_digest: receipt.target_identity_digest,
      provider_state_digest: receipt.provider_state_digest,
      effect_observation: "reported_success", observed_at_ms: result.observed_at_ms,
      adoption_status: "observation_only", used_as_world_truth: false,
      used_for_authority: false, may_execute: false,
    };
  }
  if (b.operation === "gmail.write" && b.prepared_step.operation === "gmail.write" &&
      b.prepared_step.parameters?.operation === "message.modify") {
    const rawOutput: unknown = result.output;
    if (!isRecord(rawOutput)) throw new Error("plan_memory_gmail_message_modify_result_invalid");
    const rawReceipt = rawOutput.result;
    if (!isRecord(rawReceipt)) throw new Error("plan_memory_gmail_message_modify_result_invalid");
    const output = rawOutput;
    const receipt = rawReceipt;
    const parameters = b.prepared_step.parameters;
    const messageId = parameters.message_id;
    const labels = (value: unknown): string[] | undefined => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 20 || value.some((label) => typeof label !== "string" ||
          label.length === 0 || label.length > 256 || !/^[A-Za-z0-9_-]+$/.test(label))) return undefined;
      return new Set(value).size === value.length ? [...value as string[]].sort() : undefined;
    };
    const addLabelIds = labels(parameters.add_label_ids);
    const removeLabelIds = labels(parameters.remove_label_ids);
    const messageIdentityDigest = typeof messageId === "string"
      ? createHash("sha256").update(messageId, "utf8").digest("hex") : "";
    const targetIdentityDigest = stableDigest({ schema_version: "blue-tanuki.gmail-write-target-identity.v6",
      service: "gmail", operation: "message.modify", message_identity_digest: messageIdentityDigest });
    const resultKeys = ["added_label_ids_digest", "label_ids_digest", "labels_confirmed", "may_execute",
      "message_identity_digest", "provider_state_digest", "removed_label_ids_digest", "target_identity_digest",
      "thread_identity_digest", "used_for_authority"];
    const outputKeys = ["api_host", "method", "mode", "mutation_sent", "mutation_status", "operation", "path_digest",
      "request_status", "result", "result_digest", "service", "status", "truncated"];
    const expectedPath = typeof messageId === "string"
      ? `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify` : "";
    if (typeof messageId !== "string" || messageId.length === 0 || !addLabelIds || !removeLabelIds ||
        (addLabelIds.length === 0 && removeLabelIds.length === 0) ||
        addLabelIds.some((label) => removeLabelIds.includes(label)) ||
        !hasExactKeys(receipt, resultKeys) || !hasExactKeys(output, outputKeys, ["content_type", "google_request_id"]) ||
        receipt.message_identity_digest !== messageIdentityDigest || receipt.target_identity_digest !== targetIdentityDigest ||
        receipt.added_label_ids_digest !== stableDigest(addLabelIds) || receipt.removed_label_ids_digest !== stableDigest(removeLabelIds) ||
        !isDigest(receipt.label_ids_digest) || !isDigest(receipt.thread_identity_digest) ||
        !isDigest(receipt.provider_state_digest) || receipt.labels_confirmed !== true ||
        receipt.used_for_authority !== false || receipt.may_execute !== false ||
        output.service !== "gmail" || output.mode !== "write" || output.operation !== "message.modify" ||
        output.api_host !== "gmail.googleapis.com" || output.method !== "POST" ||
        output.path_digest !== stableDigest(expectedPath) || output.request_status !== "ok" || output.mutation_sent !== true ||
        output.mutation_status !== "confirmed" || typeof output.status !== "number" || !Number.isInteger(output.status) ||
        output.status < 200 || output.status >= 300 || output.truncated !== false || !isDigest(output.result_digest) ||
        output.result_digest !== stableDigest(receipt) ||
        (output.content_type !== undefined && typeof output.content_type !== "string") ||
        (output.google_request_id !== undefined && typeof output.google_request_id !== "string")) {
      throw new Error("plan_memory_gmail_message_modify_result_invalid");
    }
    return {
      schema_version: "operation-action-result.v1", record_type: "action_result_observation",
      task_identity_digest: b.execution_admission?.task_identity_digest,
      plan_id_digest: createHash("sha256").update(JSON.stringify(p.revisions[0]!.plan.plan_id), "utf8").digest("hex"),
      plan_revision_digest: b.revision_digest, step_review_request_id: b.request_id,
      command_id: b.command_id, upstream_commit_hash: b.commit_hash, operation: "gmail.write.message.modify",
      step_id_digest: createHash("sha256").update(JSON.stringify(b.step_id), "utf8").digest("hex"),
      step_digest: b.step_digest, command_digest: b.command_digest,
      operation_plan_binding_digest: b.operation_plan_binding_digest!,
      delivery_digest: b.delivery_digest!, result_digest: b.result_digest!,
      plan_binding_status: "verified", plan_validation_status: "matched",
      target_identity_digest: receipt.target_identity_digest,
      provider_state_digest: receipt.provider_state_digest,
      effect_observation: "reported_success", observed_at_ms: result.observed_at_ms,
      adoption_status: "observation_only", used_as_world_truth: false,
      used_for_authority: false, may_execute: false,
    };
  }
  if (b.operation === "browser.read") {
    if (!result) throw new Error("plan_memory_observation_not_eligible");
    return browserReadResultObservation(p, b, result);
  }
  if (b.operation !== "file.search") throw new Error("plan_memory_observation_not_eligible");
  return {
    schema_version: "operation-result-observation.v1", record_type: "action_observation",
    plan_revision_digest: b.revision_digest, step_review_request_id: b.request_id,
    command_id: b.command_id, upstream_commit_hash: b.commit_hash,
    delivery_digest: b.delivery_digest, result_digest: b.result_digest,
    output_digest: createHash("sha256").update(JSON.stringify(result.output)).digest("hex"),
    result, adoption_status: "observation_only", used_as_world_truth: false,
    used_for_authority: false, may_execute: false,
  };
}

export function resultMemoryIdentity(b: Binding) {
  const id = createHash("sha256").update(JSON.stringify(["plan-result-memory.v1", b.command_id, b.delivery_digest])).digest("hex");
  return { update_id: `result-update:${id}`, j_event_id: `result-observation:${id}`, record_id: `result-observation:${id}` };
}

export function buildResultMemoryCommit(p: Plan, b: Binding, expected_version: number): MemoryCommitV2 {
  const id = resultMemoryIdentity(b);
  const content = { schema_version: MEMORY_COMMIT_V2_SCHEMA_VERSION, expected_version,
    update_id: id.update_id, j_event_id: id.j_event_id,
    changes: [{ operation: "upsert" as const, record_id: id.record_id,
      value: resultObservation(p, b) as unknown as MemoryCommitJsonValue }],
  };
  return { ...content, content_digest: memoryCommitContentDigest(content) };
}

export function verifyResultMemoryCommit(p: Plan, b: Binding): boolean {
  if (!b.memory_commit) return false;
  const parsed = parseMemoryCommitV2(b.memory_commit);
  if (!parsed.ok) return false;
  return parsed.content_digest === buildResultMemoryCommit(p, b, parsed.commit.expected_version).content_digest;
}

export function receiptForResultCommit(receipt: MemoryUpdateReceiptV1, commit: MemoryCommitV2): boolean {
  const parsed = parseMemoryUpdateReceipt(receipt);
  return parsed.ok && parsed.receipt.update_id === commit.update_id &&
    parsed.receipt.content_digest === commit.content_digest && parsed.receipt.previous_revision === commit.expected_version;
}

/** A direct shell result is retained as a digest-only report, never as authority or world truth. */
export function shellExecResultMemoryObservation(observation: ShellExecObservation) {
  return {
    schema_version: "shell-exec-result-observation.v1",
    record_type: "shell_exec_result_observation",
    command_id_digest: observation.command_id_digest,
    request_id_digest: observation.request_id_digest,
    upstream_commit_hash_digest: observation.upstream_commit_hash_digest,
    command_payload_digest: observation.command_payload_digest,
    result_id_digest: observation.result_id_digest,
    result_contract_digest: observation.result_contract_digest,
    result_digest: observation.result_digest,
    execution_status: observation.execution_status,
    execution_boundary: observation.execution_boundary,
    action_outcome: observation.action_outcome,
    plan_step_binding: observation.plan_step_binding,
    observed_at_ms: observation.observed_at_ms,
    adoption_status: "observation_only",
    used_as_world_truth: false,
    used_for_authority: false,
    may_execute: false,
  } as const;
}

export function shellExecResultMemoryIdentity(observation: ShellExecObservation) {
  const id = createHash("sha256").update(JSON.stringify([
    "shell-exec-result-memory.v1", observation.command_id_digest, observation.result_contract_digest,
  ])).digest("hex");
  return { update_id: `shell-result-update:${id}`, j_event_id: `shell-result-observation:${id}`,
    record_id: `shell-result-observation:${id}` };
}

export function buildShellExecResultMemoryCommit(observation: ShellExecObservation, expected_version: number): MemoryCommitV2 {
  const id = shellExecResultMemoryIdentity(observation);
  const content = { schema_version: MEMORY_COMMIT_V2_SCHEMA_VERSION, expected_version,
    update_id: id.update_id, j_event_id: id.j_event_id,
    changes: [{ operation: "upsert" as const, record_id: id.record_id,
      value: shellExecResultMemoryObservation(observation) as unknown as MemoryCommitJsonValue }],
  };
  return { ...content, content_digest: memoryCommitContentDigest(content) };
}

export function verifyShellExecResultMemoryCommit(observation: ShellExecObservation): boolean {
  if (!observation.memory_commit) return false;
  const parsed = parseMemoryCommitV2(observation.memory_commit);
  if (!parsed.ok) return false;
  return parsed.content_digest === buildShellExecResultMemoryCommit(observation,
    parsed.commit.expected_version).content_digest;
}
