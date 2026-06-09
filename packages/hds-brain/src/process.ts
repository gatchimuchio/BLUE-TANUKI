import type { InboundRequest } from "@blue-tanuki/protocol";
import { finalReviewOperationList } from "./approval_policy.js";
import type {
  ActorKind,
  ActorRef,
  HDSProcessDefinition,
  MemoryReadPolicy,
  ProcessKind,
  TrustLevel,
} from "./types.js";

const CHAT_MEMORY_POLICY: MemoryReadPolicy = {
  policy_id: "memory.chat.v1",
  enabled: true,
  max_hits: 5,
  allowed_sources: ["hds_ltm"],
  retrieval_modes: ["recent", "tag", "exact"],
};

const TOOL_MEMORY_POLICY: MemoryReadPolicy = {
  policy_id: "memory.tool.v1",
  enabled: true,
  max_hits: 8,
  allowed_sources: ["hds_ltm", "authority", "audit"],
  retrieval_modes: ["exact", "tag", "recent"],
};

const LOW_TRUST_MEMORY_POLICY: MemoryReadPolicy = {
  policy_id: "memory.low_trust.v1",
  enabled: true,
  max_hits: 3,
  allowed_sources: ["hds_ltm"],
  retrieval_modes: ["exact", "tag"],
};

export function resolveActor(req: InboundRequest): ActorRef {
  const meta = req.metadata ?? {};
  const trustedAuthorityContext = isTrustedAuthorityContext(meta);
  const explicitKind = trustedAuthorityContext
    ? stringField(meta, "blue_tanuki.actor_kind") ?? stringField(meta, "actor_kind")
    : undefined;
  const explicitTrust = trustedAuthorityContext
    ? stringField(meta, "blue_tanuki.trust_level") ?? stringField(meta, "trust_level")
    : undefined;
  const actor_kind = isActorKind(explicitKind) ? explicitKind : inferActorKind(req);
  const trust_level = isTrustLevel(explicitTrust) ? explicitTrust : inferTrustLevel(req, actor_kind);
  return {
    actor_id: req.user,
    actor_kind,
    channel: req.channel,
    external_user_id: stringField(meta, "external_user_id") ?? stringField(meta, "reply_to"),
    trust_level,
  };
}

export function resolveProcess(req: InboundRequest, actor: ActorRef): HDSProcessDefinition {
  const meta = req.metadata ?? {};
  const trustedAuthorityContext = isTrustedAuthorityContext(meta);
  const explicitKind = trustedAuthorityContext
    ? stringField(meta, "blue_tanuki.process_kind") ?? stringField(meta, "process_kind")
    : undefined;
  const process_kind = isProcessKind(explicitKind) ? explicitKind : inferProcessKind(req, actor);
  const process_id = `${process_kind}.process`;
  const lowTrust = actor.trust_level === "limited" || actor.trust_level === "untrusted";
  const memory_policy = process_kind === "tool"
    ? TOOL_MEMORY_POLICY
    : lowTrust || process_kind === "webhook"
    ? LOW_TRUST_MEMORY_POLICY
    : CHAT_MEMORY_POLICY;

  return {
    process_id,
    process_kind,
    version: "v1",
    trigger: {
      kind: triggerKind(process_kind),
      channel: req.channel,
    },
    actor_policy: {
      allowed_actor_kinds: allowedActorKinds(process_kind),
      owner_required: process_kind === "approval",
    },
    memory_policy,
    approval_profile: {
      default_mode: "full_access",
      final_review_operations: finalReviewOperationList(),
    },
    execution_policy: executionPolicy(process_kind),
    capture_policy: {
      capture_on: ["assert", "approval", "feedback", "failure"],
      persist_to_ltm: true,
    },
  };
}

function inferActorKind(req: InboundRequest): ActorKind {
  const meta = req.metadata ?? {};
  const trigger = isTrustedAuthorityContext(meta) ? stringField(meta, "trigger_kind") : undefined;
  if (trigger === "cron" || req.channel === "cron") return "cron";
  if (trigger === "webhook" || req.channel === "webhook") return "webhook";
  if (req.channel === "system") return "system";
  if (req.channel === "cli" && req.user === "local-user") return "owner";
  return "user";
}

function inferTrustLevel(req: InboundRequest, kind: ActorKind): TrustLevel {
  if (kind === "owner") return "owner";
  if (kind === "system" || kind === "cron") return "trusted";
  if (kind === "webhook") return "limited";
  if (req.channel === "webchat") return "trusted";
  return "limited";
}

function inferProcessKind(req: InboundRequest, actor: ActorRef): ProcessKind {
  const trimmed = req.content.trim();
  if (actor.actor_kind === "cron") return "cron";
  if (actor.actor_kind === "webhook") return "webhook";
  if (trimmed.startsWith("tool:") || trimmed.startsWith("/tool") || req.metadata?.["blue_tanuki.tool_call"] || req.metadata?.tool_call) return "tool";
  if (isTrustedAuthorityContext(req.metadata ?? {}) && (req.metadata?.["blue_tanuki.resume"] || req.metadata?.resume)) return "approval";
  return "chat";
}

function triggerKind(process_kind: ProcessKind): HDSProcessDefinition["trigger"]["kind"] {
  if (process_kind === "cron") return "cron";
  if (process_kind === "webhook") return "webhook";
  if (process_kind === "approval") return "resume";
  return "inbound";
}

function allowedActorKinds(process_kind: ProcessKind): ActorKind[] {
  if (process_kind === "approval") return ["owner", "user"];
  if (process_kind === "cron") return ["cron", "system", "owner"];
  if (process_kind === "webhook") return ["webhook"];
  return ["owner", "user", "system", "cron", "webhook"];
}

function executionPolicy(process_kind: ProcessKind): HDSProcessDefinition["execution_policy"] {
  if (process_kind === "tool") {
    return {
      allowed_command_types: ["tool_call", "noop"],
      allowed_tools: [
        "echo",
        "file.search",
        "file.write",
        "file.edit",
        "http.fetch",
        "web.search",
        "github.read",
        "github.write",
        "gmail.read",
        "google.calendar.read",
        "google.drive.read",
        "gmail.write",
        "google.calendar.write",
        "google.drive.write",
        "composio.search",
        "composio.execute",
        "browser.read",
        "browser.snapshot",
        "browser.automation",
        "shell.exec",
        "schedule.list",
        "schedule.create",
        "schedule.update",
        "schedule.delete",
      ],
      allowed_capabilities: [
        "tool:echo",
        "tool:file.search",
        "tool:file.write",
        "tool:file.edit",
        "fs:read",
        "fs:write",
        "tool:http.fetch",
        "tool:web.search",
        "tool:github.read",
        "tool:github.write",
        "tool:gmail.read",
        "tool:google.calendar.read",
        "tool:google.drive.read",
        "tool:gmail.write",
        "tool:google.calendar.write",
        "tool:google.drive.write",
        "tool:composio.search",
        "tool:composio.execute",
        "tool:browser.read",
        "tool:browser.snapshot",
        "tool:browser.automation",
        "browser:snapshot",
        "browser:act",
        "tool:shell.exec",
        "tool:schedule.list",
        "tool:schedule.create",
        "tool:schedule.update",
        "tool:schedule.delete",
        "schedule:read",
        "schedule:create",
        "schedule:update",
        "schedule:delete",
        "network:http",
        "network:github.com",
        "network:googleapis.com",
        "network:composio.dev",
        "secrets:GITHUB_TOKEN",
        "secrets:GOOGLE_ACCESS_TOKEN",
        "secrets:GMAIL_ACCESS_TOKEN",
        "secrets:GOOGLE_CALENDAR_ACCESS_TOKEN",
        "secrets:GOOGLE_DRIVE_ACCESS_TOKEN",
        "secrets:COMPOSIO_API_KEY",
        "google:gmail.read",
        "google:calendar.read",
        "google:drive.read",
        "google:gmail.write",
        "google:calendar.write",
        "google:drive.write",
        "external:send",
        "email:send",
        "github:issue.write",
        "github:pr.write",
        "github:comment.write",
        "shell:exec",
      ],
      timeout_ms: 15_000,
    };
  }
  if (process_kind === "cron") {
    return {
      allowed_command_types: ["llm_call", "channel_send", "noop"],
      allowed_tools: [],
      allowed_capabilities: ["channel:send"],
      timeout_ms: 30_000,
    };
  }
  if (process_kind === "webhook") {
    return {
      allowed_command_types: ["noop", "channel_send"],
      allowed_tools: [],
      allowed_capabilities: [],
      timeout_ms: 10_000,
    };
  }
  return {
    allowed_command_types: ["llm_call", "tool_call", "noop"],
    allowed_tools: [
      "echo",
      "file.search",
      "file.write",
      "file.edit",
      "http.fetch",
      "web.search",
      "github.read",
      "github.write",
      "gmail.read",
      "google.calendar.read",
      "google.drive.read",
      "gmail.write",
      "google.calendar.write",
      "google.drive.write",
      "composio.search",
      "composio.execute",
      "browser.read",
      "browser.snapshot",
      "browser.automation",
      "shell.exec",
      "schedule.list",
      "schedule.create",
      "schedule.update",
      "schedule.delete",
    ],
    allowed_capabilities: [],
    timeout_ms: 30_000,
  };
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isActorKind(value: string | undefined): value is ActorKind {
  return value === "owner" || value === "user" || value === "system" || value === "webhook" || value === "cron";
}

function isTrustLevel(value: string | undefined): value is TrustLevel {
  return value === "owner" || value === "trusted" || value === "limited" || value === "untrusted";
}

function isProcessKind(value: string | undefined): value is ProcessKind {
  return value === "chat" || value === "tool" || value === "approval" || value === "cron" || value === "webhook" || value === "system";
}

/**
 * External channel metadata is untrusted. It may carry reply targets or tool
 * request payloads, but it must not be allowed to upgrade actor/process
 * authority. Only gateway-internal normalization code may set this marker.
 */
function isTrustedAuthorityContext(meta: Record<string, unknown>): boolean {
  return meta["blue_tanuki.authority_context"] === "gateway_internal_v1";
}
