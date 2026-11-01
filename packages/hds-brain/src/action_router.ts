import type { InboundRequest } from "@blue-tanuki/protocol";
import { getToolOperationDescriptor, isGatewayInternalInboundRequest,
  OperationPlanGoalPurposeRelationReviewArgumentsSchema } from "@blue-tanuki/protocol";
import { DOCUMENT_ORGANIZATION_MAX_SOURCE_CHARS } from "./document_organization.js";

export interface ToolActionRoute {
  type: "tool_call";
  tool_name: string;
  arguments: Record<string, unknown>;
  allowed_capabilities: string[];
  timeout_ms: number;
}

export interface NoopActionRoute {
  type: "noop";
  reason: string;
}

export type ActionRoute = ToolActionRoute | NoopActionRoute | null;

/**
 * Route explicit tool requests to a bounded command envelope.
 *
 * Supported content forms:
 *   - tool:file.search root=. query=needle max_results=5
 *   - tool:file.write path=notes/today.md content="hello" mode=create
 *   - tool:file.edit path=notes/today.md search=hello replace=hi expected_replacements=1
 *   - tool:http.fetch url=https://example.com method=HEAD
 *   - tool:web.search query="blue tanuki" max_results=5
 *   - tool:github.read resource=issues owner=gatchimuchio repo=blue-tanuki max_results=5
 *   - tool:github.write operation=issue.create owner=gatchimuchio repo=blue-tanuki title="hello" body="world"
 *   - tool:gmail.read query="newer_than:1d" max_results=5 include_attachment_metadata=true
 *   - tool:google.calendar.read calendar_id=primary days=1 max_results=5 view=events
 *   - tool:google.calendar.read calendar_id=primary days=1 view=freebusy time_zone=Asia/Tokyo
 *   - tool:google.drive.read query="trashed=false" max_results=5
 *   - /organize-drive file_id=<exact-id>
 *   - tool:gmail.write operation=draft.create to=owner@example.com cc=copy@example.com bcc=hidden@example.com reply_to=replies@example.com subject="hello" body_text="draft"
 *   - tool:google.calendar.write operation=event.create calendar_id=primary summary="Standup" start=2026-05-12T09:00:00Z end=2026-05-12T09:15:00Z
 *   - tool:google.drive.write operation=file.create name=notes.txt content="hello"
 *   - tool:composio.search toolkit=github query=issues
 *   - tool:composio.execute toolkit=github tool=issues.search payload="{...}"
 *   - tool:browser.read url=https://example.com max_chars=4000
 *   - tool:browser.snapshot url=https://example.com max_chars=4000
 *   - tool:browser.automation action=smoke
 *   - tool:browser.automation action=navigate url=https://example.com
 *   - tool:shell.exec {"cmd":"git","args":["status","-sb"],"cwd":"."}
 *   - tool:schedule.list
 *   - tool:schedule.create channel=webchat target=local-user content="runtime smoke" interval_ms=120000
 *   - tool:schedule.update id=<id> content="updated smoke"
 *   - tool:schedule.delete id=<id>
 *   - /tool echo text="hello"
 *   - tool:http.fetch {"url":"https://example.com","method":"GET"}
 *
 * Supported metadata forms:
 *   - metadata["blue_tanuki.tool_call"] = { tool_name, arguments }
 *   - metadata.tool_call = { tool_name, arguments }
 */
export function routeAction(req: InboundRequest): ActionRoute {
  const driveOrganization = routeDriveOrganization(req);
  if (driveOrganization) return driveOrganization;
  const fromMetadata = routeMetadata(req);
  if (fromMetadata) return rejectUnconsumedDriveContent(fromMetadata);
  return rejectUnconsumedDriveContent(routeContent(req.content));
}

function routeDriveOrganization(req: InboundRequest): ActionRoute {
  const trimmed = req.content.trim();
  if (!/^\/organize-drive(?:$|[\t ])/u.test(trimmed)) return null;
  if (req.channel !== "cli" && req.channel !== "webchat") {
    return { type: "noop", reason: "Drive document organization is available only through CLI or WebChat" };
  }
  const match = /^\/organize-drive(?:[\t ]+([\s\S]*))?$/u.exec(trimmed);
  if (!match) return { type: "noop", reason: "use /organize-drive file_id=<exact-id>" };
  let args: Record<string, unknown>;
  try {
    args = parseArgs(match[1] ?? "");
  } catch (error) {
    return { type: "noop", reason: error instanceof Error ? error.message : String(error) };
  }
  const fileId = args.file_id;
  if (Object.keys(args).length !== 1 || typeof fileId !== "string" || fileId.length === 0 ||
      fileId !== fileId.trim() || /[\s/?#\\\u0000-\u001f\u007f]/u.test(fileId)) {
    return { type: "noop", reason: "Drive document organization requires one exact safe file_id" };
  }
  return buildToolRoute("google.drive.read", {
    file_id: fileId,
    include_content: true,
    include_sharing: true,
    max_content_bytes: DOCUMENT_ORGANIZATION_MAX_SOURCE_CHARS,
  });
}

function rejectUnconsumedDriveContent(route: ActionRoute): ActionRoute {
  if (!route || route.type !== "tool_call" || route.tool_name !== "google.drive.read") return route;
  const value = route.arguments.include_content;
  const requested = value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
  return requested
    ? { type: "noop", reason: "use /organize-drive file_id=<exact-id> so Drive text reaches only the untrusted document-organization consumer" }
    : route;
}

function routeMetadata(req: InboundRequest): ActionRoute {
  const raw =
    req.metadata?.["blue_tanuki.tool_call"] ?? req.metadata?.["tool_call"];
  if (raw === undefined) return null;
  if (!isRecord(raw)) {
    return { type: "noop", reason: "tool_call metadata must be an object" };
  }
  const toolName = stringField(raw, "tool_name") ?? stringField(raw, "tool");
  if (!toolName) {
    return { type: "noop", reason: "tool_call metadata missing tool_name" };
  }
  const argsRaw = raw.arguments ?? raw.args ?? {};
  if (!isRecord(argsRaw)) {
    return { type: "noop", reason: "tool_call metadata arguments must be an object" };
  }
  if (toolName === "goal.governance.change") {
    return routeInternalGoalPurposeChange(req, argsRaw);
  }
  if (toolName === "goal.governance.review_task_purpose") {
    return routeInternalGoalPurposeRelationReview(req, argsRaw);
  }
  if (toolName === "memory.meaning.adopt") {
    return routeInternalMeaningUpdateAdoption(req, argsRaw);
  }
  if (toolName === "memory.citation.reassess") {
    return routeInternalMemoryCitationReassessment(req, argsRaw);
  }
  return buildToolRoute(toolName, { ...argsRaw });
}

function routeInternalGoalPurposeChange(req: InboundRequest, args: Record<string, unknown>): ActionRoute {
  const metadata = req.metadata ?? {};
  if (!isGatewayInternalInboundRequest(req) ||
      metadata["blue_tanuki.authority_context"] !== "gateway_internal_v1" ||
      metadata["blue_tanuki.actor_kind"] !== "owner" ||
      metadata["blue_tanuki.process_kind"] !== "approval" ||
      metadata["blue_tanuki.goal_purpose_change.version"] !== "v1" ||
      req.content !== "Owner submitted a delegated goal purpose change for L3 review.") {
    return { type: "noop", reason: "goal purpose change requires a trusted Gateway approval request" };
  }
  const expectedKeys = ["goal_ref", "prior_version", "prior_purpose_digest", "new_purpose_digest"];
  if (Object.keys(args).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(args, key)) ||
      typeof args.goal_ref !== "string" || !/^goal_[a-f0-9]{16,64}$/.test(args.goal_ref) ||
      typeof args.prior_version !== "number" || !Number.isSafeInteger(args.prior_version) || args.prior_version <= 0 ||
      typeof args.prior_purpose_digest !== "string" || !/^[a-f0-9]{64}$/.test(args.prior_purpose_digest) ||
      typeof args.new_purpose_digest !== "string" || !/^[a-f0-9]{64}$/.test(args.new_purpose_digest) ||
      args.new_purpose_digest === args.prior_purpose_digest) {
    return { type: "noop", reason: "goal purpose change arguments are invalid" };
  }
  return {
    type: "tool_call",
    tool_name: "goal.governance.change",
    arguments: { ...args },
    allowed_capabilities: ["tool:goal.governance.change"],
    timeout_ms: 10_000,
  };
}

function routeInternalGoalPurposeRelationReview(req: InboundRequest, args: Record<string, unknown>): ActionRoute {
  const metadata = req.metadata ?? {};
  if (!isGatewayInternalInboundRequest(req) ||
      metadata["blue_tanuki.authority_context"] !== "gateway_internal_v1" ||
      metadata["blue_tanuki.actor_kind"] !== "owner" ||
      metadata["blue_tanuki.process_kind"] !== "approval" ||
      metadata["blue_tanuki.goal_purpose_relation_review.version"] !== "v1" ||
      req.content !== "Owner submitted a task-purpose relation assessment for L3 review.") {
    return { type: "noop", reason: "task-purpose relation review requires a trusted Gateway approval request" };
  }
  const parsed = OperationPlanGoalPurposeRelationReviewArgumentsSchema.safeParse(args);
  if (!parsed.success) return { type: "noop", reason: "task-purpose relation review arguments are invalid" };
  return {
    type: "tool_call",
    tool_name: "goal.governance.review_task_purpose",
    arguments: parsed.data,
    allowed_capabilities: ["tool:goal.governance.review_task_purpose"],
    timeout_ms: 10_000,
  };
}

function routeInternalMeaningUpdateAdoption(req: InboundRequest, args: Record<string, unknown>): ActionRoute {
  const metadata = req.metadata ?? {};
  if (!isGatewayInternalInboundRequest(req) ||
      metadata["blue_tanuki.authority_context"] !== "gateway_internal_v1" ||
      metadata["blue_tanuki.actor_kind"] !== "owner" ||
      metadata["blue_tanuki.process_kind"] !== "approval" ||
      metadata["blue_tanuki.meaning_update_adoption.version"] !== "v1" ||
      req.content !== "Owner submitted a C meaning-update candidate for L3 review.") {
    return { type: "noop", reason: "meaning update adoption requires a trusted Gateway approval request" };
  }
  const requiredKeys = ["proposal_digest", "candidate_digest", "target_record_id", "target_version"];
  const keys = Object.keys(args).sort();
  if (keys.join(",") !== [...requiredKeys].sort().join(",") &&
      keys.join(",") !== [...requiredKeys, "source_observation_digest"].sort().join(",")) {
    return { type: "noop", reason: "meaning update adoption arguments are invalid" };
  }
  if (requiredKeys.some((key) => !Object.hasOwn(args, key)) ||
      typeof args.proposal_digest !== "string" || !/^[a-f0-9]{64}$/.test(args.proposal_digest) ||
      typeof args.candidate_digest !== "string" || !/^[a-f0-9]{64}$/.test(args.candidate_digest) ||
      typeof args.target_record_id !== "string" || !/^F:[A-Za-z0-9_.:-]{1,96}$/.test(args.target_record_id) ||
      typeof args.target_version !== "string" || !/^[a-f0-9]{64}$/.test(args.target_version) ||
      (args.source_observation_digest !== undefined &&
        (typeof args.source_observation_digest !== "string" || !/^[a-f0-9]{64}$/.test(args.source_observation_digest)))) {
    return { type: "noop", reason: "meaning update adoption arguments are invalid" };
  }
  return { type: "tool_call", tool_name: "memory.meaning.adopt", arguments: { ...args },
    allowed_capabilities: ["tool:memory.meaning.adopt"], timeout_ms: 10_000 };
}

function routeInternalMemoryCitationReassessment(req: InboundRequest, args: Record<string, unknown>): ActionRoute {
  const metadata = req.metadata ?? {};
  if (!isGatewayInternalInboundRequest(req) || metadata["blue_tanuki.authority_context"] !== "gateway_internal_v1" ||
      metadata["blue_tanuki.actor_kind"] !== "owner" || metadata["blue_tanuki.process_kind"] !== "approval" ||
      metadata["blue_tanuki.memory_judgment_reassessment.version"] !== "v1" ||
      req.content !== "Owner submitted a fresh J citation judgment for explicit M reassessment.") {
    return { type: "noop", reason: "memory judgment reassessment requires a trusted Gateway approval request" };
  }
  const keys = ["citation_request_id", "citation_command_id", "target_record_id", "target_version",
    "interpretation_id", "judgment_ref", "citation_audit_digest"];
  if (Object.keys(args).length !== keys.length || keys.some((key) => !Object.hasOwn(args, key)) ||
      typeof args.citation_request_id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(args.citation_request_id) ||
      typeof args.citation_command_id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(args.citation_command_id) ||
      typeof args.target_record_id !== "string" || !/^F:[A-Za-z0-9_.:-]{1,96}$/.test(args.target_record_id) ||
      typeof args.target_version !== "string" || !/^[a-f0-9]{64}$/.test(args.target_version) ||
      typeof args.interpretation_id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(args.interpretation_id) ||
      typeof args.judgment_ref !== "string" || !/^memory-citation-review:[A-Za-z0-9_.:-]{1,200}$/.test(args.judgment_ref) ||
      typeof args.citation_audit_digest !== "string" || !/^[a-f0-9]{64}$/.test(args.citation_audit_digest)) {
    return { type: "noop", reason: "memory judgment reassessment arguments are invalid" };
  }
  return { type: "tool_call", tool_name: "memory.citation.reassess", arguments: { ...args },
    allowed_capabilities: ["tool:memory.citation.reassess"], timeout_ms: 10_000 };
}

function routeContent(content: string): ActionRoute {
  const trimmed = content.trim();
  const match = /^(?:tool:([A-Za-z0-9_.-]+)|\/tool\s+([A-Za-z0-9_.-]+))(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const toolName = match[1] ?? match[2] ?? "";
  const rest = (match[3] ?? "").trim();
  let args: Record<string, unknown>;
  try {
    args = parseArgs(rest);
  } catch (e) {
    return {
      type: "noop",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
  return buildToolRoute(toolName, args);
}

function buildToolRoute(
  toolName: string,
  args: Record<string, unknown>,
): ActionRoute {
  const spec = getToolOperationDescriptor(toolName);
  if (!spec) {
    return { type: "noop", reason: `unsupported tool: ${toolName}` };
  }
  return {
    type: "tool_call",
    tool_name: toolName,
    arguments: coerceToolArgs(toolName, args),
    allowed_capabilities: [...spec.required_capabilities],
    timeout_ms: spec.timeout_ms,
  };
}

function parseArgs(rest: string): Record<string, unknown> {
  if (!rest) return {};
  if (rest.startsWith("{")) {
    const parsed = JSON.parse(rest) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("tool arguments JSON must be an object");
    }
    return { ...parsed };
  }
  const out: Record<string, unknown> = {};
  for (const token of tokenize(rest)) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      throw new Error(`tool argument must be key=value: ${token}`);
    }
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    out[key] = value;
  }
  return out;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("unterminated quoted tool argument");
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function coerceToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...args };
  if (
    toolName === "file.search" ||
    toolName === "web.search" ||
    toolName === "github.read" ||
    toolName === "gmail.read" ||
    toolName === "google.calendar.read" ||
    toolName === "google.drive.read"
  ) {
    coercePositiveInt(next, "max_results");
  }
  if (
    toolName === "http.fetch" ||
    toolName === "web.search" ||
    toolName === "github.read" ||
    toolName === "github.write" ||
    toolName === "gmail.read" ||
    toolName === "google.calendar.read" ||
    toolName === "google.drive.read" ||
    toolName === "gmail.write" ||
    toolName === "google.calendar.write" ||
    toolName === "google.drive.write" ||
    toolName === "browser.read" ||
    toolName === "browser.snapshot" ||
    toolName === "browser.automation" ||
    toolName === "file.write" ||
    toolName === "file.edit" ||
    toolName === "shell.exec" ||
    toolName === "schedule.create" ||
    toolName === "schedule.update"
  ) {
    coercePositiveInt(next, "max_bytes");
  }
  if (toolName === "shell.exec") {
    coercePositiveInt(next, "timeout_ms");
  }
  if (
    toolName === "browser.read" ||
    toolName === "browser.snapshot" ||
    toolName === "browser.automation"
  ) {
    coercePositiveInt(next, "max_chars");
  }
  if (toolName === "browser.snapshot" || toolName === "browser.automation") {
    coercePositiveInt(next, "timeout_ms");
  }
  if (toolName === "github.read" || toolName === "github.write") {
    coercePositiveInt(next, "number");
  }
  if (toolName === "google.calendar.read") {
    coercePositiveInt(next, "days");
  }
  if (toolName === "google.drive.write") {
    coercePositiveInt(next, "max_content_bytes");
  }
  if (toolName === "file.edit") {
    coercePositiveInt(next, "expected_replacements");
  }
  if (toolName === "schedule.create" || toolName === "schedule.update") {
    coercePositiveInt(next, "interval_ms");
  }
  if (toolName === "http.fetch") {
    if (typeof next.method === "string") {
      next.method = next.method.toUpperCase();
    }
  }
  return next;
}

function coercePositiveInt(args: Record<string, unknown>, key: string): void {
  const value = args[key];
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    args[key] = parseInt(value, 10);
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
