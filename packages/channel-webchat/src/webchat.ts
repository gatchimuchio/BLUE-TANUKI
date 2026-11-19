import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import * as path from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { TLSSocket } from "node:tls";
import { URL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  createGatewayInternalInboundRequest,
  GoalCompletionRulesSchema,
  D4RuntimeNotificationsProjectionSchema,
  D4RuntimeStatusProjectionSchema,
  InboundRequestSchema,
  OperationPlanControlSchema,
  RuntimeIntentInputSchema,
  RuntimeIntentStatusInputSchema,
  RuntimeSessionInputSchema,
  SETTINGS_WRITE_ACTIVATION_DESTINATIONS,
  SETTINGS_WRITE_CREDENTIAL_ROTATION_CHANGE,
  SettingsWriteActivationSchema,
  SettingsWriteArgumentsSchema,
  SettingsWriteLlmProviderSchema,
  SettingsWriteNativeLlmProviderSchema,
  settingsWriteCredentialRotationReview,
  settingsWriteRequiresNativeCredentialEntry,
  detectTransientAudioFormat,
  detectTransientImageMediaType,
  isCanonicalBase64,
  TRANSIENT_AUDIO_MAX_BYTES,
  TRANSIENT_IMAGE_MAX_BYTES,
  TRANSIENT_CANVAS_ARTIFACT_MAX_BYTES,
  type GoalCompletionRules,
  type D4RuntimeNotificationCategory,
  type D4RuntimeNotificationsProjection,
  type InboundRequest,
  type TransientAudioInput,
  type TransientImageInput,
  type TransientCanvasArtifactInput,
  type ChannelSendPayload,
} from "@blue-tanuki/protocol";
import {
  TokenBucket,
  type InboundChannel,
  type InboundEphemeralContext,
  type InboundHandler,
  type OutboundChannel,
  type SendContext,
  type SendMeta,
  type SendResult,
} from "@blue-tanuki/channel-base";
import {
  MemoryTicketStore,
  type TicketStore,
} from "./ticket_store.js";
import {
  MemoryResumeApprovalTokenStore,
  type ResumeApprovalTokenIssued,
  type ResumeApprovalTokenStore,
} from "./resume_approval_token_store.js";
import { renderControlCenterHtml } from "./control_center_html.js";
import {
  AOTANU_ASSET_FILENAMES,
  AOTANU_ASSET_ROUTE_PREFIX,
} from "./aotanu_mascot.js";
import {
  readApprovalControlContext,
  readEvidenceControlContext,
  readHistoryReplayFilter,
  readJson,
  readResumeApprovalOptions,
  readWebhookContent,
  nonEmptyString,
  sanitizeHistorySnapshot,
} from "./webchat_request_helpers.js";

import { MAX_OWNER_TASK_PLAN_STEPS } from "./webchat_types.js";
import type {
  WebChatTaskExecutionObservation,
  WebChatOwnerTaskPlanStep,
  WebChatOwnerTaskPlanSteps,
  WebChatAboutSurface,
  WebChatTaskOutcome,
  WebChatTaskApprovalWithdrawal,
  WebChatD4RuntimeBeforeDecisionCancellation,
  WebChatD4RuntimeCancellationStatus,
  WebChatOwnerTaskCancellation,
  WebChatOwnerTaskWaitCancellation,
  WebChatOwnerTaskWaitPending,
  WebChatApprovalContentReview,
  WebChatApprovalGrantItem,
  WebChatApprovalHistoryItem,
  WebChatApprovalQueueItem,
  WebChatApprovalContentReviewValidation,
  WebChatApprovalSurface,
  WebChatDailyBriefReadContentReview,
  WebChatDailyBriefReadResult,
  WebChatDailyBriefReadService,
  WebChatAuditSurface,
  WebChatAuthoritySurface,
  WebChatAuthorityTraceItem,
  WebChatEmergencyStopSnapshot,
  WebChatEvidenceSurface,
  WebChatHistorySurface,
  WebChatNotificationItem,
  WebChatNotificationKind,
  WebChatNotificationSeverity,
  WebChatNotificationSurface,
  WebChatOperatorSurface,
  WebChatOperatorSurfaces,
  WebChatOwnerTaskSubmissionStore,
  WebChatWebhookEventClaim,
  WebChatOptions,
  WebChatRateLimits,
  WebChatGoalPurposeRepairRequest,
  WebChatGoalPurposeRepairStore,
  WebChatRecoverySurface,
  WebChatResumeContext,
  WebChatRuntimeSurface,
  WebChatRuntimeResultReconciliation,
  WebChatSettingsWriteContentReview,
  WebChatSettingsSurface,
  WebChatUpdateSurface,
} from "./webchat_types.js";
const DEFAULT_RATE_LIMITS: Required<WebChatRateLimits> = {
  inbound: { capacity: 10, refill_per_sec: 1.0 },
  resume: { capacity: 5, refill_per_sec: 0.5 },
  ws_ticket: { capacity: 3, refill_per_sec: 10 / 60 },
};
const INBOUND_TOKEN_ACTOR = "webchat-inbound-token-holder";
const WEBHOOK_TOKEN_ACTOR = "webchat-webhook-token-holder";
const WEBHOOK_EVENT_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const WEBHOOK_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u;
const WEBHOOK_EVENT_MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const RESUME_TOKEN_ACTOR = "webchat-resume-token-holder";

const D4_RUNTIME_NOTIFICATION_CATEGORY_BY_KIND: Record<
  Exclude<WebChatNotificationKind, "owner_saved_result_ready">,
  D4RuntimeNotificationCategory
> = {
  approval_required: "owner_attention",
  approval_interrupted: "interrupted_work",
  operation_outcome_unknown: "outcome_unknown",
  schedule_fired: "scheduled_activity",
  schedule_delivery_unknown: "outcome_unknown",
  cron_recovery_state_unavailable: "recovery_unavailable",
  schedule_failed: "service_issue",
  connector_failure: "service_issue",
  audit_warning: "audit_integrity_issue",
};
const OWNER_TOKEN_ACTOR = "webchat-owner-token-holder";
const D4_RUNTIME_TOKEN_ACTOR = "d4-runtime-adapter-token-holder";
const MAX_MULTIMODAL_TASK_JSON_BYTES = Math.ceil((TRANSIENT_IMAGE_MAX_BYTES + TRANSIENT_AUDIO_MAX_BYTES) / 3) * 4 + 256 * 1024;
const MAX_OWNER_AUDIO_TRANSCRIPTION_JSON_BYTES = Math.ceil(TRANSIENT_AUDIO_MAX_BYTES / 3) * 4 + 256 * 1024;
const CONTROL_CENTER_LAUNCH_HANDOFF_TTL_MS = 30_000;
const WEBSOCKET_SEND_CALLBACK_TIMEOUT_MS = 5_000;
const CONTROL_CENTER_LAUNCH_HANDOFF_CAP = 32;

interface ControlCenterLaunchHandoff {
  readonly expires_at: number;
  readonly tokens: {
    readonly webchat: string;
    readonly resume?: string;
    readonly owner?: string;
    readonly settings?: string;
    readonly maintenance?: string;
  };
}

function isLoopbackClientAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function loopbackRequestOrigin(req: IncomingMessage, requireOrigin: boolean): boolean {
  const host = req.headers.host;
  if (typeof host !== "string" || !host || host.length > 255) return false;
  const protocol = req.socket instanceof TLSSocket ? "https" : "http";
  let hostUrl: URL;
  try {
    hostUrl = new URL(`${protocol}://${host}`);
  } catch {
    return false;
  }
  const hostname = hostUrl.hostname.toLowerCase();
  if (hostUrl.username || hostUrl.password || hostUrl.pathname !== "/" || hostUrl.search || hostUrl.hash ||
      !["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return false;
  const effectivePort = hostUrl.port ? Number(hostUrl.port) : protocol === "https" ? 443 : 80;
  if (effectivePort !== (req.socket.localPort ?? effectivePort)) return false;

  const origin = req.headers.origin;
  if (origin === undefined) return !requireOrigin;
  if (typeof origin !== "string") return false;
  try {
    const originUrl = new URL(origin);
    return originUrl.origin === hostUrl.origin && originUrl.username === "" && originUrl.password === "" &&
      originUrl.pathname === "/" && !originUrl.search && !originUrl.hash;
  } catch {
    return false;
  }
}

function isLocalControlCenterBrowserRequest(req: IncomingMessage): boolean {
  const fetchSite = req.headers["sec-fetch-site"];
  return isLoopbackClientAddress(req.socket.remoteAddress) && loopbackRequestOrigin(req, true) &&
    (fetchSite === undefined || fetchSite === "same-origin") &&
    !Object.keys(req.headers).some(name => name === "forwarded" || name.startsWith("x-forwarded-"));
}

function hasDailyBriefOwnerToken(req: IncomingMessage, ownerToken: string | undefined): boolean {
  const supplied = req.headers["x-blue-tanuki-owner-token"];
  return typeof supplied === "string" && bearerTokenMatches(supplied, ownerToken);
}

function sendLaunchHandoffJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

const RESUME_GLOBAL_KEY = "*";

function goalPurposeRepairBinding(value: Record<string, unknown>): WebChatGoalPurposeRepairRequest | null {
  const { backup_id, manifest_sha256, repair_sha256 } = value;
  if (typeof backup_id !== "string" || backup_id === "latest" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(backup_id) ||
      typeof manifest_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest_sha256) ||
      typeof repair_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(repair_sha256)) return null;
  return { backup_id, manifest_sha256, repair_sha256 };
}

function goalPurposeRepairStores(value: unknown): readonly WebChatGoalPurposeRepairStore[] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [j, m] = value;
  const allowed = ["missing", "different", "matched"];
  if (j?.store_key !== "goal_purpose_j_control" || m?.store_key !== "goal_purpose_m_state" ||
      !allowed.includes(j?.target_state) || !allowed.includes(m?.target_state) ||
      (j.target_state === "matched" && m.target_state === "matched")) return null;
  return [
    { store_key: j.store_key, target_state: j.target_state },
    { store_key: m.store_key, target_state: m.target_state },
  ];
}

const AOTANU_ASSET_FILENAMES_SET = new Set(AOTANU_ASSET_FILENAMES);
const AOTANU_ASSET_ROOT = findAotanuAssetRoot();

type TransientImageReadResult =
  | { readonly ok: true; readonly image?: TransientImageInput }
  | { readonly ok: false };

function readTransientImageInput(value: unknown): TransientImageReadResult {
  if (value === undefined) return { ok: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "media_type" && key !== "data_base64") ||
      (record.media_type !== "image/jpeg" && record.media_type !== "image/png") ||
      typeof record.data_base64 !== "string") return { ok: false };
  const encoded = record.data_base64;
  const maxEncodedBytes = Math.ceil(TRANSIENT_IMAGE_MAX_BYTES / 3) * 4;
  if (encoded.length > maxEncodedBytes || !isCanonicalBase64(encoded)) {
    return { ok: false };
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const expectedByteLength = (encoded.length / 4) * 3 - padding;
  if (expectedByteLength < 1 || expectedByteLength > TRANSIENT_IMAGE_MAX_BYTES) return { ok: false };
  const data = Buffer.from(encoded, "base64");
  if (data.byteLength !== expectedByteLength || data.toString("base64") !== encoded ||
      detectTransientImageMediaType(data) !== record.media_type) {
    data.fill(0);
    return { ok: false };
  }
  return { ok: true, image: { media_type: record.media_type, data } };
}

interface CanvasArtifactReference {
  readonly schema_version: "blue-tanuki.canvas-artifact-reference.v1";
  readonly mime: "text/html" | "text/markdown";
  readonly sha256: string;
  readonly version: 1;
  readonly source: {
    readonly surface: "webchat-assistant-reply";
    readonly request_id: string;
  };
  readonly used_for_authority: false;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

const DAILY_BRIEF_READ_TARGETS = {
  gmail: { tool_name: "gmail.read", api_host: "gmail.googleapis.com" },
  calendar: { tool_name: "google.calendar.read", api_host: "www.googleapis.com" },
  drive: { tool_name: "google.drive.read", api_host: "www.googleapis.com" },
} as const;

function isDailyBriefReadService(value: unknown): value is WebChatDailyBriefReadService {
  return typeof value === "string" && Object.hasOwn(DAILY_BRIEF_READ_TARGETS, value);
}

function validDailyBriefReadReview(review: WebChatDailyBriefReadContentReview, commandId: string): boolean {
  if (!isDailyBriefReadService(review.service)) return false;
  const target = DAILY_BRIEF_READ_TARGETS[review.service];
  return hasExactKeys({ ...review }, ["kind", "command_id", "command_digest", "review_digest", "occurrence_id_digest",
    "scheduled_at_ms", "service", "tool_name", "api_host", "scope", "max_results", "no_store", "used_for_authority", "may_execute"]) &&
    review.command_id === commandId && review.tool_name === target.tool_name && review.api_host === target.api_host &&
    [review.command_digest, review.review_digest, review.occurrence_id_digest]
      .every(digest => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)) &&
    Number.isSafeInteger(review.scheduled_at_ms) && review.scheduled_at_ms > 0 &&
    typeof review.scope === "string" && review.scope.length > 0 && review.scope.length <= 512 &&
    Number.isSafeInteger(review.max_results) && review.max_results >= 1 && review.max_results <= 5 &&
    review.no_store === true && review.used_for_authority === false && review.may_execute === false;
}

function dailyBriefReadResult(value: unknown): WebChatDailyBriefReadResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (!isDailyBriefReadService(result.service) || typeof result.incomplete !== "boolean" ||
      result.used_for_authority !== false || !Array.isArray(result.items) || result.items.length > 5) return null;
  const items: { title: string; detail?: string }[] = [];
  for (const item of result.items) {
    if (!item || typeof item !== "object" || typeof item.title !== "string" || item.title.length > 240 ||
        (item.detail !== undefined && (typeof item.detail !== "string" || item.detail.length > 240))) return null;
    items.push({ title: item.title, ...(item.detail !== undefined ? { detail: item.detail } : {}) });
  }
  return { service: result.service, items, incomplete: result.incomplete, used_for_authority: false };
}

function validSettingsProviderReview(review: WebChatSettingsWriteContentReview, commandId: string): boolean {
  if (!Array.isArray(review.changes)) return false;
  if (review.activation === undefined && review.credential_rotation === undefined) {
    return !review.changes.some(change => change?.key === "llm.provider" || change?.key === "llm.credential_reference");
  }
  if (!hasExactKeys({ ...review }, [
    "kind", "command_id", "command_digest", "review_digest", "operation", "expected_llm_provider",
    review.credential_rotation === undefined ? "activation" : "credential_rotation",
    "changes", "request_payload_digest", "target_version_digest", "operation_plan_binding_digest",
    "no_store", "used_for_authority", "may_execute",
  ])) return false;
  if (review.credential_rotation !== undefined) {
    const rotation = review.credential_rotation;
    const provider = SettingsWriteNativeLlmProviderSchema.safeParse(review.expected_llm_provider);
    const change = review.changes[0];
    if (review.command_id !== commandId || review.operation !== "settings.write" || review.no_store !== true ||
        review.used_for_authority !== false || review.may_execute !== false ||
        ![review.command_digest, review.review_digest, review.request_payload_digest, review.target_version_digest,
          review.operation_plan_binding_digest].every(digest => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)) ||
        !rotation || !provider.success || !hasExactKeys({ ...rotation }, ["provider", "destination", "protected_reference_configured"]) ||
        review.changes.length !== 1 || !change || !hasExactKeys({ ...change }, ["key", "before", "after"])) return false;
    const expected = settingsWriteCredentialRotationReview(provider.data);
    return rotation.provider === expected.provider && rotation.destination === expected.destination &&
      rotation.protected_reference_configured === expected.protected_reference_configured &&
      change.key === SETTINGS_WRITE_CREDENTIAL_ROTATION_CHANGE.key && change.before === SETTINGS_WRITE_CREDENTIAL_ROTATION_CHANGE.before &&
      change.after === SETTINGS_WRITE_CREDENTIAL_ROTATION_CHANGE.after;
  }
  if (!review.activation) return false;
  const { destination, protected_reference_configured, credential_registration_required, ...selection } = review.activation;
  const registersCredential = protected_reference_configured === false && credential_registration_required === true;
  const usesProtectedReference = protected_reference_configured === true &&
    !Object.hasOwn(review.activation, "credential_registration_required");
  if ((!registersCredential && !usesProtectedReference) || Object.hasOwn(selection, "register_credential")) return false;
  const parsed = SettingsWriteActivationSchema.safeParse({ ...selection, ...(registersCredential ? { register_credential: true } : {}) });
  if (!parsed.success ||
      destination !== SETTINGS_WRITE_ACTIVATION_DESTINATIONS[parsed.data.provider]) return false;
  const fields = new Map<string, unknown>();
  for (const change of review.changes) {
    if (!change || !hasExactKeys({ ...change }, ["key", "before", "after"]) || fields.has(change.key) ||
        !["llm.provider", "llm.model", "llm.max_tokens", "llm.timeout_ms", "llm.temperature"].includes(change.key) ||
        (change.before !== null && typeof change.before !== (change.key === "llm.provider" || change.key === "llm.model"
          ? "string" : "number"))) return false;
    if (change.key === "llm.provider" && change.before !== review.expected_llm_provider) return false;
    fields.set(change.key, change.after);
  }
  return fields.get("llm.provider") === parsed.data.provider && SettingsWriteArgumentsSchema.safeParse({
    expected_llm_provider: review.expected_llm_provider,
    patch: { llm: {
      activation: parsed.data,
      model: fields.get("llm.model"),
      max_tokens: fields.get("llm.max_tokens"),
      timeout_ms: fields.get("llm.timeout_ms"),
      temperature: fields.get("llm.temperature"),
    } },
  }).success;
}

function readCanvasArtifactReference(value: unknown): CanvasArtifactReference | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["schema_version", "mime", "sha256", "version", "source", "used_for_authority"]) ||
      record.schema_version !== "blue-tanuki.canvas-artifact-reference.v1" ||
      (record.mime !== "text/html" && record.mime !== "text/markdown") ||
      typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256) ||
      record.version !== 1 || record.used_for_authority !== false ||
      typeof record.source !== "object" || record.source === null || Array.isArray(record.source)) return null;
  const source = record.source as Record<string, unknown>;
  const requestId = source.request_id;
  if (!hasExactKeys(source, ["surface", "request_id"]) || source.surface !== "webchat-assistant-reply" ||
      typeof requestId !== "string" || requestId.length === 0 || requestId.length > 200 ||
      requestId.trim() !== requestId || Array.from(requestId).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })) return null;
  return record as unknown as CanvasArtifactReference;
}

function sameCanvasArtifactReference(left: CanvasArtifactReference, right: CanvasArtifactReference): boolean {
  return left.schema_version === right.schema_version && left.mime === right.mime && left.sha256 === right.sha256 &&
    left.version === right.version && left.source.surface === right.source.surface &&
    left.source.request_id === right.source.request_id && left.used_for_authority === right.used_for_authority;
}

const CANVAS_OPERATION_TASK_PREFIX =
  "Canvas表示物に対するownerの操作意図。添付参照は同定専用で権限根拠ではありません。\n";

type CanvasOperationTaskReference =
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly reference: CanvasArtifactReference };

function readCanvasOperationTaskReference(task: string): CanvasOperationTaskReference {
  if (!task.startsWith(CANVAS_OPERATION_TASK_PREFIX)) return { kind: "none" };
  try {
    const payload = JSON.parse(task.slice(CANVAS_OPERATION_TASK_PREFIX.length)) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { kind: "invalid" };
    const record = payload as Record<string, unknown>;
    const reference = readCanvasArtifactReference(record.artifact_reference);
    if (!hasExactKeys(record, ["schema_version", "owner_intent", "artifact_reference",
      "artifact_reference_used_for_authority"]) ||
        record.schema_version !== "blue-tanuki.canvas-operation-intent.v1" ||
        typeof record.owner_intent !== "string" || !record.owner_intent.trim() ||
        record.owner_intent.length > 15_000 || record.artifact_reference_used_for_authority !== false || !reference) {
      return { kind: "invalid" };
    }
    return { kind: "valid", reference };
  } catch {
    return { kind: "invalid" };
  }
}

type OwnerTaskCanvasArtifactReadResult =
  | { readonly ok: true; readonly artifact?: TransientCanvasArtifactInput }
  | { readonly ok: false };

function readOwnerTaskCanvasArtifact(value: unknown): OwnerTaskCanvasArtifactReadResult {
  if (value === undefined) return { ok: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["schema_version", "artifact_reference", "content"]) ||
      record.schema_version !== "blue-tanuki.canvas-artifact-input.v1" || typeof record.content !== "string" ||
      !isWellFormedUnicode(record.content)) return { ok: false };
  const reference = readCanvasArtifactReference(record.artifact_reference);
  if (!reference) return { ok: false };
  const byteLength = Buffer.byteLength(record.content, "utf8");
  if (byteLength < 1 || byteLength > TRANSIENT_CANVAS_ARTIFACT_MAX_BYTES) return { ok: false };
  const detectedMime = /^\s*</u.test(record.content) && !/^\s*```/u.test(record.content)
    ? "text/html" : "text/markdown";
  if (detectedMime !== reference.mime) return { ok: false };
  const data = Buffer.from(record.content, "utf8");
  if (createHash("sha256").update(data).digest("hex") !== reference.sha256) {
    data.fill(0);
    return { ok: false };
  }
  return {
    ok: true,
    artifact: {
      media_type: reference.mime,
      source_request_id: reference.source.request_id,
      version: reference.version,
      sha256: reference.sha256,
      data,
    },
  };
}

type TransientAudioReadResult =
  | { readonly ok: true; readonly audio?: TransientAudioInput }
  | { readonly ok: false };

function readTransientAudioInput(value: unknown): TransientAudioReadResult {
  if (value === undefined) return { ok: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "data_base64") || typeof record.data_base64 !== "string") {
    return { ok: false };
  }
  const encoded = record.data_base64;
  const maxEncodedBytes = Math.ceil(TRANSIENT_AUDIO_MAX_BYTES / 3) * 4;
  if (encoded.length > maxEncodedBytes || !isCanonicalBase64(encoded)) {
    return { ok: false };
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const expectedByteLength = (encoded.length / 4) * 3 - padding;
  if (expectedByteLength < 1 || expectedByteLength > TRANSIENT_AUDIO_MAX_BYTES) return { ok: false };
  const data = Buffer.from(encoded, "base64");
  const format = detectTransientAudioFormat(data);
  if (data.byteLength !== expectedByteLength || data.toString("base64") !== encoded || !format) {
    data.fill(0);
    return { ok: false };
  }
  return { ok: true, audio: { format, data } };
}

function ownerOperationPlanControlAction(content: string): {
  readonly action: "review" | "result" | "resume_wait" | "wait";
  readonly plan_id?: string;
  readonly revision_digest?: string;
} | null {
  const match = /^plan:(review|result|resume_wait|wait)\s+(\{[\s\S]*\})$/.exec(content);
  if (!match) return null;
  let value: unknown;
  try { value = JSON.parse(match[2] ?? ""); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.hasOwn(value, "action")) return null;
  const parsed = OperationPlanControlSchema.safeParse({ ...(value as Record<string, unknown>), action: match[1] });
  return parsed.success && (parsed.data.action === "review" || parsed.data.action === "result" ||
    parsed.data.action === "resume_wait" || parsed.data.action === "wait")
    ? { action: parsed.data.action,
        ...(parsed.data.action === "wait" ? {
          plan_id: parsed.data.plan_id,
          revision_digest: parsed.data.revision_digest,
        } : {}) }
    : null;
}

function ownerPlanWaitSessionId(planId: string, revisionDigest: string): string {
  return `webchat-owner-plan:${planId}:${revisionDigest}`;
}

function bearerTokenMatches(candidate: string | undefined, expected: string | undefined): boolean {
  if (candidate === undefined || expected === undefined) return false;
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return candidateBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(candidateBytes, expectedBytes);
}

function d4RuntimeReferenceDigest(token: string, kind: "runtime" | "session", value: string): string {
  return createHmac("sha256", token)
    .update(`blue-tanuki.d4-runtime.${kind}.v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

const D4_RUNTIME_SESSION_PREFIX = "d4-runtime:";

// 一般の利用者名や返信先は専用D4セッションの受信資格にしない。
function rejectReservedWebChatAudience(res: ServerResponse, target: string): boolean {
  if (!target.normalize("NFKC").trim().startsWith(D4_RUNTIME_SESSION_PREFIX)) return false;
  res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: "reserved_runtime_audience" }));
  return true;
}

function d4RuntimeIntentScopeDigest(runtimeId: string, sessionId: string): string {
  return createHash("sha256")
    .update("blue-tanuki.d4-runtime.intent-submission-scope.v1\0", "utf8")
    .update(JSON.stringify([runtimeId, sessionId]), "utf8")
    .digest("hex");
}

function d4RuntimeIntentPayloadDigest(
  token: string,
  runtimeId: string,
  sessionId: string,
  intent: string,
  attachments: { readonly image?: TransientImageInput; readonly audio?: TransientAudioInput } = {},
): string {
  const payload: unknown[] = [runtimeId, sessionId, intent];
  if (attachments.image || attachments.audio) {
    payload.push({
      image: attachments.image ? {
        media_type: attachments.image.media_type,
        byte_length: attachments.image.data.byteLength,
        sha256: createHash("sha256").update(attachments.image.data).digest("hex"),
      } : null,
      audio: attachments.audio ? {
        format: attachments.audio.format,
        byte_length: attachments.audio.data.byteLength,
        sha256: createHash("sha256").update(attachments.audio.data).digest("hex"),
      } : null,
    });
  }
  return createHmac("sha256", token)
    .update("blue-tanuki.d4-runtime.intent-submission-payload.v1\0", "utf8")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function normalizeTaskOutcome(value: unknown): WebChatTaskOutcome {
  const invalid: WebChatTaskOutcome = {
    status: "unknown", reason_code: "projection_invalid", used_for_authority: false, may_execute: false,
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid;
  const outcome = value as Record<string, unknown>;
  const allowedKeys = ["status", "reason_code", "completion_evidence", "used_for_authority", "may_execute"];
  if (Object.keys(outcome).some((key) => !allowedKeys.includes(key)) ||
      outcome.used_for_authority !== false || outcome.may_execute !== false) return invalid;
  if (outcome.status === "unknown" && ["projection_unavailable", "projection_ambiguous", "projection_invalid"].includes(String(outcome.reason_code)) &&
      outcome.completion_evidence === undefined) {
    return { status: "unknown", reason_code: outcome.reason_code as WebChatTaskOutcome["reason_code"],
      used_for_authority: false, may_execute: false };
  }
  if (outcome.status === "in_progress" && outcome.reason_code === "completion_pending" &&
      outcome.completion_evidence === undefined) {
    return { status: "in_progress", reason_code: "completion_pending", used_for_authority: false, may_execute: false };
  }
  if (outcome.status === "held" && outcome.reason_code === "completion_held" &&
      outcome.completion_evidence === undefined) {
    return { status: "held", reason_code: "completion_held", used_for_authority: false, may_execute: false };
  }
  const evidence = outcome.completion_evidence;
  if (outcome.status !== "achieved" || outcome.reason_code !== "goal_completion_rules_satisfied" ||
      typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return invalid;
  const completionEvidence = evidence as Record<string, unknown>;
  const evidenceKeys = ["rules_digest", "evidence_digest", "rule_count", "satisfied_rule_count", "used_for_authority", "may_execute"];
  if (Object.keys(completionEvidence).length !== evidenceKeys.length ||
      Object.keys(completionEvidence).some((key) => !evidenceKeys.includes(key)) ||
      typeof completionEvidence.rules_digest !== "string" || !/^[a-f0-9]{64}$/iu.test(completionEvidence.rules_digest) ||
      typeof completionEvidence.evidence_digest !== "string" || !/^[a-f0-9]{64}$/iu.test(completionEvidence.evidence_digest) ||
      typeof completionEvidence.rule_count !== "number" || !Number.isInteger(completionEvidence.rule_count) ||
      completionEvidence.rule_count < 1 || completionEvidence.rule_count > 64 ||
      completionEvidence.satisfied_rule_count !== completionEvidence.rule_count ||
      completionEvidence.used_for_authority !== false || completionEvidence.may_execute !== false) return invalid;
  return {
    status: "achieved",
    reason_code: "goal_completion_rules_satisfied",
    completion_evidence: {
      rules_digest: completionEvidence.rules_digest.toLowerCase(),
      evidence_digest: completionEvidence.evidence_digest.toLowerCase(),
      rule_count: completionEvidence.rule_count,
      satisfied_rule_count: completionEvidence.satisfied_rule_count as number,
      used_for_authority: false,
      may_execute: false,
    },
    used_for_authority: false,
    may_execute: false,
  };
}

function normalizeTaskExecutionObservation(value: unknown): WebChatTaskExecutionObservation {
  const noAuthority = { used_for_authority: false, may_execute: false } as const;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { status: "unknown", ...noAuthority };
  const observation = value as Record<string, unknown>;
  if (observation.used_for_authority !== false || observation.may_execute !== false) return { status: "unknown", ...noAuthority };
  const { status, feedback_status } = observation;
  const fields = ["status", "used_for_authority", "may_execute"];
  if (status === "adapter_returned" && hasExactKeys(observation, [...fields, "feedback_status"]) &&
      (feedback_status === "success" || feedback_status === "failed" || feedback_status === "suspended")) {
    return { status, feedback_status, ...noAuthority };
  }
  if (hasExactKeys(observation, fields) && (status === "awaiting_approval" || status === "active" || status === "held" ||
      status === "not_attempted" || status === "outcome_unknown")) return { status, ...noAuthority };
  return { status: "unknown", ...noAuthority };
}

function normalizeOwnerTaskPlanSteps(value: unknown): WebChatOwnerTaskPlanSteps {
  const noAuthority = { used_for_authority: false, may_execute: false } as const;
  const unknown = { status: "unknown", ...noAuthority } as const;
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown;
  const observation = value as Record<string, unknown>;
  if (!hasExactKeys(observation, ["status", "used_for_authority", "may_execute", "steps"]) ||
      observation.used_for_authority !== false || observation.may_execute !== false || observation.status !== "available" ||
      !Array.isArray(observation.steps) || observation.steps.length < 1 || observation.steps.length > MAX_OWNER_TASK_PLAN_STEPS) {
    return unknown;
  }
  const steps: WebChatOwnerTaskPlanStep[] = [];
  for (const value of observation.steps as unknown[]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return unknown;
    const step = value as Record<string, unknown>;
    const { index, status, feedback_status, verification, result_ref } = step;
    if (index !== steps.length + 1) return unknown;
    if (status === "adapter_returned") {
      if (feedback_status === "success" && verification === "result_and_memory_confirmed") {
        const keys = ["index", "status", "feedback_status", "verification"];
        if (result_ref !== undefined) {
          if (typeof result_ref !== "string" || !/^[a-f0-9]{64}$/u.test(result_ref)) return unknown;
          keys.push("result_ref");
        }
        if (!hasExactKeys(step, keys)) return unknown;
        steps.push({ index, status, feedback_status, verification, ...(result_ref !== undefined ? { result_ref } : {}) });
      } else if ((feedback_status === "success" || feedback_status === "failed" || feedback_status === "suspended") &&
          hasExactKeys(step, ["index", "status", "feedback_status"])) {
        steps.push({ index, status, feedback_status });
      } else return unknown;
    } else if (hasExactKeys(step, ["index", "status"]) && (status === "pending" || status === "awaiting_approval" ||
      status === "active" || status === "interrupted" || status === "outcome_unknown" || status === "not_attempted" ||
      status === "held" || status === "unknown")) {
      steps.push({ index, status });
    } else return unknown;
  }
  return { status: "available", steps, ...noAuthority };
}

function normalizePreExecutorCancellation<Status extends WebChatTaskApprovalWithdrawal["status"] |
    WebChatD4RuntimeBeforeDecisionCancellation["status"]>(value: unknown, expectedStatus: Status):
    (Omit<WebChatTaskApprovalWithdrawal, "status"> & { readonly status: Status }) | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const withdrawal = value as Record<string, unknown>;
  const allowed = ["status", "cancel_request_accepted", "executor_started", "external_processing_stop",
    "cancel_requested_at_ms", "used_for_authority", "may_execute"];
  if (!hasExactKeys(withdrawal, allowed) ||
      withdrawal.status !== expectedStatus || withdrawal.cancel_request_accepted !== true ||
      withdrawal.executor_started !== false || withdrawal.external_processing_stop !== "unknown" ||
      typeof withdrawal.cancel_requested_at_ms !== "number" || !Number.isSafeInteger(withdrawal.cancel_requested_at_ms) ||
      withdrawal.cancel_requested_at_ms < 0 || withdrawal.used_for_authority !== false ||
      withdrawal.may_execute !== false) return null;
  return {
    status: expectedStatus, cancel_request_accepted: true, executor_started: false,
    external_processing_stop: "unknown", cancel_requested_at_ms: withdrawal.cancel_requested_at_ms,
    used_for_authority: false, may_execute: false,
  };
}

function normalizeOwnerTaskWaitState(value: unknown): WebChatOwnerTaskWaitPending | WebChatOwnerTaskWaitCancellation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const wait = value as Record<string, unknown>;
  if (wait.status !== "wait_pending" && wait.status !== "wait_cancelled") return null;
  const timeKey = wait.status === "wait_pending" ? "deadline_at_ms" : "cancel_requested_at_ms";
  const time = wait[timeKey];
  const allowed = ["status", timeKey, "used_for_authority", "may_execute"];
  if (Object.keys(wait).length !== allowed.length || Object.keys(wait).some(key => !allowed.includes(key)) ||
      wait.used_for_authority !== false || wait.may_execute !== false ||
      typeof time !== "number" || !Number.isSafeInteger(time) || time < 0) return null;
  const noAuthority = { used_for_authority: false, may_execute: false } as const;
  return wait.status === "wait_pending" ? { status: "wait_pending", deadline_at_ms: time, ...noAuthority }
    : { status: "wait_cancelled", cancel_requested_at_ms: time, ...noAuthority };
}

function normalizeOwnerTaskCancellationStatus(value: unknown) {
  return normalizeOwnerTaskWaitState(value) ?? normalizeTaskCancellationStatus(value);
}

function normalizeTaskCancellationStatus(value: unknown): Exclude<WebChatD4RuntimeCancellationStatus,
    WebChatD4RuntimeBeforeDecisionCancellation> {
  const withdrawal = normalizePreExecutorCancellation(value, "approval_withdrawn");
  if (withdrawal) return withdrawal;
  const unknown: WebChatD4RuntimeCancellationStatus = {
    status: "unknown", reason_code: "projection_invalid", used_for_authority: false, may_execute: false,
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return unknown;
  const status = value as Record<string, unknown>;
  if (status.used_for_authority !== false || status.may_execute !== false) return unknown;
  if (status.status === "unknown") {
    const allowed = ["status", "reason_code", "used_for_authority", "may_execute"];
    if (Object.keys(status).some((key) => !allowed.includes(key)) ||
        !["projection_unavailable", "projection_ambiguous", "projection_invalid", "no_recorded_evidence"]
          .includes(String(status.reason_code))) return unknown;
    return { status: "unknown", reason_code: status.reason_code as Extract<WebChatD4RuntimeCancellationStatus,
      { status: "unknown" }>["reason_code"], used_for_authority: false, may_execute: false };
  }
  if (status.status === "request_recorded") {
    const allowed = ["status", "cancel_request_accepted", "executor_settled", "executor_status", "local_worker_stop",
      "external_processing_stop", "cancel_requested_at_ms", "used_for_authority", "may_execute"];
    if (Object.keys(status).length !== allowed.length || Object.keys(status).some((key) => !allowed.includes(key)) ||
        status.cancel_request_accepted !== true || status.executor_settled !== false || status.executor_status !== "unknown" ||
        status.local_worker_stop !== "not_observed" || status.external_processing_stop !== "unknown" ||
        typeof status.cancel_requested_at_ms !== "number" || !Number.isSafeInteger(status.cancel_requested_at_ms) ||
        status.cancel_requested_at_ms < 0) return unknown;
    return {
      status: "request_recorded", cancel_request_accepted: true, executor_settled: false, executor_status: "unknown",
      local_worker_stop: "not_observed", external_processing_stop: "unknown",
      cancel_requested_at_ms: status.cancel_requested_at_ms, used_for_authority: false, may_execute: false,
    };
  }
  if (status.status !== "execution_observed") return unknown;
  const allowed = ["status", "cancel_request_accepted", "executor_settled", "executor_status", "local_worker_stop",
    "external_processing_stop", "cancel_requested_at_ms", "observed_at_ms", "used_for_authority", "may_execute"];
  if (Object.keys(status).length !== allowed.length || Object.keys(status).some((key) => !allowed.includes(key)) ||
      status.cancel_request_accepted !== true || typeof status.executor_settled !== "boolean" ||
      !["success", "failed", "suspended", "unknown"].includes(String(status.executor_status)) ||
      !["not_observed", "worker_exit_observed", "process_tree_empty_confirmed", "provider_state_unknown"]
        .includes(String(status.local_worker_stop)) || status.external_processing_stop !== "unknown" ||
      typeof status.cancel_requested_at_ms !== "number" || !Number.isSafeInteger(status.cancel_requested_at_ms) ||
      status.cancel_requested_at_ms < 0 || typeof status.observed_at_ms !== "number" ||
      !Number.isSafeInteger(status.observed_at_ms) || status.observed_at_ms < status.cancel_requested_at_ms) return unknown;
  return {
    status: "execution_observed", cancel_request_accepted: true, executor_settled: status.executor_settled,
    executor_status: status.executor_status as "success" | "failed" | "suspended" | "unknown",
    local_worker_stop: status.local_worker_stop as Extract<WebChatD4RuntimeCancellationStatus,
      { status: "execution_observed" }>["local_worker_stop"],
    external_processing_stop: "unknown", cancel_requested_at_ms: status.cancel_requested_at_ms,
    observed_at_ms: status.observed_at_ms, used_for_authority: false, may_execute: false,
  };
}

function normalizeTaskCancellationAcknowledgement(value: unknown, allowPrivateFields = false): WebChatOwnerTaskCancellation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const cancellation = value as Record<string, unknown>;
  const allowed = ["status", "cancel_request_accepted", "executor_settled", "execution_signal_aborted",
    "executor_state", "local_worker_stop", "external_processing_stop", "used_for_authority", "may_execute"];
  if ((!allowPrivateFields && (Object.keys(cancellation).length !== allowed.length ||
      Object.keys(cancellation).some((key) => !allowed.includes(key)))) ||
      (cancellation.status !== "cancel_requested" && cancellation.status !== "already_requested") ||
      cancellation.cancel_request_accepted !== true || cancellation.executor_settled !== false ||
      cancellation.execution_signal_aborted !== true || cancellation.executor_state !== "cancel_requested" ||
      typeof cancellation.local_worker_stop !== "string" ||
      !["not_observed", "worker_exit_observed", "process_tree_empty_confirmed", "provider_state_unknown"]
        .includes(cancellation.local_worker_stop) || cancellation.external_processing_stop !== "unknown" ||
      cancellation.used_for_authority !== false || cancellation.may_execute !== false) return null;
  return {
    status: cancellation.status,
    cancel_request_accepted: true,
    executor_settled: false,
    execution_signal_aborted: true,
    executor_state: "cancel_requested",
    local_worker_stop: cancellation.local_worker_stop as WebChatOwnerTaskCancellation["local_worker_stop"],
    external_processing_stop: "unknown",
    used_for_authority: false,
    may_execute: false,
  };
}

function isDirectToolShortcutContent(content: string): boolean {
  return /^(?:tool:[A-Za-z0-9_.-]+|\/tool(?:\s|$))/.test(content.trim());
}

function findAotanuAssetRoot(): string {
  let current = path.resolve(process.cwd());
  for (;;) {
    const candidate = path.join(current, "assets", "aotanu", "spritesheets");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(process.cwd(), "assets", "aotanu", "spritesheets");
    current = parent;
  }
}

/**
 * WebChat channel — Phase 4.
 *
 * Endpoint summary:
 *   POST /ws-ticket  body:{user}  auth:Bearer  rate-limited per-user
 *   POST /inbound    body:{user, content}  auth:Bearer  rate-limited per-user
 *   POST /owner/inbound body:{user, content} auth:dedicated owner bearer
 *   POST /runtime/ws-ticket body:{runtime_id, session_id} auth:dedicated D4 Runtime bearer
 *   POST /runtime/intent body:{runtime_id, session_id, submission_id, intent} auth:dedicated D4 Runtime bearer
 *   POST /runtime/intent/status body:{runtime_id, session_id, submission_id} auth:dedicated D4 Runtime bearer
 *   POST /runtime/intent/cancel body:{runtime_id, session_id, submission_id} auth:dedicated D4 Runtime bearer
 *   GET  /runtime/snapshot auth:inbound または専用D4 Runtime bearer、読取専用投影
 *   POST /owner/goal-purpose-adoption body:{purpose_text} auth:dedicated owner bearer, no-store
 *   POST /owner/llm-settings-proposal body:{expected_provider,patch,goal_ref?,purpose_version?} auth:dedicated owner bearer, no-store
 *   POST /owner/daily-brief-read body:{occurrence_id_digest,service} auth:dedicated local owner bearer, no-store
 *   POST /owner/goal-purpose-change body:{goal_ref, purpose_text} auth:dedicated owner bearer
 *   POST /owner/task-submission-status body:{submission_id} auth:dedicated owner bearer
 *   POST /owner/task-submission-result body:{submission_id,step_index,result_ref} auth:local same-origin owner bearer, no-store
 *   POST /owner/task-submission-cancel body:{submission_id} auth:dedicated owner bearer
 *   GET  /owner/goal-purpose-change-candidates auth:dedicated owner bearer, no-store
 *   POST /webhook    body:{content|text|event,user?,source?,reply_to?} auth:Bearer webhook-token
 *   POST /resume     body:{request_id, verdict, approval_token}  auth:Bearer  rate-limited (global)
 *   GET  /approval   auth:Bearer resume-token
 *   POST /approval/executions/:id/cancel auth:Bearer resume-token
 *   POST /approval/:id/content auth:Bearer resume-token (explicit content review)
 *   POST /approval/:id body:{verdict, approval_token} auth:Bearer resume-token
 *   GET  /approval/grants auth:Bearer resume-token
 *   POST /approval/grants/:id/revoke body:{actor?,reason?} auth:Bearer resume-token
 *   GET  /approval/history auth:Bearer resume-token
 *   GET  /approval/emergency-stop auth:Bearer resume-token
 *   POST /approval/emergency-stop body:{action,actor?,reason?} auth:Bearer resume-token
 *   GET  /audit/dump auth:Bearer inbound-token
 *   GET  /authority/trace auth:Bearer inbound-token または専用D4 Runtime bearer、読取専用
 *   GET  /notifications auth:Bearer inbound-token または専用D4 Runtime bearer、表示専用
 *   GET  /history auth:Bearer inbound-token
 *   GET  /history/replay auth:Bearer inbound-token
 *   POST /evidence/export body:{actor?} auth:Bearer inbound-token
 *   GET  /operators/writing auth:Bearer inbound-token
 *   POST /operators/writing/invoke body:{user,content} auth:Bearer inbound-token
 *   GET  /operators/daily auth:Bearer inbound-token
 *   POST /operators/daily/invoke body:{user,content} auth:Bearer inbound-token
 *   GET  /operators/developer auth:Bearer inbound-token
 *   POST /operators/developer/invoke body:{user,content} auth:Bearer inbound-token
 *   GET/POST /update/* and /recovery/* auth:Bearer maintenance-token; recovery mutations only enqueue HDS L3 review
 *   GET  /ws         query:?ticket=...
 *   GET  /healthz    no auth, not rate-limited
 *
 * Rate-limit response:
 *   HTTP 429
 *   Retry-After: <seconds>
 *   { "error": "rate_limited", "retry_after_ms": <ms> }
 */
export class WebChatChannel implements InboundChannel, OutboundChannel {
  readonly name = "webchat";
  private server: HttpServer | HttpsServer | null = null;
  private wss: WebSocketServer | null = null;
  private handler: InboundHandler | null = null;
  private readonly conns = new Map<string, Set<WebSocket>>();
  private readonly ticketStore: TicketStore;
  private readonly ticketTtlMs: number;
  private readonly resumeApprovalTokenStore: ResumeApprovalTokenStore | null;
  private readonly resumeApprovalTokenTtlMs: number;
  private readonly controlCenterLaunchHandoffs = new Map<string, ControlCenterLaunchHandoff>();
  private readonly buckets: {
    inbound: TokenBucket | null;
    resume: TokenBucket | null;
    ws_ticket: TokenBucket | null;
  };
  private starting = false;
  private started = false;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: WebChatOptions) {
    if (!opts.token || opts.token.length < 8) {
      throw new Error(
        "WebChatChannel: opts.token is required and must be ≥8 chars",
      );
    }
    if (opts.resume_token !== undefined && opts.resume_token.length < 8) {
      throw new Error(
        "WebChatChannel: opts.resume_token must be >=8 chars when set",
      );
    }
    if (opts.resume_token !== undefined && opts.resume_token === opts.token) {
      throw new Error("WebChatChannel: opts.resume_token must differ from opts.token");
    }
    if (opts.onOwnerTaskGoalOptions && !opts.owner_task_submission_store) {
      throw new Error("WebChatChannel: owner task compute requires a durable submission store");
    }
    if (opts.webhook_token !== undefined && opts.webhook_token.length < 8) {
      throw new Error(
        "WebChatChannel: opts.webhook_token must be >=8 chars when set",
      );
    }
    if (
      opts.webhook_token !== undefined &&
      (opts.webhook_token === opts.token ||
        opts.webhook_token === opts.resume_token)
    ) {
      throw new Error("WebChatChannel: opts.webhook_token must differ from WebChat tokens");
    }
    if (opts.owner_token !== undefined && opts.owner_token.length < 16) {
      throw new Error("WebChatChannel: opts.owner_token must be >=16 chars when set");
    }
    if (
      opts.owner_token !== undefined &&
      (opts.owner_token === opts.token ||
        opts.owner_token === opts.resume_token ||
        opts.owner_token === opts.webhook_token ||
        opts.owner_token === opts.maintenance_token ||
        opts.owner_token === opts.settings?.token)
    ) {
      throw new Error("WebChatChannel: opts.owner_token must differ from other WebChat tokens");
    }
    if ((opts.update || opts.recovery) && !opts.maintenance_token) {
      throw new Error("WebChatChannel: opts.maintenance_token is required when update or recovery surfaces are set");
    }
    if (opts.maintenance_token !== undefined && opts.maintenance_token.length < 16) {
      throw new Error("WebChatChannel: opts.maintenance_token must be >=16 chars when set");
    }
    if (
      opts.maintenance_token !== undefined &&
      (opts.maintenance_token === opts.token ||
        opts.maintenance_token === opts.resume_token ||
        opts.maintenance_token === opts.webhook_token)
    ) {
      throw new Error("WebChatChannel: opts.maintenance_token must differ from WebChat tokens");
    }
    if (opts.onResume && !opts.resume_token) {
      throw new Error("WebChatChannel: opts.resume_token is required when onResume is set");
    }
    if (opts.settings && opts.settings.token.length < 16) {
      throw new Error("WebChatChannel: opts.settings.token must be >=16 chars");
    }
    if (
      opts.settings &&
      (opts.settings.token === opts.token ||
        opts.settings.token === opts.resume_token ||
        opts.settings.token === opts.webhook_token ||
        opts.settings.token === opts.owner_token ||
        opts.settings.token === opts.maintenance_token)
    ) {
      throw new Error("WebChatChannel: opts.settings.token must differ from WebChat tokens");
    }
    if (opts.d4_runtime_intent) {
      const { token: d4RuntimeToken, runtime_id: d4RuntimeId } = opts.d4_runtime_intent;
      if (d4RuntimeToken.length < 32) {
        throw new Error("WebChatChannel: d4_runtime_intent.token must be >=32 chars");
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(d4RuntimeId)) {
        throw new Error("WebChatChannel: d4_runtime_intent.runtime_id is invalid");
      }
      if ([
        opts.token,
        opts.resume_token,
        opts.webhook_token,
        opts.owner_token,
        opts.maintenance_token,
        opts.settings?.token,
      ].some((candidate) => candidate !== undefined && candidate === d4RuntimeToken)) {
        throw new Error("WebChatChannel: d4_runtime_intent.token must differ from other WebChat tokens");
      }
    }
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      throw new Error("WebChatChannel: opts.port must be a valid TCP port");
    }
    this.ticketTtlMs = opts.ws_ticket_ttl_ms ?? 30_000;
    if (this.ticketTtlMs < 1_000) {
      throw new Error("WebChatChannel: ws_ticket_ttl_ms must be ≥ 1000");
    }
    this.resumeApprovalTokenTtlMs =
      opts.resume_approval_token_ttl_ms ?? 10 * 60_000;
    if (this.resumeApprovalTokenTtlMs < 1_000) {
      throw new Error(
        "WebChatChannel: resume_approval_token_ttl_ms must be >= 1000",
      );
    }
    this.ticketStore =
      opts.ticket_store ??
      new MemoryTicketStore({
        cap: opts.ws_ticket_cap ?? 10_000,
        now: opts.clock ? () => opts.clock!.now() : undefined,
      });
    this.resumeApprovalTokenStore =
      opts.resume_approval_tokens === false
        ? null
        : opts.resume_approval_tokens ??
          new MemoryResumeApprovalTokenStore({
            cap: opts.resume_approval_token_cap ?? 10_000,
            now: opts.clock ? () => opts.clock!.now() : undefined,
          });

    if (opts.rate_limits === false) {
      this.buckets = { inbound: null, resume: null, ws_ticket: null };
    } else {
      const cfg = opts.rate_limits ?? {};
      this.buckets = {
        inbound: new TokenBucket({
          ...DEFAULT_RATE_LIMITS.inbound,
          ...cfg.inbound,
          clock: opts.clock,
        }),
        resume: new TokenBucket({
          ...DEFAULT_RATE_LIMITS.resume,
          ...cfg.resume,
          clock: opts.clock,
        }),
        ws_ticket: new TokenBucket({
          ...DEFAULT_RATE_LIMITS.ws_ticket,
          ...cfg.ws_ticket,
          clock: opts.clock,
        }),
      };
    }
  }

  async issueResumeApprovalToken(
    request_id: string,
    ttl_ms = this.resumeApprovalTokenTtlMs,
  ): Promise<ResumeApprovalTokenIssued | null> {
    if (!this.resumeApprovalTokenStore) return null;
    return this.resumeApprovalTokenStore.issue(request_id, ttl_ms);
  }

  /** 公開前に審査が終了した場合、発行された単回tokenを破棄する。 */
  async discardUnpublishedResumeApprovalToken(issued: ResumeApprovalTokenIssued): Promise<void> {
    await this.resumeApprovalTokenStore?.consume(issued.request_id, issued.token);
  }

  async start(handler: InboundHandler): Promise<void> {
    if (this.started || this.starting) {
      throw new Error("WebChatChannel: already started");
    }
    this.starting = true;
    this.handler = handler;

    const handleHttp = (req: IncomingMessage, res: ServerResponse): void => {
      this.handleHttp(req, res).catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[webchat] http handler error:", e);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal_error" }));
        }
      });
    };
    this.server = this.opts.tls
      ? createHttpsServer({ key: this.opts.tls.key, cert: this.opts.tls.cert, minVersion: "TLSv1.2" }, handleHttp)
      : createServer(handleHttp);

    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? "/", "http://internal");
          if (url.pathname !== "/ws") {
            socket.destroy();
            return;
          }
          const ticket = url.searchParams.get("ticket");
          if (!ticket) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          const user = await this.ticketStore.consume(ticket);
          if (!user) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          this.wss!.handleUpgrade(req, socket, head, (ws) => {
            this.attachConnection(user, ws);
          });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[webchat] upgrade error:", e);
          socket.destroy();
        }
      })();
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => {
        this.starting = false;
        reject(e);
      };
      this.server!.once("error", onError);
      this.server!.listen(this.opts.port, this.opts.host ?? "127.0.0.1", () => {
        this.server!.off("error", onError);
        resolve();
      });
    });

    // Periodic TokenBucket prune. Keeps the per-key state map from
    // growing unboundedly on long-running processes that see many
    // distinct (user, endpoint) pairs.
    const prune_interval = this.opts.rate_limit_prune_interval_ms ?? 60_000;
    if (prune_interval > 0) {
      const idle_ms =
        this.opts.rate_limit_prune_idle_ms ?? prune_interval * 5;
      this.pruneTimer = setInterval(() => {
        this.buckets.inbound?.prune(idle_ms);
        this.buckets.resume?.prune(idle_ms);
        this.buckets.ws_ticket?.prune(idle_ms);
      }, prune_interval);
      // Don't keep the event loop alive solely for prune.
      this.pruneTimer.unref?.();
    }

    this.starting = false;
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    for (const set of this.conns.values()) {
      for (const ws of set) {
        try {
          ws.close(1001, "server_shutdown");
        } catch {
          /* ignore */
        }
      }
    }
    this.conns.clear();
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = null;
    this.wss = null;
    this.handler = null;
  }

  async send(
    payload: ChannelSendPayload,
    meta: SendMeta,
    context?: SendContext,
  ): Promise<SendResult> {
    if (context?.signal?.aborted) return { delivered: false, delivery_status: "not_delivered",
      error: "channel_send_cancelled_before_dispatch", error_kind: "non_recoverable", error_code: "cancelled_before_dispatch" };
    if (meta.request_id && this.opts.owner_task_submission_store?.recordD4RuntimeIntentResult) {
      try {
        this.opts.owner_task_submission_store.recordD4RuntimeIntentResult({
          request_id: meta.request_id,
          response_target: payload.target,
          content: payload.content,
        });
      } catch {
        // The live WebSocket send remains independent; result reacquisition is best-effort.
      }
    }
    if (meta.request_id && this.opts.owner_task_submission_store?.recordOwnerTaskSubmissionResult) {
      try {
        this.opts.owner_task_submission_store.recordOwnerTaskSubmissionResult({
          request_id: meta.request_id,
          content: payload.content,
        });
      } catch {
        // The live WebSocket send remains independent; result reacquisition is best-effort.
      }
    }
    const set = this.conns.get(payload.target);
    if (!set || set.size === 0) {
      return { delivered: false, error: "no_active_connection" };
    }
    const frame = JSON.stringify({
      kind: "channel_send",
      command_id: meta.command_id,
      upstream_commit_hash: meta.upstream_commit_hash,
      ...(meta.request_id ? { request_id: meta.request_id } : {}),
      content: payload.content,
    });
    const openSockets = [...set].filter((ws) => ws.readyState === WebSocket.OPEN);
    if (openSockets.length === 0) {
      return { delivered: false, delivery_status: "not_delivered", error: "no_open_socket",
        error_kind: "recoverable", error_code: "no_open_socket",
        next_action: "WebChatを再接続してから、この依頼の状態を確認してください。" };
    }

    const outcomes = await Promise.all(openSockets.map((ws) => new Promise<"delivered" | "unknown" | "not_sent">((resolve) => {
      let settled = false;
      const finish = (outcome: "delivered" | "unknown" | "not_sent"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context?.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = (): void => finish("unknown");
      const timer = setTimeout(() => finish("unknown"), WEBSOCKET_SEND_CALLBACK_TIMEOUT_MS);
      context?.signal?.addEventListener("abort", onAbort, { once: true });
      if (context?.signal?.aborted) {
        finish("not_sent");
        return;
      }
      try {
        ws.send(frame, (error?: Error) => finish(error ? "unknown" : "delivered"));
      } catch {
        finish("unknown");
      }
    })));
    if (outcomes.includes("delivered")) {
      return { delivered: true, delivery_status: "delivered", external_id: `webchat-${meta.command_id}` };
    }
    if (outcomes.includes("unknown")) {
      return { delivered: false, delivery_status: "unknown", error: "webchat_delivery_outcome_unknown",
        error_kind: "non_recoverable", error_code: "delivery_outcome_unknown",
        next_action: "WebChatの表示と依頼状態を確認し、結果が不明な間は再送しないでください。" };
    }
    return { delivered: false, delivery_status: "not_delivered", error: "channel_send_cancelled_before_dispatch",
      error_kind: "non_recoverable", error_code: "cancelled_before_dispatch" };
  }

  private notifyOwnerTaskProcessingFailure(target: string, requestId: string): void {
    const connections = this.conns.get(target);
    if (!connections?.size) return;
    const frame = JSON.stringify({
      kind: "error",
      request_id: requestId,
      content: `計画作成の応答を確認できません。重複計画を避けるため、再送前にTasks／Runtimeで参照IDを確認してください。参照ID: ${requestId}`,
    });
    for (const ws of connections) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try { ws.send(frame); } catch { /* notification is best-effort and carries no authority */ }
    }
  }

  private notifyD4RuntimeIntentProcessingFailure(target: string, requestId: string): void {
    const connections = this.conns.get(target);
    if (!connections?.size) return;
    const frame = JSON.stringify({
      kind: "error",
      request_id: requestId,
      content: `依頼の処理結果を確認できません。重複実行を避けるため、状態を確認するまで同じ依頼を再送しないでください。参照ID: ${requestId}`,
    });
    for (const ws of connections) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try { ws.send(frame); } catch { /* notification is best-effort and carries no authority */ }
    }
  }

  connectionCount(user?: string): number {
    if (user) return this.conns.get(user)?.size ?? 0;
    let n = 0;
    for (const s of this.conns.values()) n += s.size;
    return n;
  }

  /** Live ticket count (test/diagnostic). Backed by the ticket store. */
  async ticketCount(): Promise<number> {
    return this.ticketStore.size();
  }

  private attachConnection(user: string, ws: WebSocket): void {
    let set = this.conns.get(user);
    if (!set) {
      set = new Set();
      this.conns.set(user, set);
    }
    set.add(ws);
    ws.on("close", () => {
      const s = this.conns.get(user);
      if (!s) return;
      s.delete(ws);
      if (s.size === 0) this.conns.delete(user);
    });
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
    setImmediate(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ kind: "hello", user }));
        } catch {
          /* ignore */
        }
      }
    });
  }

  /** Apply rate-limit check; on miss, write 429 + Retry-After and return false. */
  private rateLimitOr429(
    bucket: TokenBucket | null,
    key: string,
    res: ServerResponse,
  ): boolean {
    if (!bucket) return true;
    const r = bucket.consume(key);
    if (r.ok) return true;
    const retry_after_sec = Math.max(1, Math.ceil(r.retry_after_ms / 1000));
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": String(retry_after_sec),
    });
    res.end(
      JSON.stringify({
        error: "rate_limited",
        retry_after_ms: r.retry_after_ms,
      }),
    );
    return false;
  }

  private async handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/app")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "frame-ancestors 'none'",
        "x-frame-options": "DENY",
      });
      res.end(renderControlCenterHtml());
      return;
    }

    if (url.pathname === "/control-center/launch-handoff") {
      await this.handleControlCenterLaunchHandoff(req, res);
      return;
    }
    if (url.pathname === "/control-center/launch-handoff/exchange") {
      await this.handleControlCenterLaunchHandoffExchange(req, res);
      return;
    }

    if (url.pathname.startsWith(AOTANU_ASSET_ROUTE_PREFIX)) {
      await this.handleAotanuAsset(req, res, url.pathname);
      return;
    }

    if (url.pathname === "/app/about") {
      await this.handleAbout(req, res);
      return;
    }

    if (url.pathname.startsWith("/update/")) {
      await this.handleUpdate(req, res, url.pathname);
      return;
    }

    if (url.pathname.startsWith("/recovery/")) {
      await this.handleRecovery(req, res, url.pathname);
      return;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, channel: "webchat" }));
      return;
    }

    if (url.pathname === "/settings") {
      await this.handleSettingsPage(req, res);
      return;
    }

    if (url.pathname === "/settings/config") {
      await this.handleSettingsConfig(req, res);
      return;
    }

    if (url.pathname === "/settings/llm/verify") {
      await this.handleSettingsLlmVerify(req, res);
      return;
    }

    if (url.pathname === "/settings/mcp/inspect") {
      await this.handleSettingsMcpInspect(req, res);
      return;
    }

    if (url.pathname === "/owner/llm-settings-proposal") {
      await this.handleOwnerLlmSettingsProposal(req, res);
      return;
    }
    if (url.pathname === "/owner/daily-brief-read") {
      await this.handleOwnerDailyBriefRead(req, res, url);
      return;
    }
    if (url.pathname === "/owner/task-submission-result") {
      await this.handleOwnerTaskSubmissionSavedResult(req, res, url);
      return;
    }

    if (url.pathname === "/runtime/snapshot") {
      await this.handleRuntimeSnapshot(req, res);
      return;
    }

    if (url.pathname === "/runtime/reconcile-results") {
      await this.handleRuntimeResultReconciliation(req, res);
      return;
    }

    if (url.pathname === "/approval" || url.pathname.startsWith("/approval/")) {
      await this.handleApproval(req, res, url);
      return;
    }

    if (url.pathname === "/audit/dump") {
      await this.handleAuditDump(req, res, url);
      return;
    }

    if (url.pathname === "/authority/trace") {
      await this.handleAuthorityTrace(req, res);
      return;
    }

    if (url.pathname === "/notifications") {
      await this.handleNotifications(req, res);
      return;
    }

    if (url.pathname === "/history" || url.pathname === "/history/replay") {
      await this.handleHistory(req, res, url);
      return;
    }

    if (url.pathname === "/evidence/export") {
      await this.handleEvidenceExport(req, res);
      return;
    }

    if (url.pathname === "/operators/writing" || url.pathname === "/operators/writing/invoke") {
      await this.handleOperator(req, res, url, "writing");
      return;
    }

    if (url.pathname === "/operators/daily" || url.pathname === "/operators/daily/invoke") {
      await this.handleOperator(req, res, url, "daily");
      return;
    }
    if (url.pathname === "/operators/developer" || url.pathname === "/operators/developer/invoke") {
      await this.handleOperator(req, res, url, "developer");
      return;
    }

    if (url.pathname === "/owner/goal-purpose-change-candidates") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.owner_token || !this.opts.onGoalPurposeChangeCandidates) {
        res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "goal_purpose_change_candidates_not_configured" }));
        return;
      }
      if (!this.checkAuth(req, "owner")) {
        res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.inbound, "owner-goal-purpose-token-holder", res)) return;
      try {
        const candidates = await this.opts.onGoalPurposeChangeCandidates({ actor: OWNER_TOKEN_ACTOR });
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify({ candidates }));
      } catch {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "goal_purpose_change_candidates_unavailable" }));
      }
      return;
    }

    if (url.pathname === "/owner/task-goals") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.owner_token || !this.opts.onOwnerTaskGoalOptions) {
        res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "owner_task_goals_not_configured" }));
        return;
      }
      if (!this.checkAuth(req, "owner")) {
        res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.inbound, "owner-task-token-holder", res)) return;
      try {
        const goals = await this.opts.onOwnerTaskGoalOptions({ actor: OWNER_TOKEN_ACTOR });
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify({ goals: goals.map(({ goal_ref, purpose_version, purpose_preview }) =>
          ({ goal_ref, purpose_version, purpose_preview })) }));
      } catch {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "owner_task_goals_unavailable" }));
      }
      return;
    }

    if (url.pathname === "/owner/goal-purpose-adoption") {
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
    }
    if (req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const tokenKind =
      url.pathname === "/resume"
        ? "resume"
        : url.pathname === "/owner/inbound" || url.pathname === "/owner/goal-purpose-change" ||
          url.pathname === "/owner/goal-purpose-adoption" ||
          url.pathname === "/owner/audio-transcribe" ||
          url.pathname === "/owner/task-compute" ||
          url.pathname === "/owner/task-submission-status" ||
          url.pathname === "/owner/task-submission-cancel" ||
          url.pathname === "/owner/goal-purpose-relation-review"
        ? "owner"
        : url.pathname === "/webhook"
        ? "webhook"
        : url.pathname === "/runtime/intent" || url.pathname === "/runtime/intent/status" ||
          url.pathname === "/runtime/intent/cancel" ||
          url.pathname === "/runtime/ws-ticket"
        ? "d4_runtime"
        : url.pathname === "/inbound" || url.pathname === "/ws-ticket"
        ? "inbound"
        : null;
    if (!tokenKind) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (tokenKind === "webhook" && !this.opts.webhook_token) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "webhook_not_configured" }));
      return;
    }
    if (tokenKind === "owner" && !this.opts.owner_token) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "owner_inbound_not_configured" }));
      return;
    }
    if (tokenKind === "d4_runtime" && !this.opts.d4_runtime_intent) {
      res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "runtime_intent_not_configured" }));
      return;
    }

    if (!this.checkAuth(req, tokenKind)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    let body: Record<string, unknown> | null;
    const isGoalPurposeAdoption = url.pathname === "/owner/goal-purpose-adoption";
    try {
      body = await readJson(req, url.pathname === "/owner/task-compute" || url.pathname === "/runtime/intent"
        ? MAX_MULTIMODAL_TASK_JSON_BYTES :
        url.pathname === "/owner/audio-transcribe" ? MAX_OWNER_AUDIO_TRANSCRIPTION_JSON_BYTES :
        isGoalPurposeAdoption ? 128 * 1024 : undefined, isGoalPurposeAdoption || tokenKind === "webhook");
    } catch (error) {
      if (error instanceof Error && error.message === "body_too_large") {
        res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "request_body_too_large" }));
        return;
      }
      throw error;
    }

    if (url.pathname === "/owner/task-submission-status") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      const submissionStore = this.opts.owner_task_submission_store;
      if (!submissionStore?.getStatus) {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "owner_task_submission_status_unavailable" }));
        return;
      }
      const submissionId = typeof body?.submission_id === "string" ? body.submission_id : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(submissionId)) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "invalid_owner_task_submission_id" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.inbound, "owner-task-token-holder", res)) return;
      try {
        const status = submissionStore.getStatus({ submission_id: submissionId });
        const taskOutcome = status && status.state !== "rejected" && this.opts.onOwnerTaskSubmissionOutcome
          ? normalizeTaskOutcome(await this.opts.onOwnerTaskSubmissionOutcome({ request_id: status.request_id }).catch(() => ({
              status: "unknown" as const,
              reason_code: "projection_unavailable" as const,
              used_for_authority: false as const,
              may_execute: false as const,
            })))
          : undefined;
        const executionObservation = status && status.state !== "rejected" && this.opts.onOwnerTaskSubmissionExecutionObservation
          ? normalizeTaskExecutionObservation(await this.opts.onOwnerTaskSubmissionExecutionObservation({ request_id: status.request_id })
              .catch(() => undefined))
          : undefined;
        const planSteps = status && status.state !== "rejected" && this.opts.onOwnerTaskSubmissionPlanSteps
          ? normalizeOwnerTaskPlanSteps(await this.opts.onOwnerTaskSubmissionPlanSteps({ request_id: status.request_id })
              .catch(() => undefined))
          : undefined;
        const cancellation = status && status.state !== "rejected" && this.opts.onOwnerTaskSubmissionCancellationStatus
          ? normalizeOwnerTaskCancellationStatus(await this.opts.onOwnerTaskSubmissionCancellationStatus({ request_id: status.request_id })
              .catch(() => ({ status: "unknown" as const, reason_code: "projection_unavailable" as const,
                used_for_authority: false as const, may_execute: false as const })))
          : undefined;
        const taskResult = status
          ? submissionStore.getOwnerTaskSubmissionResult?.({ request_id: status.request_id }) ?? {
              status: "unavailable" as const,
              reason_code: "result_store_unavailable" as const,
              used_for_authority: false as const,
              may_execute: false as const,
            }
          : undefined;
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify(status
          ? { found: true, request_id: status.request_id, state: status.state,
              ...(taskOutcome ? { task_outcome: taskOutcome } : {}),
              ...(executionObservation ? { execution_observation: executionObservation } : {}),
              ...(planSteps ? { plan_steps: planSteps } : {}),
              ...(cancellation ? { cancellation } : {}),
              ...(taskResult ? { result: taskResult } : {}) }
          : { found: false }));
      } catch {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "owner_task_submission_status_unavailable" }));
      }
      return;
    }

    if (url.pathname === "/owner/task-submission-cancel") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      const submissionStore = this.opts.owner_task_submission_store;
      if (!submissionStore?.getStatus || !this.opts.onOwnerTaskSubmissionCancellation) {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "owner_task_submission_cancellation_unavailable" }));
        return;
      }
      if (!body || Object.keys(body).some((key) => key !== "submission_id")) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "invalid_owner_task_submission_cancel_input" }));
        return;
      }
      const submissionId = typeof body.submission_id === "string" ? body.submission_id : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(submissionId)) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "invalid_owner_task_submission_id" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.inbound, "owner-task-token-holder", res)) return;
      try {
        const status = submissionStore.getStatus({ submission_id: submissionId });
        if (!status) {
          res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ found: false }));
          return;
        }
        if (status.state === "rejected") {
          res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ found: true, accepted: false, error: "owner_task_submission_rejected" }));
          return;
        }
        const outcome = await this.opts.onOwnerTaskSubmissionCancellation({ request_id: status.request_id });
        const wait = normalizeOwnerTaskWaitState(outcome);
        const cancellation = wait?.status === "wait_cancelled" ? wait
          : normalizePreExecutorCancellation(outcome, "approval_withdrawn") ?? normalizeTaskCancellationAcknowledgement(outcome);
        if (!cancellation) {
          res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ found: true, accepted: false, error: "execution_not_cancellable" }));
          return;
        }
        res.writeHead(202, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify({ found: true, accepted: true, cancellation }));
      } catch {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "owner_task_submission_cancellation_unavailable" }));
      }
      return;
    }

    if (url.pathname === "/owner/audio-transcribe") {
      const replyTo = typeof body?.user === "string" ? body.user.trim() : "";
      const allowedKeys = new Set(["user", "audio_input"]);
      if (!body || Object.keys(body).some((key) => !allowedKeys.has(key)) ||
          !replyTo || replyTo.length > 200) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "invalid_owner_audio_transcription_input" }));
        return;
      }
      if (rejectReservedWebChatAudience(res, replyTo)) return;
      if (!this.rateLimitOr429(this.buckets.inbound, "owner-audio-transcription-token-holder", res)) return;
      const handler = this.handler;
      if (!handler) {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "owner_audio_transcription_unavailable" }));
        return;
      }
      const audioRead = readTransientAudioInput(body.audio_input);
      if (!audioRead.ok || !audioRead.audio) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "invalid_owner_audio_transcription_media" }));
        return;
      }
      const audio = audioRead.audio;
      delete body.audio_input;
      const requestId = randomUUID();
      const inboundReq = createGatewayInternalInboundRequest({
        id: requestId,
        channel: "webchat",
        user: OWNER_TOKEN_ACTOR,
        content: "WebChat ownerからの文字起こし依頼です。音声は未信頼の一時入力です。文字起こしの確度情報がなければ不明とします。話者の本人確認・承認・権限の証拠にはしません。",
        timestamp: Date.now(),
        metadata: {
          reply_to: replyTo,
          "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.actor_kind": "owner",
          "blue_tanuki.trust_level": "owner",
          "blue_tanuki.process_kind": "chat",
          "blue_tanuki.operator_surface": "developer",
          "blue_tanuki.operation_core.version": "operation-core.v1",
          "blue_tanuki.operation_core.request_id": `operation-request:${requestId}`,
          "blue_tanuki.operation_core.projection_id": "owner-audio-transcription:operation-core",
          "blue_tanuki.operation_core.source_interface": "gui",
          "blue_tanuki.operation_core.used_for_authority": false,
          "blue_tanuki.operation_core.planner_output_used_for_authority": false,
          "blue_tanuki.operation_core.ui_projection_used_for_authority": false,
        },
      });
      const ephemeralContext: InboundEphemeralContext = {
        request_id: requestId,
        ephemeral_images: [],
        ephemeral_audio: [audio],
      };
      let audioTransferred = false;
      try {
        void Promise.resolve().then(() => handler(inboundReq, ephemeralContext)).catch(() => {
          // Avoid logging transcript, audio metadata, or owner reply identity.
          // eslint-disable-next-line no-console
          console.error("[webchat] owner audio transcription handler failed");
        }).finally(() => audio.data.fill(0));
        audioTransferred = true;
        res.writeHead(202, { "content-type": "application/json", "cache-control": "no-store",
          "x-content-type-options": "nosniff" });
        res.end(JSON.stringify({ accepted: true, request_id: requestId, status: "queued_for_hds_decision" }));
      } catch {
        if (!audioTransferred) audio.data.fill(0);
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "owner_audio_transcription_unavailable" }));
      }
      return;
    }

    if (url.pathname === "/owner/task-compute") {
      if (!this.opts.onOwnerTaskGoalOptions) {
        res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "owner_task_compute_not_configured" }));
        return;
      }
      const submissionStore = this.opts.owner_task_submission_store;
      if (!submissionStore) {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "owner_task_submission_store_unavailable" }));
        return;
      }
      const replyTo = typeof body?.user === "string" ? body.user.trim() : "";
      const task = typeof body?.task === "string" ? body.task.trim() : "";
      const goalRef = typeof body?.goal_ref === "string" ? body.goal_ref : "";
      const submissionId = typeof body?.submission_id === "string" ? body.submission_id : "";
      const hasMcpCatalogSelection = body !== null && Object.prototype.hasOwnProperty.call(body, "include_mcp_catalog");
      const includeMcpCatalog = body?.include_mcp_catalog === true;
      const hasPurposeVersion = body !== null && Object.prototype.hasOwnProperty.call(body, "purpose_version");
      const requestedPurposeVersion = body?.purpose_version;
      if (!replyTo || replyTo.length > 200 || !task || task.length > 20_000 || !isWellFormedUnicode(task) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(submissionId) ||
          !/^goal_[a-f0-9]{16,64}$/.test(goalRef) ||
          (hasMcpCatalogSelection && typeof body?.include_mcp_catalog !== "boolean") ||
          (hasPurposeVersion && (typeof requestedPurposeVersion !== "number" ||
            !Number.isSafeInteger(requestedPurposeVersion) || requestedPurposeVersion < 1))) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "invalid_owner_task_input" }));
        return;
      }
      if (rejectReservedWebChatAudience(res, replyTo)) return;
      const hasGoalCompletionRules = body !== null && Object.prototype.hasOwnProperty.call(body, "goal_completion_rules");
      let goalCompletionRules: GoalCompletionRules | undefined;
      if (hasGoalCompletionRules) {
        try {
          const parsedRules = GoalCompletionRulesSchema.safeParse(body?.goal_completion_rules);
          if (!parsedRules.success) throw new Error("invalid");
          goalCompletionRules = parsedRules.data;
        } catch {
          res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ accepted: false, error: "invalid_owner_task_completion_rules" }));
          return;
        }
      }
      if (!this.rateLimitOr429(this.buckets.inbound, "owner-task-token-holder", res)) return;
      const handler = this.handler;
      if (!handler) {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "owner_task_compute_unavailable" }));
        return;
      }
      const imageRead = readTransientImageInput(body?.image_input);
      if (!imageRead.ok) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "invalid_owner_task_image" }));
        return;
      }
      const ownerTaskImage = imageRead.image;
      const audioRead = readTransientAudioInput(body?.audio_input);
      if (!audioRead.ok) {
        ownerTaskImage?.data.fill(0);
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "invalid_owner_task_audio" }));
        return;
      }
      const ownerTaskAudio = audioRead.audio;
      const canvasArtifactRead = readOwnerTaskCanvasArtifact(body?.canvas_artifact_input);
      if (!canvasArtifactRead.ok) {
        ownerTaskImage?.data.fill(0);
        ownerTaskAudio?.data.fill(0);
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "invalid_owner_task_canvas_artifact" }));
        return;
      }
      const ownerTaskCanvasArtifact = canvasArtifactRead.artifact;
      const canvasTaskReference = readCanvasOperationTaskReference(task);
      const submittedCanvasArtifactReference = body?.canvas_artifact_input &&
        typeof body.canvas_artifact_input === "object" && !Array.isArray(body.canvas_artifact_input)
        ? readCanvasArtifactReference((body.canvas_artifact_input as Record<string, unknown>).artifact_reference)
        : null;
      if (canvasTaskReference.kind === "invalid" ||
          (canvasTaskReference.kind === "valid" && (!ownerTaskCanvasArtifact ||
            !submittedCanvasArtifactReference ||
            !sameCanvasArtifactReference(canvasTaskReference.reference, submittedCanvasArtifactReference))) ||
          (canvasTaskReference.kind !== "valid" && ownerTaskCanvasArtifact !== undefined)) {
        ownerTaskImage?.data.fill(0);
        ownerTaskAudio?.data.fill(0);
        ownerTaskCanvasArtifact?.data.fill(0);
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "canvas_artifact_input_task_mismatch" }));
        return;
      }
      if (body) {
        delete body.image_input;
        delete body.audio_input;
        delete body.canvas_artifact_input;
      }
      const requestId = randomUUID();
      const payloadDigest = createHash("sha256").update(JSON.stringify([
        "webchat-owner-task-payload.v1",
        replyTo,
        task,
        goalRef,
        hasPurposeVersion,
        hasPurposeVersion ? requestedPurposeVersion : null,
        goalCompletionRules ?? null,
        // Keep the historical digest stable for opt-out requests while binding explicit catalog opt-in.
        ...(includeMcpCatalog ? ["include_mcp_catalog", true] : []),
        ownerTaskImage ? {
          media_type: ownerTaskImage.media_type,
          byte_length: ownerTaskImage.data.byteLength,
          digest: createHash("sha256").update(ownerTaskImage.data).digest("hex"),
        } : null,
        ownerTaskAudio ? {
          format: ownerTaskAudio.format,
          byte_length: ownerTaskAudio.data.byteLength,
          digest: createHash("sha256").update(ownerTaskAudio.data).digest("hex"),
        } : null,
        ownerTaskCanvasArtifact ? {
          media_type: ownerTaskCanvasArtifact.media_type,
          byte_length: ownerTaskCanvasArtifact.data.byteLength,
          sha256: ownerTaskCanvasArtifact.sha256,
          source_request_id: ownerTaskCanvasArtifact.source_request_id,
          version: ownerTaskCanvasArtifact.version,
        } : null,
      ]), "utf8").digest("hex");
      let claimedRequestId: string | undefined;
      let handlerStarted = false;
      let imageTransferred = false;
      let audioTransferred = false;
      let canvasArtifactTransferred = false;
      try {
        const claim = submissionStore.claim({
          submission_id: submissionId,
          payload_digest: payloadDigest,
          request_id: requestId,
        });
        if (claim.status === "identity_conflict") {
          res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ accepted: false, status: "submission_id_reused_with_different_input",
            request_id: claim.request_id }));
          return;
        }
        if (claim.status === "duplicate") {
          if (claim.state === "dispatching" || claim.state === "handler_returned") {
            res.writeHead(202, { "content-type": "application/json", "cache-control": "no-store",
              "x-content-type-options": "nosniff" });
            res.end(JSON.stringify({ accepted: true, request_id: claim.request_id,
              status: claim.state === "dispatching" ? "already_in_progress" : "already_accepted" }));
          } else {
            res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(JSON.stringify({ accepted: false,
              status: claim.state === "outcome_unknown" ? "owner_task_submission_outcome_unknown" :
                "owner_task_submission_already_rejected",
              request_id: claim.request_id }));
          }
          return;
        }
        claimedRequestId = claim.request_id;
        const goals = await this.opts.onOwnerTaskGoalOptions({ actor: OWNER_TOKEN_ACTOR });
        const goal = goals.find((candidate) => candidate.goal_ref === goalRef);
        if (!goal) {
          submissionStore.markRejected(claim.request_id);
          res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ accepted: false, status: "delegated_task_purpose_unavailable",
            request_id: claim.request_id }));
          return;
        }
        if (hasPurposeVersion && goal.purpose_version !== requestedPurposeVersion) {
          submissionStore.markRejected(claim.request_id);
          res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ accepted: false, status: "delegated_task_purpose_changed",
            request_id: claim.request_id }));
          return;
        }
        const binding = {
          goal_ref: goal.goal_ref,
          purpose_version: goal.purpose_version,
          purpose_digest: goal.purpose_digest,
        };
        const inboundReq: InboundRequest = createGatewayInternalInboundRequest({
          id: requestId,
          channel: "webchat",
          user: OWNER_TOKEN_ACTOR,
          content: `plan:compute ${JSON.stringify({ task, goal_purpose_binding: binding,
            ...(includeMcpCatalog ? { include_mcp_catalog: true } : {}) })}`,
          timestamp: Date.now(),
          session_id: `webchat-owner-task:${requestId}`,
          ...(goalCompletionRules ? { goal_completion_rules: goalCompletionRules } : {}),
          metadata: {
            reply_to: replyTo,
            "blue_tanuki.authority_context": "gateway_internal_v1",
            "blue_tanuki.actor_kind": "owner",
            "blue_tanuki.trust_level": "owner",
            "blue_tanuki.process_kind": "chat",
            "blue_tanuki.operator_surface": "developer",
            "blue_tanuki.operation_core.version": "operation-core.v1",
            "blue_tanuki.operation_core.request_id": `operation-request:${requestId}`,
            "blue_tanuki.operation_core.projection_id": "owner-task:operation-plan",
            "blue_tanuki.operation_core.source_interface": "gui",
            "blue_tanuki.operation_core.used_for_authority": false,
            "blue_tanuki.operation_core.planner_output_used_for_authority": false,
            "blue_tanuki.operation_core.ui_projection_used_for_authority": false,
            ...(ownerTaskCanvasArtifact ? {
              "blue_tanuki.canvas_artifact.mime": ownerTaskCanvasArtifact.media_type,
              "blue_tanuki.canvas_artifact.sha256": ownerTaskCanvasArtifact.sha256,
              "blue_tanuki.canvas_artifact.version": ownerTaskCanvasArtifact.version,
              "blue_tanuki.canvas_artifact.source_request_id": ownerTaskCanvasArtifact.source_request_id,
              "blue_tanuki.canvas_artifact.reference_is_ephemeral": true,
              "blue_tanuki.canvas_artifact.used_for_authority": false,
            } : {}),
          },
        });
        handlerStarted = true;
        const ephemeralContext: InboundEphemeralContext | undefined = ownerTaskImage || ownerTaskAudio || ownerTaskCanvasArtifact
          ? {
            request_id: requestId,
            ephemeral_images: ownerTaskImage ? [ownerTaskImage] : [],
            ...(ownerTaskAudio ? { ephemeral_audio: [ownerTaskAudio] } : {}),
            ...(ownerTaskAudio ? { require_audio_task_compute: true } : {}),
            ...(ownerTaskCanvasArtifact ? { ephemeral_canvas_artifact: ownerTaskCanvasArtifact } : {}),
          }
          : undefined;
        imageTransferred = ownerTaskImage !== undefined;
        audioTransferred = ownerTaskAudio !== undefined;
        canvasArtifactTransferred = ownerTaskCanvasArtifact !== undefined;
        void Promise.resolve().then(() => handler(inboundReq, ephemeralContext)).then(() => {
          submissionStore.markHandlerReturned(requestId);
        }).catch(() => {
          try { submissionStore.markOutcomeUnknown(requestId); } catch { /* keep replay blocked if state is unavailable */ }
          // Avoid logging owner task content or reply identity.
          // eslint-disable-next-line no-console
          console.error("[webchat] owner task handler error");
          this.notifyOwnerTaskProcessingFailure(replyTo, requestId);
        }).finally(() => {
          ownerTaskImage?.data.fill(0);
          ownerTaskAudio?.data.fill(0);
          ownerTaskCanvasArtifact?.data.fill(0);
        });
        res.writeHead(202, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify({ accepted: true, request_id: requestId, status: "queued_for_hds_decision" }));
      } catch {
        if (claimedRequestId) {
          try {
            if (handlerStarted) submissionStore.markOutcomeUnknown(claimedRequestId);
            else submissionStore.markRejected(claimedRequestId);
          } catch { /* keep replay blocked if state is unavailable */ }
        }
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, status: handlerStarted
          ? "owner_task_submission_outcome_unknown" : "owner_task_submission_not_dispatched",
        error: "owner_task_compute_unavailable" }));
      } finally {
        if (!imageTransferred) ownerTaskImage?.data.fill(0);
        if (!audioTransferred) ownerTaskAudio?.data.fill(0);
        if (!canvasArtifactTransferred) ownerTaskCanvasArtifact?.data.fill(0);
      }
      return;
    }

    if (url.pathname === "/runtime/ws-ticket") {
      const parsed = RuntimeSessionInputSchema.safeParse(body);
      if (!parsed.success) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "invalid_runtime_session" }));
        return;
      }
      const config = this.opts.d4_runtime_intent!;
      if (parsed.data.runtime_id !== config.runtime_id) {
        res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "runtime_not_registered" }));
        return;
      }
      const sessionIdDigest = d4RuntimeReferenceDigest(config.token, "session", parsed.data.session_id);
      const sessionScope = `${D4_RUNTIME_SESSION_PREFIX}${sessionIdDigest}`;
      if (!this.rateLimitOr429(this.buckets.ws_ticket, D4_RUNTIME_TOKEN_ACTOR, res)) return;
      const issued = await this.ticketStore.issue(sessionScope, this.ticketTtlMs);
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify({
        ticket: issued.ticket,
        expires_in_sec: Math.max(0, Math.floor((issued.expires_at_ms - Date.now()) / 1000)),
        session_ref_digest: sessionIdDigest,
      }));
      return;
    }

    if (url.pathname === "/runtime/intent") {
      const imageInput = body?.image_input;
      const audioInput = body?.audio_input;
      if (body) {
        delete body.image_input;
        delete body.audio_input;
      }
      if (body !== null && Object.prototype.hasOwnProperty.call(body, "goal_completion_rules")) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({
          accepted: false,
          error: "runtime_intent_completion_rules_owner_required",
        }));
        return;
      }
      const parsed = RuntimeIntentInputSchema.safeParse(body);
      if (!parsed.success || !parsed.data.intent.trim() || !isWellFormedUnicode(parsed.data.intent)) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "invalid_runtime_intent" }));
        return;
      }
      const config = this.opts.d4_runtime_intent!;
      if (parsed.data.runtime_id !== config.runtime_id) {
        res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "runtime_not_registered" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.inbound, D4_RUNTIME_TOKEN_ACTOR, res)) return;
      if (isDirectToolShortcutContent(parsed.data.intent)) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({
          accepted: false,
          error: "tool_shortcut_not_allowed_on_runtime_intent",
          operation_core_required: true,
        }));
        return;
      }

      const handler = this.handler;
      if (!handler) {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "runtime_intent_handler_unavailable" }));
        return;
      }

      const submissionStore = this.opts.owner_task_submission_store;
      if (!submissionStore || typeof submissionStore.claimD4RuntimeIntent !== "function") {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "runtime_intent_submission_store_unavailable" }));
        return;
      }
      const imageRead = readTransientImageInput(imageInput);
      const audioRead = readTransientAudioInput(audioInput);
      if (!imageRead.ok || !audioRead.ok) {
        if (imageRead.ok) imageRead.image?.data.fill(0);
        if (audioRead.ok) audioRead.audio?.data.fill(0);
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "invalid_runtime_intent_attachment" }));
        return;
      }
      const runtimeImage = imageRead.image;
      const runtimeAudio = audioRead.audio;
      let transientTransferred = false;
      try {
        const runtimeIdDigest = d4RuntimeReferenceDigest(config.token, "runtime", parsed.data.runtime_id);
        const sessionIdDigest = d4RuntimeReferenceDigest(config.token, "session", parsed.data.session_id);
        const sessionScope = `${D4_RUNTIME_SESSION_PREFIX}${sessionIdDigest}`;
        const scopeDigest = d4RuntimeIntentScopeDigest(parsed.data.runtime_id, parsed.data.session_id);
        const payloadDigest = d4RuntimeIntentPayloadDigest(
          config.token, parsed.data.runtime_id, parsed.data.session_id, parsed.data.intent,
          {
            ...(runtimeImage ? { image: runtimeImage } : {}),
            ...(runtimeAudio ? { audio: runtimeAudio } : {}),
          },
        );
        const responseChannelConnected = this.connectionCount(sessionScope) > 0;
        let claim;
        try {
          claim = submissionStore.claimD4RuntimeIntent({
            submission_id: parsed.data.submission_id,
            payload_digest: payloadDigest,
            scope_digest: scopeDigest,
            request_id: randomUUID(),
            dispatch_available: responseChannelConnected,
            response_target: sessionScope,
          });
        } catch {
          res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ accepted: false, error: "runtime_intent_submission_store_unavailable" }));
          return;
        }
        if (claim.status === "not_dispatched") {
          res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({
            accepted: false,
            status: "not_dispatched",
            error: "runtime_response_channel_not_connected",
          }));
          return;
        }
        if (claim.status === "identity_conflict") {
          res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ accepted: false, error: "runtime_intent_submission_id_conflict" }));
          return;
        }
        if (claim.status === "duplicate" && claim.state === "rejected") {
          res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ accepted: false, request_id: claim.request_id, state: claim.state }));
          return;
        }
        if (claim.status === "duplicate") {
          res.writeHead(202, {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          res.end(JSON.stringify({
            accepted: true,
            duplicate: true,
            request_id: claim.request_id,
            state: claim.state,
            session_ref_digest: sessionIdDigest,
          }));
          return;
        }
        const inboundReq = createGatewayInternalInboundRequest({
          id: claim.request_id,
          channel: "webchat",
          user: D4_RUNTIME_TOKEN_ACTOR,
          content: parsed.data.intent,
          timestamp: Date.now(),
          session_id: sessionScope,
          metadata: {
            reply_to: sessionScope,
            "blue_tanuki.authority_context": "gateway_internal_v1",
            "blue_tanuki.actor_kind": "user",
            "blue_tanuki.trust_level": "limited",
            "blue_tanuki.process_kind": "chat",
            "blue_tanuki.runtime_ingress.version": "d4-runtime-intent.v1",
            "blue_tanuki.runtime_ingress.runtime_id_digest": runtimeIdDigest,
            "blue_tanuki.runtime_ingress.session_id_digest": sessionIdDigest,
            "blue_tanuki.runtime_ingress.used_for_authority": false,
          },
        });
        const ephemeralContext: InboundEphemeralContext | undefined = runtimeImage || runtimeAudio
          ? {
            request_id: inboundReq.id,
            ephemeral_images: runtimeImage ? [runtimeImage] : [],
            ...(runtimeAudio ? { ephemeral_audio: [runtimeAudio], require_audio_task_compute: true } : {}),
          }
          : undefined;
        const markOutcomeUnknown = () => {
          try {
            submissionStore.markD4RuntimeIntentOutcomeUnknown({
              request_id: claim.request_id,
              scope_digest: scopeDigest,
            });
          } catch { /* retain the durable claim even if state recording is unavailable */ }
        };
        const reportHandlerFailure = () => {
          // Keep caller-provided Runtime/Session references and intent out of logs.
          // eslint-disable-next-line no-console
          console.error("[webchat] D4 Runtime intent handler error");
          this.notifyD4RuntimeIntentProcessingFailure(sessionScope, claim.request_id);
        };
        transientTransferred = true;
        // 受付応答のあと一度制御を戻し、待機中の取消を処理できるようにする。
        void waitForImmediate().then(() => handler(inboundReq, ephemeralContext)).then(() => {
          try {
            submissionStore.markD4RuntimeIntentHandlerReturned({
              request_id: claim.request_id,
              scope_digest: scopeDigest,
            });
          } catch {
            markOutcomeUnknown();
            reportHandlerFailure();
          }
        }, () => {
          markOutcomeUnknown();
          reportHandlerFailure();
        }).finally(() => {
          runtimeImage?.data.fill(0);
          runtimeAudio?.data.fill(0);
        });
        res.writeHead(202, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify({
          accepted: true,
          duplicate: false,
          request_id: inboundReq.id,
          state: "dispatching",
          session_ref_digest: sessionIdDigest,
        }));
        return;
      } finally {
        if (!transientTransferred) {
          runtimeImage?.data.fill(0);
          runtimeAudio?.data.fill(0);
        }
      }
    }

    if (url.pathname === "/runtime/intent/status") {
      const parsed = RuntimeIntentStatusInputSchema.safeParse(body);
      if (!parsed.success) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "invalid_runtime_intent_status" }));
        return;
      }
      const config = this.opts.d4_runtime_intent!;
      if (parsed.data.runtime_id !== config.runtime_id) {
        res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "runtime_not_registered" }));
        return;
      }
      const submissionStore = this.opts.owner_task_submission_store;
      if (!submissionStore || typeof submissionStore.getD4RuntimeIntentStatus !== "function") {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "runtime_intent_status_unavailable" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.inbound, D4_RUNTIME_TOKEN_ACTOR, res)) return;
      const scopeDigest = d4RuntimeIntentScopeDigest(parsed.data.runtime_id, parsed.data.session_id);
      try {
        const status = submissionStore.getD4RuntimeIntentStatus({
          submission_id: parsed.data.submission_id,
          scope_digest: scopeDigest,
        });
        const scope = status ? { request_id: status.request_id, scope_digest: scopeDigest,
          runtime_ref_digest: d4RuntimeReferenceDigest(config.token, "runtime", parsed.data.runtime_id),
          session_ref_digest: d4RuntimeReferenceDigest(config.token, "session", parsed.data.session_id) } : null;
        let cancellationStatus: WebChatD4RuntimeCancellationStatus | undefined;
        if (scope && this.opts.onD4RuntimeIntentCancellationStatus) {
          const cancellation = await this.opts.onD4RuntimeIntentCancellationStatus(scope)
            .catch(() => ({ status: "unknown" as const, reason_code: "projection_unavailable" as const,
              used_for_authority: false as const, may_execute: false as const }));
          cancellationStatus = normalizePreExecutorCancellation(cancellation, "cancelled_before_dispatch") ??
            normalizeTaskCancellationStatus(cancellation);
        }
        const state = cancellationStatus?.status === "cancelled_before_dispatch" ? "rejected" : status?.state;
        const taskOutcome = status && state !== "rejected" && this.opts.onD4RuntimeIntentTaskOutcome
          ? normalizeTaskOutcome(await this.opts.onD4RuntimeIntentTaskOutcome({ request_id: status.request_id }).catch(() => ({
              status: "unknown" as const,
              reason_code: "projection_unavailable" as const,
              used_for_authority: false as const,
              may_execute: false as const,
            })))
          : undefined;
        const executionObservation = scope && state !== "rejected" && this.opts.onD4RuntimeIntentExecutionObservation
          ? normalizeTaskExecutionObservation(await this.opts.onD4RuntimeIntentExecutionObservation(scope).catch(() => undefined))
          : undefined;
        const result = status
          ? state === "rejected"
            ? { status: "unavailable" as const, reason_code: "not_retained" as const,
                used_for_authority: false as const, may_execute: false as const }
            : submissionStore.getD4RuntimeIntentResult?.({ request_id: status.request_id, scope_digest: scopeDigest }) ?? {
                status: "unavailable" as const,
                reason_code: "result_store_unavailable" as const,
                used_for_authority: false as const,
                may_execute: false as const,
              }
          : undefined;
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify(status
          ? { found: true, request_id: status.request_id, state,
              ...(taskOutcome ? { task_outcome: taskOutcome } : {}),
              ...(cancellationStatus ? { cancellation: cancellationStatus } : {}),
              ...(executionObservation ? { execution_observation: executionObservation } : {}),
              ...(result ? { result } : {}) }
          : { found: false }));
      } catch {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "runtime_intent_status_unavailable" }));
      }
      return;
    }

    if (url.pathname === "/runtime/intent/cancel") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      const parsed = RuntimeIntentStatusInputSchema.safeParse(body);
      if (!parsed.success) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "invalid_runtime_intent_cancel" }));
        return;
      }
      const config = this.opts.d4_runtime_intent!;
      if (parsed.data.runtime_id !== config.runtime_id) {
        res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "runtime_not_registered" }));
        return;
      }
      const submissionStore = this.opts.owner_task_submission_store;
      if (!submissionStore || typeof submissionStore.getD4RuntimeIntentStatus !== "function" ||
          !this.opts.onD4RuntimeIntentCancellation) {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "runtime_intent_cancellation_unavailable" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.inbound, D4_RUNTIME_TOKEN_ACTOR, res)) return;
      const scopeDigest = d4RuntimeIntentScopeDigest(parsed.data.runtime_id, parsed.data.session_id);
      try {
        const status = submissionStore.getD4RuntimeIntentStatus({
          submission_id: parsed.data.submission_id,
          scope_digest: scopeDigest,
        });
        if (!status) {
          res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ found: false }));
          return;
        }
        const cancellation = await this.opts.onD4RuntimeIntentCancellation({
          request_id: status.request_id,
          scope_digest: scopeDigest,
          runtime_ref_digest: d4RuntimeReferenceDigest(config.token, "runtime", parsed.data.runtime_id),
          session_ref_digest: d4RuntimeReferenceDigest(config.token, "session", parsed.data.session_id),
        });
        if (!cancellation) {
          res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ found: true, accepted: false, error: "execution_not_cancellable" }));
          return;
        }
        const acknowledgement = normalizePreExecutorCancellation(cancellation, "cancelled_before_dispatch") ??
          normalizePreExecutorCancellation(cancellation, "approval_withdrawn") ??
          normalizeTaskCancellationAcknowledgement(cancellation, true);
        if (!acknowledgement) {
          res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: "runtime_intent_cancellation_unavailable" }));
          return;
        }
        res.writeHead(202, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify({ found: true, accepted: true, cancellation: acknowledgement }));
      } catch {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "runtime_intent_cancellation_unavailable" }));
      }
      return;
    }

    if (isGoalPurposeAdoption) {
      const headers = { "content-type": "application/json", "cache-control": "no-store" };
      const purpose_text = body?.purpose_text;
      if (!this.opts.onGoalPurposeAdoption) {
        res.writeHead(404, headers);
        res.end(JSON.stringify({ error: "goal_purpose_adoption_not_configured" }));
        return;
      }
      if (Object.keys(body ?? {}).length !== 1 || typeof purpose_text !== "string" ||
          !purpose_text.trim() || !isWellFormedUnicode(purpose_text)) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: "valid purpose_text is required" }));
        return;
      }
      if (Buffer.byteLength(purpose_text, "utf8") > 16 * 1024) {
        res.writeHead(413, headers);
        res.end(JSON.stringify({ error: "purpose_text_too_large" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.inbound, "owner-goal-purpose-token-holder", res)) return;
      try {
        const result = await this.opts.onGoalPurposeAdoption({ purpose_text, actor: OWNER_TOKEN_ACTOR });
        if (result.accepted !== true) {
          res.writeHead(409, headers);
          res.end(JSON.stringify({ accepted: false, status: "goal_purpose_adoption_not_accepted" }));
          return;
        }
        const { command_id, request_id, goal_ref, purpose_digest } = result;
        if (typeof command_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(command_id) ||
            typeof request_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request_id) ||
            typeof goal_ref !== "string" || !/^goal_[a-f0-9]{16,64}$/.test(goal_ref) ||
            typeof purpose_digest !== "string" || !/^[a-f0-9]{64}$/.test(purpose_digest)) {
          throw new Error("invalid_goal_purpose_adoption_receipt");
        }
        res.writeHead(202, headers);
        res.end(JSON.stringify({ accepted: true, status: "approval_required", command_id, request_id, goal_ref, purpose_digest }));
      } catch {
        res.writeHead(503, headers);
        res.end(JSON.stringify({ accepted: false, status: "goal_purpose_adoption_unavailable" }));
      }
      return;
    }

    if (url.pathname === "/owner/goal-purpose-change") {
      const goal_ref = typeof body?.goal_ref === "string" ? body.goal_ref : "";
      const purpose_text = typeof body?.purpose_text === "string" ? body.purpose_text : "";
      const source_command_id = typeof body?.source_command_id === "string" ? body.source_command_id : undefined;
      if (!this.opts.onGoalPurposeChangeProposal) {
        res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "goal_purpose_change_not_configured" }));
        return;
      }
      if (!/^goal_[a-f0-9]{16,64}$/.test(goal_ref) || !purpose_text.trim() || !isWellFormedUnicode(purpose_text)) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "valid goal_ref and well-formed purpose_text are required" }));
        return;
      }
      if (Buffer.byteLength(purpose_text, "utf8") > 16 * 1024) {
        res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "purpose_text_too_large" }));
        return;
      }
      if (source_command_id !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(source_command_id)) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "invalid_source_command_id" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.inbound, "owner-goal-purpose-token-holder", res)) return;
      try {
        const result = await this.opts.onGoalPurposeChangeProposal({
          goal_ref,
          purpose_text,
          actor: OWNER_TOKEN_ACTOR,
          ...(source_command_id ? { source_command_id } : {}),
        });
        res.writeHead(result.accepted ? 202 : 409, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, status: "goal_purpose_change_unavailable" }));
      }
      return;
    }

    if (url.pathname === "/owner/goal-purpose-relation-review") {
      const plan_id_digest = typeof body?.plan_id_digest === "string" ? body.plan_id_digest : "";
      const revision_digest = typeof body?.revision_digest === "string" ? body.revision_digest : "";
      const outcome = body?.outcome;
      if (!this.opts.onGoalPurposeRelationReviewProposal) {
        res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "goal_purpose_relation_review_not_configured" }));
        return;
      }
      if (!/^[a-f0-9]{64}$/.test(plan_id_digest) || !/^[a-f0-9]{64}$/.test(revision_digest) ||
          !["supports", "conflicts", "unknown"].includes(String(outcome))) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "valid plan/revision digests and outcome are required" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.inbound, "owner-purpose-relation-token-holder", res)) return;
      try {
        const result = await this.opts.onGoalPurposeRelationReviewProposal({
          plan_id_digest,
          revision_digest,
          outcome: outcome as "supports" | "conflicts" | "unknown",
          actor: OWNER_TOKEN_ACTOR,
        });
        res.writeHead(result.accepted ? 202 : 409, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, status: "goal_purpose_relation_review_unavailable" }));
      }
      return;
    }

    if (url.pathname === "/ws-ticket") {
      const user = typeof body?.user === "string" ? body.user.trim() : "";
      if (!user) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "user is required string" }));
        return;
      }
      if (rejectReservedWebChatAudience(res, user)) return;
      if (!this.rateLimitOr429(this.buckets.ws_ticket, user, res)) return;
      const issued = await this.ticketStore.issue(user, this.ticketTtlMs);
      const expires_in_sec = Math.max(
        0,
        Math.floor((issued.expires_at_ms - Date.now()) / 1000),
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ticket: issued.ticket, expires_in_sec }));
      return;
    }

    if (url.pathname === "/inbound") {
      const user = typeof body?.user === "string" ? body.user : null;
      const content = typeof body?.content === "string" ? body.content : null;
      if (!user || !content) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: "user and content are required strings" }),
        );
        return;
      }
      if (rejectReservedWebChatAudience(res, user)) return;
      if (!this.rateLimitOr429(this.buckets.inbound, user, res)) return;
      if (isDirectToolShortcutContent(content)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "tool_shortcut_not_allowed_on_webchat_inbound",
            accepted: false,
            operation_core_required: true,
          }),
        );
        return;
      }
      const inboundReq: InboundRequest = {
        id: randomUUID(),
        channel: "webchat",
        // `user` is an unauthenticated reply destination. Keep it in metadata;
        // the audit/approval actor is only the credential class validated above.
        user: INBOUND_TOKEN_ACTOR,
        content,
        timestamp: Date.now(),
        metadata: { reply_to: user },
      };
      this.handler?.(inboundReq).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[webchat] inbound handler error:", e);
      });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ accepted: true, request_id: inboundReq.id }),
      );
      return;
    }

    if (url.pathname === "/owner/inbound") {
      const replyTo = typeof body?.user === "string" ? body.user : null;
      const content = typeof body?.content === "string" ? body.content : null;
      const planId = typeof body?.plan_id === "string" ? body.plan_id : undefined;
      const revisionDigest = typeof body?.revision_digest === "string" ? body.revision_digest : undefined;
      const waitId = typeof body?.wait_id === "string" ? body.wait_id : undefined;
      if (!replyTo || !content) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "user and content are required strings" }));
        return;
      }
      if (rejectReservedWebChatAudience(res, replyTo)) return;
      if ((planId === undefined) !== (revisionDigest === undefined) ||
          (planId !== undefined && (!/^[a-f0-9]{64}$/.test(planId) || !/^[a-f0-9]{64}$/.test(revisionDigest!))) ||
          (body && Object.hasOwn(body, "wait_id") && (!planId || !revisionDigest || !waitId || !/^[a-f0-9]{64}$/.test(waitId)))) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: false, error: "invalid_owner_wait_binding" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.inbound, "owner-token-holder", res)) return;
      if (isDirectToolShortcutContent(content)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: "tool_shortcut_not_allowed_on_webchat_inbound",
          accepted: false,
          operation_core_required: true,
        }));
        return;
      }
      const requestId = randomUUID();
      const inboundRequest: InboundRequest = {
        id: requestId,
        channel: "webchat",
        // Credential possession marks source class only; HDS still decides and authorizes.
        user: OWNER_TOKEN_ACTOR,
        content,
        timestamp: Date.now(),
        ...(planId && revisionDigest ? { session_id: ownerPlanWaitSessionId(planId, revisionDigest) } : {}),
        metadata: { reply_to: replyTo },
      };
      const inboundReq: InboundRequest = planId && revisionDigest
        ? createGatewayInternalInboundRequest({
            ...inboundRequest,
            metadata: {
              reply_to: replyTo,
              "blue_tanuki.authority_context": "gateway_internal_v1",
              "blue_tanuki.actor_kind": "owner",
              "blue_tanuki.trust_level": "owner",
              "blue_tanuki.process_kind": "chat",
              "blue_tanuki.operator_surface": "developer",
              "blue_tanuki.operation_core.version": "operation-core.v1",
              "blue_tanuki.operation_core.request_id": `operation-request:${requestId}`,
              "blue_tanuki.operation_core.projection_id": "owner-plan-wait:operation-core",
              ...(waitId ? { "blue_tanuki.operation_plan.owner_wait_reply_id": waitId } : {}),
              "blue_tanuki.operation_core.source_interface": "gui",
              "blue_tanuki.operation_core.used_for_authority": false,
              "blue_tanuki.operation_core.planner_output_used_for_authority": false,
              "blue_tanuki.operation_core.ui_projection_used_for_authority": false,
            },
          })
        : inboundRequest;
      this.handler?.(inboundReq).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[webchat] owner inbound handler error:", e);
      });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true, request_id: inboundReq.id }));
      return;
    }

    if (url.pathname === "/webhook") {
      const eventEnvelope = body && (Object.hasOwn(body, "event_id") || Object.hasOwn(body, "sequence") ||
        Object.hasOwn(body, "expires_at_ms")) ? body : null;
      if (eventEnvelope || body === null) res.setHeader("cache-control", "no-store");
      const content = readWebhookContent(body);
      if (!content) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: eventEnvelope ? "invalid_webhook_event" : "content, text, or event is required",
          }),
        );
        return;
      }
      const replyUser = nonEmptyString(body?.user) ?? "webhook";
      const source = nonEmptyString(body?.source) ?? "generic";
      const reply_to = nonEmptyString(body?.reply_to) ?? replyUser;
      if (rejectReservedWebChatAudience(res, reply_to)) return;
      if (eventEnvelope) {
        this.acceptDurableWebhookEvent(eventEnvelope, content, reply_to, res);
        return;
      }
      if (
        !this.rateLimitOr429(
          this.buckets.inbound,
          `webhook:${source}:${replyUser}`,
          res,
        )
      )
        return;
      const inboundReq: InboundRequest = {
        id: randomUUID(),
        channel: "webchat",
        // The authenticated webhook credential identifies only its holder class;
        // payload labels remain reply-routing metadata, never an audit identity.
        user: WEBHOOK_TOKEN_ACTOR,
        content,
        timestamp: Date.now(),
        metadata: {
          reply_to,
          webhook_source: source,
        },
      };
      this.handler?.(inboundReq).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[webchat] webhook handler error:", e);
      });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ accepted: true, request_id: inboundReq.id }),
      );
      return;
    }

    if (url.pathname === "/resume") {
      const request_id =
        typeof body?.request_id === "string" ? body.request_id : null;
      const verdict = body?.verdict;
      if (
        !request_id ||
        (verdict !== "approve" && verdict !== "reject" && verdict !== "block")
      ) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "request_id and verdict (approve|reject|block) required",
          }),
        );
        return;
      }
      if (!this.opts.onResume) {
        res.writeHead(501, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "resume_not_configured" }));
        return;
      }
      // The actor label comes from the credential that passed checkAuth above.
      // A request-body actor is display input and must not become audit identity.
      const actor = RESUME_TOKEN_ACTOR;
      if (!this.rateLimitOr429(this.buckets.resume, RESUME_GLOBAL_KEY, res))
        return;
      if (this.opts.approval?.requiresApprovalEndpoint?.(request_id) ||
          this.opts.approval?.requiresLocalDailyBriefRead?.(request_id) ||
          (verdict === "approve" && this.opts.approval?.requiresNativeCredentialApproval?.(request_id))) {
        res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "approval_endpoint_required" }));
        return;
      }
      if (this.resumeApprovalTokenStore) {
        if (!(await this.consumeResumeApprovalToken(request_id, body, res)))
          return;
      }
      try {
        const result = await this.opts.onResume(request_id, verdict, {
          actor,
          token_kind: "resume",
          approval: readResumeApprovalOptions(body),
        });
        if (result !== null && typeof result === "object" && "daily_brief_read" in result) {
          res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: "daily_brief_approval_endpoint_required" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  }

  private async handleAotanuAsset(
    req: IncomingMessage,
    res: ServerResponse,
    urlPath: string,
  ): Promise<void> {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    let filename: string;
    try {
      filename = decodeURIComponent(urlPath.slice(AOTANU_ASSET_ROUTE_PREFIX.length));
    } catch {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    if (!AOTANU_ASSET_FILENAMES_SET.has(filename)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const resolved = path.resolve(AOTANU_ASSET_ROOT, filename);
    if (!resolved.startsWith(`${AOTANU_ASSET_ROOT}${path.sep}`)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const fileStat = await stat(resolved).catch(() => null);
    if (!fileStat?.isFile()) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(fileStat.size),
      "cache-control": "public, max-age=3600",
    });
    const stream = createReadStream(resolved);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "asset_read_failed" }));
        return;
      }
      res.destroy();
    });
    stream.pipe(res);
  }

  private pruneControlCenterLaunchHandoffs(now = Date.now()): void {
    for (const [digest, handoff] of this.controlCenterLaunchHandoffs) {
      if (handoff.expires_at <= now) this.controlCenterLaunchHandoffs.delete(digest);
    }
  }

  private checkLaunchHandoffTokenHeader(
    req: IncomingMessage,
    header: string,
    expected: string | undefined,
  ): boolean {
    if (!expected) return true;
    const value = req.headers[header];
    return typeof value === "string" && bearerTokenMatches(value, expected);
  }

  private async handleControlCenterLaunchHandoff(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      sendLaunchHandoffJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!isLoopbackClientAddress(req.socket.remoteAddress) || !loopbackRequestOrigin(req, false)) {
      sendLaunchHandoffJson(res, 403, { error: "local_launcher_required" });
      return;
    }
    if (String(req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      sendLaunchHandoffJson(res, 415, { error: "application_json_required" });
      return;
    }
    let body: Record<string, unknown> | null;
    try {
      body = await readJson(req, 1024);
    } catch {
      sendLaunchHandoffJson(res, 413, { error: "invalid_launch_handoff_request" });
      return;
    }
    if (!body || Object.keys(body).length !== 0) {
      sendLaunchHandoffJson(res, 400, { error: "invalid_launch_handoff_request" });
      return;
    }

    const authenticated = this.checkAuth(req, "inbound") &&
      this.checkLaunchHandoffTokenHeader(req, "x-blue-tanuki-launch-resume", this.opts.resume_token) &&
      this.checkLaunchHandoffTokenHeader(req, "x-blue-tanuki-launch-owner", this.opts.owner_token) &&
      this.checkLaunchHandoffTokenHeader(req, "x-blue-tanuki-launch-settings", this.opts.settings?.token) &&
      this.checkLaunchHandoffTokenHeader(req, "x-blue-tanuki-launch-maintenance", this.opts.maintenance_token);
    if (!authenticated) {
      sendLaunchHandoffJson(res, 401, { error: "unauthorized" });
      return;
    }

    const now = Date.now();
    this.pruneControlCenterLaunchHandoffs(now);
    if (this.controlCenterLaunchHandoffs.size >= CONTROL_CENTER_LAUNCH_HANDOFF_CAP) {
      sendLaunchHandoffJson(res, 503, { error: "launch_handoff_capacity_reached" });
      return;
    }
    const ticket = randomBytes(32).toString("base64url");
    const ticketDigest = createHash("sha256").update(ticket, "utf8").digest("hex");
    this.controlCenterLaunchHandoffs.set(ticketDigest, {
      expires_at: now + CONTROL_CENTER_LAUNCH_HANDOFF_TTL_MS,
      tokens: {
        webchat: this.opts.token,
        ...(this.opts.resume_token ? { resume: this.opts.resume_token } : {}),
        ...(this.opts.owner_token ? { owner: this.opts.owner_token } : {}),
        ...(this.opts.settings?.token ? { settings: this.opts.settings.token } : {}),
        ...(this.opts.maintenance_token ? { maintenance: this.opts.maintenance_token } : {}),
      },
    });
    sendLaunchHandoffJson(res, 200, {
      ticket,
      expires_in_ms: CONTROL_CENTER_LAUNCH_HANDOFF_TTL_MS,
      single_use: true,
    });
  }

  private async handleControlCenterLaunchHandoffExchange(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      sendLaunchHandoffJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    const fetchSite = req.headers["sec-fetch-site"];
    if (!isLoopbackClientAddress(req.socket.remoteAddress) || !loopbackRequestOrigin(req, true) ||
        (fetchSite !== undefined && fetchSite !== "same-origin")) {
      sendLaunchHandoffJson(res, 403, { error: "same_origin_local_control_center_required" });
      return;
    }
    if (String(req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      sendLaunchHandoffJson(res, 415, { error: "application_json_required" });
      return;
    }
    let body: Record<string, unknown> | null;
    try {
      body = await readJson(req, 1024);
    } catch {
      sendLaunchHandoffJson(res, 413, { error: "invalid_launch_handoff_ticket" });
      return;
    }
    const ticket = body?.ticket;
    if (!body || Object.keys(body).length !== 1 || typeof ticket !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
      sendLaunchHandoffJson(res, 400, { error: "invalid_launch_handoff_ticket" });
      return;
    }

    const now = Date.now();
    this.pruneControlCenterLaunchHandoffs(now);
    const ticketDigest = createHash("sha256").update(ticket, "utf8").digest("hex");
    const handoff = this.controlCenterLaunchHandoffs.get(ticketDigest);
    this.controlCenterLaunchHandoffs.delete(ticketDigest);
    if (!handoff || handoff.expires_at <= now) {
      sendLaunchHandoffJson(res, 401, { error: "launch_handoff_expired_or_consumed" });
      return;
    }

    sendLaunchHandoffJson(res, 200, {
      tokens: {
        webchat: handoff.tokens.webchat,
        ...(handoff.tokens.resume ? { resume: handoff.tokens.resume } : {}),
        ...(handoff.tokens.owner ? { owner: handoff.tokens.owner } : {}),
        ...(handoff.tokens.settings ? { settings: handoff.tokens.settings } : {}),
        ...(handoff.tokens.maintenance ? { maintenance: handoff.tokens.maintenance } : {}),
      },
    });
  }

  private acceptDurableWebhookEvent(body: Record<string, unknown>, content: string, replyTo: string, res: ServerResponse): void {
    const respond = (status: number, payload: Record<string, unknown>): void => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(payload));
    };
    const { source, event_id, sequence, expires_at_ms } = body;
    const now = Date.now();
    if (typeof source !== "string" || !WEBHOOK_EVENT_SOURCE.test(source) ||
        typeof event_id !== "string" || !WEBHOOK_EVENT_ID.test(event_id) ||
        typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0 ||
        typeof expires_at_ms !== "number" || !Number.isSafeInteger(expires_at_ms) || expires_at_ms <= 0 ||
        expires_at_ms - now > WEBHOOK_EVENT_MAX_FUTURE_MS || !isWellFormedUnicode(content) || !isWellFormedUnicode(replyTo)) {
      respond(400, { error: "invalid_webhook_event" });
      return;
    }
    const request = createGatewayInternalInboundRequest({
      id: randomUUID(), channel: "webchat", user: WEBHOOK_TOKEN_ACTOR, content, timestamp: now,
      metadata: {
        "blue_tanuki.authority_context": "gateway_internal_v1",
        "blue_tanuki.webhook_ingress.version": "webhook-event.v1",
        reply_to: replyTo,
        webhook_source: source,
      },
    });
    if (!InboundRequestSchema.safeParse(request).success) {
      respond(400, { error: "invalid_webhook_event" });
      return;
    }
    const handler = this.handler;
    const store = this.opts.webhook_event_store;
    if (!handler || !store) {
      respond(503, { error: "webhook_event_store_unavailable" });
      return;
    }
    if (!this.rateLimitOr429(this.buckets.inbound, "webhook-durable", res)) return;

    const digest = (domain: string, fields: readonly unknown[]): string =>
      createHash("sha256").update(JSON.stringify([domain, ...fields]), "utf8").digest("hex");
    const source_digest = digest("blue-tanuki.webhook-event.source.v1", [source]);
    const event_digest = digest("blue-tanuki.webhook-event.identity.v1", [event_id]);
    const payload_digest = digest("blue-tanuki.webhook-event.payload.v1", [
      request.content, request.metadata?.reply_to, sequence, expires_at_ms,
    ]);
    let claim: WebChatWebhookEventClaim;
    try {
      claim = store.claimWebhookEvent({ source_digest, event_digest, payload_digest, sequence, expires_at_ms, request_id: request.id });
    } catch {
      respond(503, { error: "webhook_event_store_unavailable" });
      return;
    }
    const observation = { accepted: true, used_for_authority: false, may_execute: false };
    switch (claim.status) {
      case "expired":
        respond(410, { error: claim.status });
        return;
      case "identity_conflict":
      case "out_of_order":
        respond(409, { error: claim.status });
        return;
      case "duplicate":
        respond(202, { ...observation, duplicate: true, request_id: claim.request_id, state: claim.state });
        return;
      case "accepted":
        if (claim.request_id !== request.id) {
          respond(503, { error: "webhook_event_store_unavailable" });
          return;
        }
        break;
    }
    const settle = (state: "handler_returned" | "outcome_unknown"): void => {
      store.settleWebhookEvent({ source_digest, event_digest, request_id: request.id, state });
    };
    void Promise.resolve().then(() => handler(request)).then(
      () => settle("handler_returned"),
      () => settle("outcome_unknown"),
    ).catch(() => { /* 永続確保を残し、処理本体を再送しない。 */ });
    respond(202, { ...observation, duplicate: false, request_id: request.id, state: "dispatching" });
  }

  private checkAuth(
    req: IncomingMessage,
    kind: "inbound" | "resume" | "webhook" | "owner" | "d4_runtime",
  ): boolean {
    const h = req.headers["authorization"];
    if (typeof h !== "string") return false;
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    const expected =
      kind === "resume"
        ? this.opts.resume_token
        : kind === "owner"
        ? this.opts.owner_token
        : kind === "webhook"
        ? this.opts.webhook_token
        : kind === "d4_runtime"
        ? this.opts.d4_runtime_intent?.token
        : this.opts.token;
    return bearerTokenMatches(m[1], expected);
  }

  /** D4 Runtimeへ状態・権限trace・通知の投影を許可する。制御・再照合の権限は与えない。 */
  private checkRuntimeProjectionAuth(req: IncomingMessage): boolean {
    return this.checkAuth(req, "inbound") || this.checkAuth(req, "d4_runtime");
  }

  /** D4 Runtimeには状態値だけを返し、Control Center向けの詳細snapshotを渡さない。 */
  private projectD4RuntimeStatusSnapshot(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const snapshot = value as Record<string, unknown>;
    const parsed = D4RuntimeStatusProjectionSchema.safeParse({
      schema_version: "blue-tanuki.d4-runtime-status.v1",
      runtime_id: this.opts.d4_runtime_intent?.runtime_id,
      gateway_status: snapshot.gateway_status,
      safe_mode: snapshot.safe_mode,
      hds_invariants_ok: snapshot.hds_invariants_ok,
      webchat_ready: snapshot.webchat_ready,
      telegram_configured: snapshot.telegram_configured,
      pending_approvals_count: snapshot.pending_approvals_count,
      runtime_schedules_count: snapshot.runtime_schedules_count,
      pending_schedule_approvals_count: snapshot.pending_schedule_approvals_count,
      audit_chain_valid: snapshot.audit_chain_valid,
      observed_at_ms: Date.now(),
      evidence_source: ["INTERNAL_STATE"],
      used_for_authority: false,
      may_execute: false,
    });
    return parsed.success ? parsed.data : null;
  }

  /** D4 Runtimeには通知本文やsource識別子を含めず、上限付きカテゴリだけを投影する。 */
  private projectD4RuntimeNotifications(value: unknown): D4RuntimeNotificationsProjection | null {
    if (!Array.isArray(value) || value.length > 64) return null;
    const notifications = value.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
      const item = entry as Record<string, unknown>;
      const kind = item.kind as WebChatNotificationKind;
      const category = typeof kind === "string" && kind !== "owner_saved_result_ready"
        ? D4_RUNTIME_NOTIFICATION_CATEGORY_BY_KIND[kind]
        : undefined;
      return {
        category,
        severity: item.severity,
        occurred_at_ms: item.timestamp,
      };
    });
    const parsed = D4RuntimeNotificationsProjectionSchema.safeParse({
      schema_version: "blue-tanuki.d4-runtime-notifications.v1",
      runtime_id: this.opts.d4_runtime_intent?.runtime_id,
      notifications,
      observed_at_ms: Date.now(),
      evidence_source: ["INTERNAL_STATE"],
      used_for_authority: false,
      may_execute: false,
    });
    return parsed.success ? parsed.data : null;
  }

  private checkSettingsAuth(req: IncomingMessage): boolean {
    const h = req.headers["authorization"];
    if (typeof h !== "string") return false;
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return Boolean(m && bearerTokenMatches(m[1], this.opts.settings?.token));
  }

  private checkMaintenanceAuth(req: IncomingMessage): boolean {
    const h = req.headers["authorization"];
    if (typeof h !== "string") return false;
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return Boolean(m && bearerTokenMatches(m[1], this.opts.maintenance_token));
  }

  private async handleApproval(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const nativeCredentialMatch = /^\/approval\/([^/]+)\/native-credential$/.exec(url.pathname);
    const dailyBriefMatch = /^\/approval\/([^/]+)\/daily-brief-read$/.exec(url.pathname);
    if (nativeCredentialMatch || dailyBriefMatch) {
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
    }
    if (dailyBriefMatch && (url.search || !isLocalControlCenterBrowserRequest(req))) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "same_origin_local_control_center_required" }));
      return;
    }
    if (!this.checkAuth(req, "resume")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const contentReviewMatch = /^\/approval\/([^/]+)\/content$/.exec(url.pathname);
    if (contentReviewMatch) {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.approval?.reviewContent) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "approval_content_review_not_configured" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.resume, RESUME_GLOBAL_KEY, res)) return;
      let command_id: string;
      try {
        command_id = decodeURIComponent(contentReviewMatch[1] ?? "");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "approval_id_invalid" }));
        return;
      }
      const dailyBriefReview = this.opts.approval.requiresLocalDailyBriefRead?.(command_id) === true;
      if (dailyBriefReview && (url.search || !isLocalControlCenterBrowserRequest(req))) {
        res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "same_origin_local_control_center_required" }));
        return;
      }
      if (dailyBriefReview && !hasDailyBriefOwnerToken(req, this.opts.owner_token)) {
        res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let content: WebChatApprovalContentReview | null;
      try {
        content = await this.opts.approval.reviewContent(command_id);
      } catch {
        res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "approval_content_review_unavailable" }));
        return;
      }
      if (!content) {
        res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "approval_content_review_unavailable" }));
        return;
      }
      if (dailyBriefReview !== (content.kind === "daily_brief_read") ||
          (content.kind === "daily_brief_read" && !validDailyBriefReadReview(content, command_id))) {
        res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "approval_content_review_unavailable" }));
        return;
      }
      if (content.kind === "settings_write" && (!validSettingsProviderReview(content, command_id) ||
          (content.expected_llm_provider !== undefined &&
            (!SettingsWriteLlmProviderSchema.safeParse(content.expected_llm_provider).success ||
              content.changes.length === 0 ||
              !content.changes.every(change => typeof change?.key === "string" && change.key.startsWith("llm.")))))) {
        res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "approval_content_review_unavailable" }));
        return;
      }
      if (content.kind === "goal_purpose_repair") {
        const binding = goalPurposeRepairBinding({ ...content });
        const stores = goalPurposeRepairStores(content.stores);
        if (!binding || !stores || content.command_id !== command_id || content.operation !== "recovery.restore" ||
            typeof content.command_digest !== "string" || !/^[a-f0-9]{64}$/.test(content.command_digest) ||
            typeof content.review_digest !== "string" || !/^[a-f0-9]{64}$/.test(content.review_digest) ||
            content.used_for_authority !== false || content.may_execute !== false) {
          res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: "approval_content_review_unavailable" }));
          return;
        }
        content = {
          kind: "goal_purpose_repair", operation: "recovery.restore", command_id,
          command_digest: content.command_digest, review_digest: content.review_digest,
          ...binding, stores, used_for_authority: false, may_execute: false,
        };
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify(content));
      return;
    }

    if (url.pathname === "/approval") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.approval) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "approval_not_configured" }));
        return;
      }
      const pending_approvals = await this.opts.approval.list();
      const grants = this.opts.approval.grants
        ? await this.opts.approval.grants()
        : undefined;
      const approval_history = this.opts.approval.history
        ? await this.opts.approval.history()
        : undefined;
      const emergency_stop = this.opts.approval.emergencyStop
        ? await this.opts.approval.emergencyStop.getSnapshot()
        : undefined;
      const active_executions = this.opts.approval.activeExecutions
        ? await this.opts.approval.activeExecutions()
        : undefined;
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({
        pending_approvals,
        ...(grants ? { grants } : {}),
        ...(approval_history ? { approval_history } : {}),
        ...(emergency_stop ? { emergency_stop } : {}),
        ...(active_executions ? { active_executions } : {}),
      }));
      return;
    }

    const cancelExecutionMatch = /^\/approval\/executions\/([^/]+)\/cancel$/.exec(url.pathname);
    if (cancelExecutionMatch) {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.approval?.cancelExecution) {
        res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "execution_cancellation_not_configured" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.resume, RESUME_GLOBAL_KEY, res)) return;
      let command_id: string;
      try {
        command_id = decodeURIComponent(cancelExecutionMatch[1] ?? "");
      } catch {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "execution_id_invalid" }));
        return;
      }
      if (!command_id || command_id.length > 200 || command_id.trim() !== command_id) {
        res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "execution_id_invalid" }));
        return;
      }
      const cancellation = await this.opts.approval.cancelExecution(
        command_id,
        { actor: "webchat-resume-token-holder", token_kind: "resume" },
      );
      if (!cancellation) {
        res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "execution_not_active" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, cancellation }));
      return;
    }

    if (url.pathname === "/approval/grants") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.approval?.grants) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "approval_grants_not_configured" }));
        return;
      }
      const grants = await this.opts.approval.grants();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ grants }));
      return;
    }

    if (url.pathname.startsWith("/approval/grants/") && url.pathname.endsWith("/revoke")) {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.approval?.revokeGrant) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "approval_revoke_not_configured" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.resume, RESUME_GLOBAL_KEY, res))
        return;
      const encoded = url.pathname.slice("/approval/grants/".length, -"/revoke".length);
      const grant_id = decodeURIComponent(encoded);
      if (!grant_id) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "grant_id required" }));
        return;
      }
      const body = await readJson(req);
      const result = await this.opts.approval.revokeGrant(
        grant_id,
        readApprovalControlContext(body),
      );
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    if (url.pathname === "/approval/history") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.approval?.history) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "approval_history_not_configured" }));
        return;
      }
      const approval_history = await this.opts.approval.history();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ approval_history }));
      return;
    }

    if (url.pathname === "/approval/emergency-stop") {
      if (!this.opts.approval?.emergencyStop) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "emergency_stop_not_configured" }));
        return;
      }
      if (req.method === "GET") {
        const emergency_stop = await this.opts.approval.emergencyStop.getSnapshot();
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ emergency_stop }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.rateLimitOr429(this.buckets.resume, RESUME_GLOBAL_KEY, res))
        return;
      const body = await readJson(req);
      const action = body?.action;
      if (action !== "activate" && action !== "clear") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "action (activate|clear) required" }));
        return;
      }
      const context = readApprovalControlContext(body);
      let result: unknown;
      try {
        result = action === "activate"
          ? await this.opts.approval.emergencyStop.activate(context)
          : await this.opts.approval.emergencyStop.clear(context);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "emergency_stop_action_failed";
        const blockedClear = action === "clear" && (reason === "emergency_stop_clear_blocked_active_work" ||
          reason === "emergency_stop_clear_state_conflict");
        res.writeHead(blockedClear ? 409 : 500, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ error: blockedClear ? reason : "emergency_stop_action_failed" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    const prefix = "/approval/";
    if (!url.pathname.startsWith(prefix) || req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.opts.onResume) {
      res.writeHead(501, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "approval_not_configured" }));
      return;
    }
    if (nativeCredentialMatch) {
      if (url.search || !isLocalControlCenterBrowserRequest(req)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "same_origin_local_control_center_required" }));
        return;
      }
      if (String(req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        res.writeHead(415, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "application_json_required" }));
        return;
      }
      if (!this.resumeApprovalTokenStore || !this.opts.approval?.validateContentReview || !this.opts.approval.reviewContent) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "credential_registration_unavailable" }));
        return;
      }
    }
    let approval_id: string;
    try {
      approval_id = decodeURIComponent(nativeCredentialMatch?.[1] ?? dailyBriefMatch?.[1] ?? url.pathname.slice(prefix.length));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "approval_id_invalid" }));
      return;
    }
    if (!approval_id) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "approval id required" }));
      return;
    }
    const requiresDailyBriefRead = this.opts.approval?.requiresLocalDailyBriefRead?.(approval_id) === true;
    if (requiresDailyBriefRead !== Boolean(dailyBriefMatch)) {
      res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: requiresDailyBriefRead ? "daily_brief_approval_endpoint_required" : "daily_brief_approval_unavailable" }));
      return;
    }
    if (dailyBriefMatch) {
      if (!hasDailyBriefOwnerToken(req, this.opts.owner_token)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (String(req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        res.writeHead(415, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "application_json_required" }));
        return;
      }
      if (!this.resumeApprovalTokenStore || !this.opts.approval?.validateContentReview || !this.opts.approval.reviewContent) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "daily_brief_approval_unavailable" }));
        return;
      }
    }

    let body: Record<string, unknown> | null;
    try {
      body = nativeCredentialMatch || dailyBriefMatch ? await readJson(req, 1_024, true) : await readJson(req);
    } catch (error) {
      if ((!nativeCredentialMatch && !dailyBriefMatch) || !(error instanceof Error) || error.message !== "body_too_large") throw error;
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "request_body_too_large" }));
      return;
    }
    const verdict = body?.verdict;
    if (nativeCredentialMatch && (!body || !hasExactKeys(body, ["verdict", "approval_token", "content_review_digest"]) ||
        verdict !== "approve" || !/^[a-zA-Z0-9_-]{1,128}$/.test(approval_id) ||
        typeof body.approval_token !== "string" || !body.approval_token ||
        typeof body.content_review_digest !== "string" || !/^[a-f0-9]{64}$/.test(body.content_review_digest))) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_credential_registration_approval" }));
      return;
    }
    if (verdict !== "approve" && verdict !== "reject" && verdict !== "block") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "verdict (approve|reject|block) required" }));
      return;
    }
    if (dailyBriefMatch && (!body ||
        !hasExactKeys(body, verdict === "approve" ? ["verdict", "approval_token", "content_review_digest"] : ["verdict", "approval_token"]) ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(approval_id) || typeof body.approval_token !== "string" || !body.approval_token ||
        (verdict === "approve" && (typeof body.content_review_digest !== "string" || !/^[a-f0-9]{64}$/.test(body.content_review_digest))))) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_daily_brief_approval" }));
      return;
    }
    if (!this.rateLimitOr429(this.buckets.resume, RESUME_GLOBAL_KEY, res))
      return;
    const content_review_digest = typeof body?.content_review_digest === "string"
      ? body.content_review_digest
      : undefined;
    const requiresNativeCredentialApproval = this.opts.approval?.requiresNativeCredentialApproval?.(approval_id) === true;
    if (verdict === "approve" && requiresNativeCredentialApproval !== Boolean(nativeCredentialMatch)) {
      res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: requiresNativeCredentialApproval ? "native_credential_approval_required" : "credential_registration_unavailable" }));
      return;
    }
    const requiresApprovalEndpoint = this.opts.approval?.requiresApprovalEndpoint?.(approval_id) === true;
    if (nativeCredentialMatch) {
      const reviewed = await this.opts.approval?.reviewContent?.(approval_id).catch(() => null);
      if (reviewed?.kind !== "settings_write" || !validSettingsProviderReview(reviewed, approval_id) ||
          (reviewed.activation?.credential_registration_required !== true && reviewed.credential_rotation === undefined) ||
          reviewed.command_id !== approval_id ||
          reviewed.review_digest !== content_review_digest || reviewed.no_store !== true ||
          reviewed.used_for_authority !== false || reviewed.may_execute !== false) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "approval_content_review_unavailable" }));
        return;
      }
    }
    let contentReviewValidated = false;
    if (verdict === "approve" && this.opts.approval?.validateContentReview) {
      let review: WebChatApprovalContentReviewValidation;
      try {
        review = await this.opts.approval.validateContentReview(
          approval_id,
          content_review_digest,
        );
      } catch {
        res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "approval_content_review_unavailable" }));
        return;
      }
      if (review !== "valid" && (nativeCredentialMatch || dailyBriefMatch || review !== "not_required")) {
        res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: `approval_content_review_${review}` }));
        return;
      }
      contentReviewValidated = review === "valid";
    }
    if (!(await this.consumeResumeApprovalToken(approval_id, body, res))) return;

    // The actor label comes from the credential that passed checkAuth above.
    // A request-body actor is display input and must not become audit identity.
    const actor = RESUME_TOKEN_ACTOR;
    try {
      const result = await this.opts.onResume(approval_id, verdict, {
        actor,
        token_kind: "resume",
        ...(content_review_digest ? { content_review_digest } : {}),
        ...(nativeCredentialMatch ? { native_credential_prompt: true } : dailyBriefMatch ? { daily_brief_read: true }
          : { approval: readResumeApprovalOptions(body) }),
      });
      if (nativeCredentialMatch) {
        const candidate = result as Record<string, unknown> | undefined;
        if (candidate?.approval !== "approve" || candidate.executed !== true || candidate.status !== "success") {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "credential_registration_unconfirmed" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { approval: "approve", executed: true, status: "success" } }));
        return;
      }
      if (dailyBriefMatch) {
        const candidate = result as Record<string, unknown> | undefined;
        const read = verdict === "approve" && candidate?.approval === "approve" && candidate.executed === true
          ? dailyBriefReadResult(candidate.daily_brief_read) : null;
        const rejected = verdict !== "approve" && candidate?.approval === verdict && candidate.executed === false;
        if (read || rejected) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, result: {
            approval: verdict, executed: Boolean(read), status: read ? "success" : "not_executed",
            ...(read ? { daily_brief_read: read } : {}),
          } }));
        } else {
          res.writeHead(409, { "content-type": "application/json" });
          const withheld = verdict === "approve" && candidate?.executed === true &&
            (candidate.status === "success" || candidate.status === "daily_brief_result_withheld");
          res.end(JSON.stringify({ error: withheld ? "daily_brief_result_withheld" : "daily_brief_result_unavailable" }));
        }
        return;
      }
      if (result !== null && typeof result === "object" && "daily_brief_read" in result) {
        res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "daily_brief_approval_endpoint_required" }));
        return;
      }
      if (result !== null && typeof result === "object" &&
          ("handoff_code" in result || ("status" in result && result.status === "offline_goal_purpose_repair_prepared"))) {
        const candidate = result as Record<string, unknown>;
        const binding = goalPurposeRepairBinding(candidate);
        if (verdict !== "approve" || !requiresApprovalEndpoint || !contentReviewValidated ||
            !/^[a-f0-9]{64}$/.test(content_review_digest ?? "") ||
            !binding || candidate.status !== "offline_goal_purpose_repair_prepared" ||
            candidate.approval !== "approve" || candidate.executed !== false ||
            typeof candidate.handoff_code !== "string" || !/^[a-f0-9]{64}$/.test(candidate.handoff_code) ||
            typeof candidate.expires_at_ms !== "number" || !Number.isSafeInteger(candidate.expires_at_ms) ||
            candidate.expires_at_ms <= 0) {
          res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: "offline_goal_purpose_repair_handoff_unavailable" }));
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify({ ok: true, result: {
          approval: "approve", executed: false, status: "offline_goal_purpose_repair_prepared", ...binding,
          handoff_code: candidate.handoff_code, expires_at_ms: candidate.expires_at_ms,
        } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      const msg = nativeCredentialMatch ? "credential_registration_unconfirmed" : dailyBriefMatch ? "daily_brief_result_unavailable"
        : e instanceof Error ? e.message : String(e);
      res.writeHead(nativeCredentialMatch || dailyBriefMatch ? 409 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
  }

  private async consumeResumeApprovalToken(
    request_id: string,
    body: Record<string, unknown> | null,
    res: ServerResponse,
  ): Promise<boolean> {
    if (!this.resumeApprovalTokenStore) return true;
    const approval_token =
      typeof body?.approval_token === "string"
        ? body.approval_token.trim()
        : "";
    if (!approval_token) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "approval_token required" }));
      return false;
    }
    const ok = await this.resumeApprovalTokenStore.consume(
      request_id,
      approval_token,
    );
    if (!ok) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_approval_token" }));
      return false;
    }
    return true;
  }

  private async handleAuditDump(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this.opts.audit) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "audit_not_configured" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const format = url.searchParams.get("format") === "text" ? "text" : "json";
    const dump = await this.opts.audit.dump(format);
    res.writeHead(200, {
      "content-type": dump.content_type,
      "cache-control": "no-store",
    });
    res.end(dump.body);
  }

  private async handleAuthorityTrace(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.authority) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "authority_trace_not_configured" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.checkRuntimeProjectionAuth(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const authority_trace = await this.opts.authority.trace();
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ authority_trace }));
  }

  private async handleRuntimeSnapshot(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.runtime) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "runtime_not_configured" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const d4RuntimeProjection = this.checkAuth(req, "d4_runtime");
    if (!d4RuntimeProjection && !this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const snapshot = await this.opts.runtime.getSnapshot();
    const responseSnapshot = d4RuntimeProjection
      ? this.projectD4RuntimeStatusSnapshot(snapshot)
      : snapshot;
    if (responseSnapshot === null) {
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "runtime_status_projection_unavailable" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(responseSnapshot));
  }

  private async handleRuntimeResultReconciliation(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const reconcile = this.opts.runtime?.reconcilePendingResults;
    if (!reconcile) {
      res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "runtime_result_reconciliation_not_configured" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (!this.rateLimitOr429(this.buckets.inbound, "runtime-result-reconciliation", res)) return;

    let body: Record<string, unknown> | null;
    try { body = await readJson(req, 1024); }
    catch {
      res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "invalid_runtime_reconciliation_request" }));
      return;
    }
    if (body !== null && (Array.isArray(body) || Object.keys(body).length > 0)) {
      res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "runtime_reconciliation_does_not_accept_scope_or_command" }));
      return;
    }

    try {
      const result = await reconcile();
      if (typeof result.ready !== "boolean" || typeof result.memory_ready !== "boolean" ||
          typeof result.result_store_readable !== "boolean" ||
          [result.adopted, result.deferred, result.stale_generation_archived].some((value) =>
            !Number.isSafeInteger(value) || value < 0)) {
        throw new Error("invalid_runtime_reconciliation_result");
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        status: result.ready ? "ready" : "held",
        result,
        used_for_authority: false,
        may_execute: false,
      }));
    } catch {
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "runtime_result_reconciliation_unavailable" }));
    }
  }

  private async handleNotifications(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.notifications) {
      res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "notifications_not_configured" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const d4RuntimeProjection = this.checkAuth(req, "d4_runtime");
    const ownerSavedResults = Boolean(this.opts.notifications.listOwnerSavedResults) && this.checkAuth(req, "owner");
    if (!d4RuntimeProjection && !ownerSavedResults && !this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (ownerSavedResults && !this.rateLimitOr429(this.buckets.inbound, "owner-saved-result-notifications", res)) return;
    let notifications: readonly WebChatNotificationItem[];
    try {
      if (ownerSavedResults) {
        const savedResults = await this.opts.notifications.listOwnerSavedResults?.();
        notifications = (savedResults ?? []).filter(item => item.kind === "owner_saved_result_ready");
      } else {
        notifications = await this.opts.notifications.list();
        if (Array.isArray(notifications)) {
          notifications = notifications.filter(item => item?.kind !== "owner_saved_result_ready");
        }
      }
    } catch {
      res.writeHead(503, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify({ error: ownerSavedResults ? "owner_saved_result_notifications_unavailable" : "notifications_unavailable" }));
      return;
    }
    if (d4RuntimeProjection) {
      const projection = this.projectD4RuntimeNotifications(notifications);
      if (projection === null) {
        res.writeHead(503, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify({ error: "runtime_notifications_projection_unavailable" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify(projection));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(ownerSavedResults ? { notifications, scope: "owner" } : { notifications }));
  }

  private async handleHistory(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this.opts.history) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "history_not_configured" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const history = sanitizeHistorySnapshot(
      await this.opts.history.replay(readHistoryReplayFilter(url)),
    );
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ history }));
  }

  private async handleEvidenceExport(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.evidence) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "evidence_not_configured" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.rateLimitOr429(this.buckets.inbound, "evidence-export", res)) return;
    const body = await readJson(req);
    const evidence = await this.opts.evidence.exportPack(readEvidenceControlContext(body));
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ ok: true, evidence }));
  }

  private async handleOperator(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    surfaceName: "writing" | "daily" | "developer",
  ): Promise<void> {
    const surface = this.opts.operators?.[surfaceName];
    if (!surface) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `${surfaceName}_operator_not_configured` }));
      return;
    }
    const ownerAuthenticated = surfaceName === "developer" && this.checkAuth(req, "owner");
    if (!this.checkAuth(req, "inbound") && !ownerAuthenticated) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (ownerAuthenticated && (req.method !== "POST" || url.pathname !== "/operators/developer/invoke")) {
      res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "owner_token_operator_scope_denied" }));
      return;
    }

    if (url.pathname === `/operators/${surfaceName}` && req.method === "GET") {
      const operator = await surface.getSnapshot();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ operator }));
      return;
    }

    if (url.pathname === `/operators/${surfaceName}/invoke` && req.method === "POST") {
      const body = await readJson(req);
      const user = typeof body?.user === "string" ? body.user : null;
      const content = typeof body?.content === "string" ? body.content : null;
      if (!user || !content) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "user and content are required strings" }));
        return;
      }
      if (rejectReservedWebChatAudience(res, user)) return;
      const ownerOperationPlanAction = ownerOperationPlanControlAction(content);
      if (ownerAuthenticated && !ownerOperationPlanAction) {
        res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "owner_token_operator_scope_denied" }));
        return;
      }
      const rateLimitKey = ownerAuthenticated ? `operator:${surfaceName}:owner-token-holder`
        : `operator:${surfaceName}:${user}`;
      if (!this.rateLimitOr429(this.buckets.inbound, rateLimitKey, res)) return;
      const requestId = randomUUID();
      const inboundReq: InboundRequest = createGatewayInternalInboundRequest({
        id: requestId,
        channel: "webchat",
        user: ownerAuthenticated ? OWNER_TOKEN_ACTOR : user,
        content,
        timestamp: Date.now(),
        metadata: {
          reply_to: user,
          "blue_tanuki.authority_context": "gateway_internal_v1",
          ...(ownerAuthenticated ? {
            "blue_tanuki.actor_kind": "owner",
            "blue_tanuki.trust_level": "owner",
          } : {}),
          ...(ownerAuthenticated && ownerOperationPlanAction
            ? { "blue_tanuki.process_kind": ownerOperationPlanAction.action === "resume_wait" ? "chat" : "tool" } : {}),
          "blue_tanuki.operator_surface": surfaceName,
          "blue_tanuki.operation_core.version": "operation-core.v1",
          "blue_tanuki.operation_core.request_id": `operation-request:${requestId}`,
          "blue_tanuki.operation_core.projection_id": `operator:${surfaceName}:operation-core`,
          "blue_tanuki.operation_core.source_interface": "gui",
          "blue_tanuki.operation_core.used_for_authority": false,
          "blue_tanuki.operation_core.planner_output_used_for_authority": false,
          "blue_tanuki.operation_core.ui_projection_used_for_authority": false,
        },
        ...(ownerAuthenticated && ownerOperationPlanAction?.action === "wait" &&
          ownerOperationPlanAction.plan_id && ownerOperationPlanAction.revision_digest
          ? { session_id: ownerPlanWaitSessionId(ownerOperationPlanAction.plan_id, ownerOperationPlanAction.revision_digest) }
          : {}),
      });
      this.handler?.(inboundReq).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[webchat] ${surfaceName} operator handler error:`, e);
      });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true, request_id: inboundReq.id }));
      return;
    }

    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
  }

  private async handleSettingsPage(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.settings) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "settings_not_configured" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const html =
      typeof this.opts.settings.html === "function"
        ? this.opts.settings.html()
        : this.opts.settings.html;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
  }

  private async handleAbout(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.about) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "about_not_configured" }));
      return;
    }
    if (!this.checkAuth(req, "inbound")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const snapshot = await this.opts.about.getSnapshot();
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(snapshot));
  }

  private async handleUpdate(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
  ): Promise<void> {
    if (!this.opts.update) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "update_not_configured" }));
      return;
    }
    if (!this.checkMaintenanceAuth(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (route === "/update/snapshot") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      const snapshot = await this.opts.update.getSnapshot();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    try {
      let result: unknown;
      if (route === "/update/verify") {
        if (!this.opts.update.verifyCandidate) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "update_action_not_configured" }));
          return;
        }
        result = await this.opts.update.verifyCandidate();
      } else if (route === "/update/prepare") {
        if (!this.opts.update.prepareUpdate) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "update_action_not_configured" }));
          return;
        }
        const body = (await readJson(req)) ?? {};
        result = await this.opts.update.prepareUpdate(body);
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "update_action_not_found" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "update_action_failed" }));
    }
  }

  private async handleRecovery(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
  ): Promise<void> {
    if (route === "/recovery/restore-plan") res.setHeader("cache-control", "no-store");
    if (!this.opts.recovery) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "recovery_not_configured" }));
      return;
    }
    if (!this.checkMaintenanceAuth(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (route === "/recovery/snapshot") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      const snapshot = await this.opts.recovery.getSnapshot();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (route === "/recovery/inspection") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.recovery.inspectLedgerState) {
        res.writeHead(501, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "recovery_inspection_not_configured" }));
        return;
      }
      try {
        const report = await this.opts.recovery.inspectLedgerState();
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(report));
      } catch {
        res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "recovery_inspection_failed" }));
      }
      return;
    }
    if (route === "/recovery/backup-inspection") {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.recovery.inspectBackup) {
        res.writeHead(501, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "recovery_backup_inspection_not_configured" }));
        return;
      }
      try {
        const report = await this.opts.recovery.inspectBackup();
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(report));
      } catch {
        res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "recovery_backup_inspection_failed" }));
      }
      return;
    }
    if (route === "/recovery/restore-plan") {
      const headers = { "content-type": "application/json" };
      if (req.method !== "POST") {
        res.writeHead(405, headers);
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.recovery.inspectRestorePlan) {
        res.writeHead(501, headers);
        res.end(JSON.stringify({ error: "recovery_restore_plan_not_configured" }));
        return;
      }
      const body = await readJson(req, 1024).catch(() => null);
      const backupId = body?.backup_id;
      if (typeof backupId !== "string" || backupId === "latest" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(backupId) || Object.keys(body ?? {}).length !== 1) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: "invalid_recovery_restore_plan_request" }));
        return;
      }
      try {
        const report = await this.opts.recovery.inspectRestorePlan(backupId);
        if (report.offline_lease_verified !== false || report.cross_store_atomic !== false ||
            report.used_for_authority !== false || report.may_execute !== false) {
          throw new Error("invalid_recovery_restore_plan_boundary");
        }
        const replay = report.goal_purpose_replay;
        const verifiedPurposePair = ["goal_purpose_j_control", "goal_purpose_m_state"].every(key => {
          const stores = report.canonical_stores.filter(store => store.store_key === key);
          return stores.length === 1 && stores[0]?.archive_status === "verified";
        });
        const replayValid = report.status === "planned" && replay && typeof replay === "object" && !Array.isArray(replay) &&
          ["matched", "no_current_purpose", "not_included", "unverified"].includes(replay.status) &&
          Number.isSafeInteger(replay.verified_purpose_count) &&
          (replay.status === "matched" ? replay.verified_purpose_count > 0 : replay.verified_purpose_count === 0) &&
          ((replay.status !== "matched" && replay.status !== "no_current_purpose") || verifiedPurposePair);
        const repair = report.goal_purpose_repair;
        const repairStores = goalPurposeRepairStores(repair?.stores);
        const publishRepair = replayValid && replay.status === "matched" && verifiedPurposePair &&
          repair && typeof repair.repair_sha256 === "string" && /^[a-f0-9]{64}$/.test(repair.repair_sha256) && repairStores;
        const response = JSON.stringify({
          surface: report.surface,
          schema_version: report.schema_version,
          status: report.status,
          manifest_sha256: report.manifest_sha256,
          plan_sha256: report.plan_sha256,
          items: report.items.map(({ role, disposition }) => ({ role, disposition })),
          canonical_stores: report.canonical_stores.map(({ store_key, archive_status, disposition }) => ({
            store_key, archive_status, disposition,
          })),
          ...(replayValid ? { goal_purpose_replay: { status: replay.status, verified_purpose_count: replay.verified_purpose_count } } : {}),
          ...(publishRepair ? { goal_purpose_repair: { repair_sha256: repair.repair_sha256, stores: repairStores } } : {}),
          offline_lease_verified: false,
          cross_store_atomic: false,
          used_for_authority: false,
          may_execute: false,
        });
        res.writeHead(200, headers);
        res.end(response);
      } catch {
        res.writeHead(500, headers);
        res.end(JSON.stringify({ error: "recovery_restore_plan_failed" }));
      }
      return;
    }
    if (route === "/recovery/goal-purpose-repair") {
      const headers = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
      if (req.method !== "POST") {
        res.writeHead(405, headers);
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.recovery.prepareGoalPurposeRepair) {
        res.writeHead(501, headers);
        res.end(JSON.stringify({ error: "offline_goal_purpose_repair_not_configured" }));
        return;
      }
      const body = await readJson(req, 1024, true).catch(() => null);
      const binding = body && Object.keys(body).length === 3 ? goalPurposeRepairBinding(body) : null;
      if (!binding) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: "invalid_offline_goal_purpose_repair_request" }));
        return;
      }
      try {
        const result = await this.opts.recovery.prepareGoalPurposeRepair(binding) as Record<string, unknown> | null;
        if (result?.status !== "approval_required" || result.executed !== false || typeof result.command_id !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(result.command_id)) {
          res.writeHead(409, headers);
          res.end(JSON.stringify({ error: "offline_goal_purpose_repair_unavailable" }));
          return;
        }
        res.writeHead(202, headers);
        res.end(JSON.stringify({ status: "approval_required", executed: false, command_id: result.command_id }));
      } catch {
        res.writeHead(503, headers);
        res.end(JSON.stringify({ error: "offline_goal_purpose_repair_unavailable" }));
      }
      return;
    }
    if (route === "/recovery/scope-applicability") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (!this.opts.recovery.inspectScopeApplicability) {
        res.writeHead(501, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "recovery_scope_applicability_not_configured" }));
        return;
      }
      try {
        const body = (await readJson(req)) ?? {};
        const report = await this.opts.recovery.inspectScopeApplicability(body);
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(report));
      } catch {
        res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "recovery_scope_applicability_failed" }));
      }
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    try {
      const body = (await readJson(req)) ?? {};
      let result: unknown;
      if (route === "/recovery/backup") {
        if (!this.opts.recovery.createBackup) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "recovery_action_not_configured" }));
          return;
        }
        result = await this.opts.recovery.createBackup();
      } else if (route === "/recovery/restore") {
        if (!this.opts.recovery.restoreBackup) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "recovery_action_not_configured" }));
          return;
        }
        result = await this.opts.recovery.restoreBackup(body);
      } else if (route === "/recovery/reset-provider") {
        if (!this.opts.recovery.resetProvider) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "recovery_action_not_configured" }));
          return;
        }
        result = await this.opts.recovery.resetProvider(body);
      } else if (route === "/recovery/reset-connector") {
        if (!this.opts.recovery.resetConnector) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "recovery_action_not_configured" }));
          return;
        }
        result = await this.opts.recovery.resetConnector(body);
      } else if (route === "/recovery/factory-reset") {
        if (!this.opts.recovery.factoryReset) {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "recovery_action_not_configured" }));
          return;
        }
        result = await this.opts.recovery.factoryReset(body);
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "recovery_action_not_found" }));
        return;
      }
      const queuedForFinalReview = result !== null && typeof result === "object" &&
        (result as { status?: unknown }).status === "approval_required" &&
        (result as { executed?: unknown }).executed === false;
      const blockedAuthority = result !== null && typeof result === "object" &&
        ["blocked_authority", "approval_unavailable"].includes(String((result as { status?: unknown }).status));
      res.writeHead(queuedForFinalReview ? 202 : blockedAuthority ? 409 : 200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "recovery_action_failed" }));
    }
  }

  private async handleOwnerTaskSubmissionSavedResult(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return send(405, { error: "method_not_allowed" });
    }
    if (url.search || !isLocalControlCenterBrowserRequest(req)) {
      return send(403, { error: "same_origin_local_control_center_required" });
    }
    const store = this.opts.owner_task_submission_store;
    const readResult = this.opts.onOwnerTaskSubmissionSavedResult;
    const unavailable = { error: "owner_task_saved_result_unavailable" };
    if (!this.opts.owner_token || !store?.getStatus || !readResult) return send(404, unavailable);
    if (!this.checkAuth(req, "owner")) return send(401, { error: "unauthorized" });
    if (String(req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return send(415, { error: "application_json_required" });
    }
    if (!this.rateLimitOr429(this.buckets.inbound, OWNER_TOKEN_ACTOR, res)) return;

    let body: Record<string, unknown> | null;
    try {
      body = await readJson(req, 512, true);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "body_too_large";
      return send(tooLarge ? 413 : 400, { error: tooLarge ? "request_body_too_large" : "invalid_owner_task_saved_result" });
    }
    if (!body || !hasExactKeys(body, ["submission_id", "step_index", "result_ref"])) {
      return send(400, { error: "invalid_owner_task_saved_result" });
    }
    const { submission_id, step_index, result_ref } = body;
    if (typeof submission_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(submission_id) ||
        typeof step_index !== "number" || !Number.isSafeInteger(step_index) || step_index < 1 || step_index > MAX_OWNER_TASK_PLAN_STEPS ||
        typeof result_ref !== "string" || !/^[a-f0-9]{64}$/u.test(result_ref)) {
      return send(400, { error: "invalid_owner_task_saved_result" });
    }
    let content: string | null;
    try {
      const status = store.getStatus({ submission_id });
      if (!status || status.state === "rejected") return send(404, unavailable);
      content = await readResult({ request_id: status.request_id, step_index, result_ref });
    } catch {
      return send(404, unavailable);
    }
    if (typeof content !== "string" || !content.trim() || Buffer.byteLength(content, "utf8") > 64 * 1024) {
      return send(404, unavailable);
    }
    send(200, { status: "available", result_ref,
      content_sha256: createHash("sha256").update(content, "utf8").digest("hex"), content,
      used_for_authority: false, may_execute: false });
  }

  private async handleOwnerDailyBriefRead(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (url.search || !isLocalControlCenterBrowserRequest(req)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "same_origin_local_control_center_required" }));
      return;
    }
    const submit = this.opts.onOwnerDailyBriefRead;
    if (!this.opts.owner_token || !submit) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "daily_brief_read_not_configured" }));
      return;
    }
    if (!this.checkAuth(req, "owner")) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (String(req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      res.writeHead(415);
      res.end(JSON.stringify({ error: "application_json_required" }));
      return;
    }
    if (!this.rateLimitOr429(this.buckets.inbound, OWNER_TOKEN_ACTOR, res)) return;
    let body: Record<string, unknown> | null;
    try {
      body = await readJson(req, 512, true);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "body_too_large";
      res.writeHead(tooLarge ? 413 : 400);
      res.end(JSON.stringify({ error: tooLarge ? "request_body_too_large" : "invalid_daily_brief_read" }));
      return;
    }
    const occurrence = body?.occurrence_id_digest;
    const service = body?.service;
    if (!body || !hasExactKeys(body, ["occurrence_id_digest", "service"]) ||
        typeof occurrence !== "string" || !/^[a-f0-9]{64}$/.test(occurrence) || !isDailyBriefReadService(service)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid_daily_brief_read" }));
      return;
    }
    const projection = { used_for_authority: false, may_execute: false } as const;
    try {
      const receipt = await submit({ occurrence_id_digest: occurrence, service, actor: OWNER_TOKEN_ACTOR });
      const { request_id, command_id } = receipt;
      if (receipt.accepted !== true || receipt.status !== "approval_required" ||
          typeof request_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request_id) ||
          typeof command_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(command_id)) {
        res.writeHead(409);
        res.end(JSON.stringify({ accepted: false, status: "daily_brief_read_unavailable", ...projection }));
        return;
      }
      res.writeHead(202);
      res.end(JSON.stringify({ accepted: true, status: "approval_required", request_id, command_id, ...projection }));
    } catch {
      res.writeHead(503);
      res.end(JSON.stringify({ accepted: false, status: "daily_brief_read_unavailable", ...projection }));
    }
  }

  private async handleOwnerLlmSettingsProposal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const propose = this.opts.onOwnerLlmSettingsProposal;
    if (!this.opts.owner_token || !propose) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "owner_llm_settings_proposal_not_configured" }));
      return;
    }
    if (!this.checkAuth(req, "owner")) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (!this.rateLimitOr429(this.buckets.inbound, "owner-task-token-holder", res)) return;

    let body: Record<string, unknown> | null;
    try {
      body = await readJson(req, 4_096, true);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "body_too_large") throw error;
      res.writeHead(413);
      res.end(JSON.stringify({ error: "request_body_too_large" }));
      return;
    }
    const hasGoal = Object.hasOwn(body ?? {}, "goal_ref") || Object.hasOwn(body ?? {}, "purpose_version");
    const fields = hasGoal ? ["expected_provider", "patch", "goal_ref", "purpose_version"] : ["expected_provider", "patch"];
    const parsed = SettingsWriteArgumentsSchema.safeParse({ patch: body?.patch, expected_llm_provider: body?.expected_provider });
    const provider = SettingsWriteLlmProviderSchema.safeParse(body?.expected_provider);
    const goal_ref = body?.goal_ref;
    const purpose_version = body?.purpose_version;
    const goal = typeof goal_ref === "string" && /^goal_[a-f0-9]{16,64}$/.test(goal_ref) &&
      typeof purpose_version === "number" && Number.isSafeInteger(purpose_version) && purpose_version > 0
      ? { goal_ref, purpose_version } : undefined;
    if (!body || !hasExactKeys(body, fields) || !provider.success || !parsed.success || !parsed.data.patch.llm || (hasGoal && !goal)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid_owner_llm_settings_proposal" }));
      return;
    }
    if (settingsWriteRequiresNativeCredentialEntry(parsed.data.patch) && !isLocalControlCenterBrowserRequest(req)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "same_origin_local_control_center_required" }));
      return;
    }
    const projection = { used_for_authority: false, may_execute: false } as const;
    try {
      const result = await propose({ expected_provider: provider.data, patch: { llm: parsed.data.patch.llm }, ...goal, actor: OWNER_TOKEN_ACTOR });
      if (result.accepted !== true) {
        res.writeHead(409);
        res.end(JSON.stringify({ accepted: false, status: "settings_proposal_unavailable", ...projection }));
        return;
      }
      const { status, request_id, command_id, plan_id_digest } = result;
      if (typeof request_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request_id)) {
        throw new Error("invalid_settings_proposal_receipt");
      }
      if (!goal && status === "approval_required" && typeof command_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(command_id)) {
        res.writeHead(202);
        res.end(JSON.stringify({ accepted: true, status, request_id, command_id, ...projection }));
      } else if (goal && status === "candidate_ready" && typeof plan_id_digest === "string" && /^[a-f0-9]{64}$/.test(plan_id_digest)) {
        res.writeHead(202);
        res.end(JSON.stringify({ accepted: true, status, request_id, plan_id_digest, ...projection }));
      } else {
        throw new Error("invalid_settings_proposal_receipt");
      }
    } catch {
      res.writeHead(503);
      res.end(JSON.stringify({ accepted: false, status: "settings_proposal_unavailable", ...projection }));
    }
  }

  private async handleSettingsConfig(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.settings) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "settings_not_configured" }));
      return;
    }
    if (!this.checkSettingsAuth(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "GET") {
      const snapshot = await this.opts.settings.getSnapshot();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (req.method === "POST") {
      res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "settings_write_requires_hds_l3_final_review" }));
      return;
    }
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
  }

  private async handleSettingsLlmVerify(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.opts.settings) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "settings_not_configured" }));
      return;
    }
    if (!this.checkSettingsAuth(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.opts.settings.verifyLlm) {
      res.writeHead(501, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "settings_llm_verify_not_configured" }));
      return;
    }
    const body = await readJson(req);
    if (!body) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "json_body_required" }));
      return;
    }
    const result = await this.opts.settings.verifyLlm(body);
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ ok: true, result }));
  }

  private async handleSettingsMcpInspect(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const responseHeaders = {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    } as const;
    if (!this.opts.settings) {
      res.writeHead(404, responseHeaders);
      res.end(JSON.stringify({ error: "settings_not_configured" }));
      return;
    }
    if (!this.checkSettingsAuth(req)) {
      res.writeHead(401, responseHeaders);
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, responseHeaders);
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (!this.opts.settings.inspectMcpEndpoint) {
      res.writeHead(501, responseHeaders);
      res.end(JSON.stringify({ error: "settings_mcp_inspection_not_configured" }));
      return;
    }
    let body: Record<string, unknown> | null;
    try {
      body = await readJson(req, 8 * 1024);
    } catch {
      res.writeHead(413, responseHeaders);
      res.end(JSON.stringify({ error: "mcp_endpoint_invalid" }));
      return;
    }
    if (!body || !hasExactKeys(body, ["endpoint"]) || typeof body.endpoint !== "string" ||
        body.endpoint.length > 2048) {
      res.writeHead(400, responseHeaders);
      res.end(JSON.stringify({ error: "mcp_endpoint_invalid" }));
      return;
    }
    try {
      const result = await this.opts.settings.inspectMcpEndpoint(body.endpoint);
      res.writeHead(200, responseHeaders);
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      const invalidEndpoint = reason === "mcp_endpoint_invalid" ||
        reason === "mcp_endpoint_must_be_credentialless_loopback_streamable_http";
      res.writeHead(invalidEndpoint ? 400 : 500, responseHeaders);
      res.end(JSON.stringify({ error: invalidEndpoint ? reason : "mcp_inspection_unavailable" }));
    }
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false;
    }
  }
  return true;
}
