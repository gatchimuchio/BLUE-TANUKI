import type { OperationAdapterKind, OperationEffect } from "./operation_core.js";

/**
 * Reviewed semantic subset for operations that BLUE-TANUKI currently routes.
 * This catalog is configuration/evidence only; it does not grant permission.
 */
export interface OperationDescriptor {
  operation_id: string;
  descriptor_version: string;
  implementation_ref: string;
  tool_name?: string;
  adapter: OperationAdapterKind;
  effects: readonly OperationEffect[];
  required_capabilities: readonly string[];
  timeout_ms: number;
  aliases: readonly string[];
}

type DescriptorInput = Omit<OperationDescriptor, "descriptor_version">;

function freezeDescriptor(input: DescriptorInput): OperationDescriptor {
  return Object.freeze({
    ...input,
    descriptor_version: "1.0.0",
    effects: Object.freeze([...input.effects]),
    required_capabilities: Object.freeze([...input.required_capabilities]),
    aliases: Object.freeze([...input.aliases]),
  });
}

function toolDescriptor(
  toolName: string,
  implementation_ref: string,
  adapter: OperationAdapterKind,
  effects: readonly OperationEffect[],
  required_capabilities: readonly string[],
  timeout_ms: number,
  aliases: readonly string[] = [],
): OperationDescriptor {
  return freezeDescriptor({
    operation_id: toolName,
    implementation_ref,
    tool_name: toolName,
    adapter,
    effects,
    required_capabilities,
    timeout_ms,
    aliases,
  });
}

function operationDescriptor(
  operation_id: string,
  implementation_ref: string,
  adapter: OperationAdapterKind,
  effects: readonly OperationEffect[],
  required_capabilities: readonly string[],
  timeout_ms: number,
  aliases: readonly string[] = [],
): OperationDescriptor {
  return freezeDescriptor({
    operation_id,
    implementation_ref,
    adapter,
    effects,
    required_capabilities,
    timeout_ms,
    aliases,
  });
}

export const OPERATION_DESCRIPTOR_REGISTRY: readonly OperationDescriptor[] = Object.freeze([
  toolDescriptor(
    "echo",
    "packages/blue-tanuki/src/tools/registry.ts#echoTool",
    "internal_runtime",
    ["observe"],
    ["tool:echo"],
    5_000,
  ),
  toolDescriptor(
    "file.search",
    "packages/blue-tanuki/src/tools/builtin.ts#fileSearchTool",
    "internal_runtime",
    ["read"],
    ["tool:file.search", "fs:read"],
    10_000,
    ["file.read"],
  ),
  toolDescriptor(
    "file.write",
    "packages/blue-tanuki/src/tools/builtin.ts#fileWriteTool",
    "internal_runtime",
    ["write"],
    ["tool:file.write", "fs:write"],
    15_000,
  ),
  toolDescriptor(
    "file.edit",
    "packages/blue-tanuki/src/tools/builtin.ts#fileEditTool",
    "internal_runtime",
    ["read", "write"],
    ["tool:file.edit", "fs:read", "fs:write"],
    15_000,
  ),
  toolDescriptor(
    "http.fetch",
    "packages/blue-tanuki/src/tools/builtin.ts#httpFetchTool",
    "external_api",
    ["external_send", "read"],
    ["tool:http.fetch", "network:http"],
    15_000,
  ),
  toolDescriptor(
    "web.search",
    "packages/blue-tanuki/src/tools/builtin.ts#webSearchTool",
    "external_api",
    ["external_send", "read"],
    ["tool:web.search", "network:http"],
    15_000,
  ),
  toolDescriptor(
    "github.read",
    "packages/blue-tanuki/src/tools/builtin.ts#githubReadTool",
    "external_api",
    ["external_send", "read"],
    ["tool:github.read", "network:github.com"],
    15_000,
  ),
  toolDescriptor(
    "github.write",
    "packages/blue-tanuki/src/tools/builtin.ts#githubWriteTool",
    "external_api",
    ["external_send", "write", "credential_access"],
    [
      "tool:github.write",
      "network:github.com",
      "secrets:GITHUB_TOKEN",
      "github:issue.write",
      "github:pr.write",
      "github:comment.write",
    ],
    15_000,
  ),
  toolDescriptor(
    "gmail.read",
    "packages/blue-tanuki/src/tools/google_read.ts#gmailReadTool",
    "external_api",
    ["external_send", "read", "credential_access"],
    [
      "tool:gmail.read",
      "network:googleapis.com",
      "secrets:GMAIL_ACCESS_TOKEN",
      "secrets:GOOGLE_ACCESS_TOKEN",
      "google:gmail.read",
    ],
    15_000,
    ["google.gmail.read"],
  ),
  toolDescriptor(
    "google.calendar.read",
    "packages/blue-tanuki/src/tools/google_read.ts#googleCalendarReadTool",
    "external_api",
    ["external_send", "read", "credential_access"],
    [
      "tool:google.calendar.read",
      "network:googleapis.com",
      "secrets:GOOGLE_CALENDAR_ACCESS_TOKEN",
      "secrets:GOOGLE_ACCESS_TOKEN",
      "google:calendar.read",
    ],
    15_000,
  ),
  toolDescriptor(
    "google.drive.read",
    "packages/blue-tanuki/src/tools/google_read.ts#googleDriveReadTool",
    "external_api",
    ["external_send", "read", "credential_access"],
    [
      "tool:google.drive.read",
      "network:googleapis.com",
      "secrets:GOOGLE_DRIVE_ACCESS_TOKEN",
      "secrets:GOOGLE_ACCESS_TOKEN",
      "google:drive.read",
    ],
    15_000,
  ),
  toolDescriptor(
    "gmail.write",
    "packages/blue-tanuki/src/tools/google_write.ts#gmailWriteTool",
    "external_api",
    ["external_send", "write", "credential_access"],
    [
      "tool:gmail.write",
      "network:googleapis.com",
      "secrets:GMAIL_ACCESS_TOKEN",
      "secrets:GOOGLE_ACCESS_TOKEN",
      "google:gmail.write",
      "external:send",
      "email:send",
    ],
    15_000,
  ),
  toolDescriptor(
    "google.calendar.write",
    "packages/blue-tanuki/src/tools/google_write.ts#googleCalendarWriteTool",
    "external_api",
    ["external_send", "write", "credential_access"],
    [
      "tool:google.calendar.write",
      "network:googleapis.com",
      "secrets:GOOGLE_CALENDAR_ACCESS_TOKEN",
      "secrets:GOOGLE_ACCESS_TOKEN",
      "google:calendar.write",
    ],
    15_000,
  ),
  toolDescriptor(
    "google.drive.write",
    "packages/blue-tanuki/src/tools/google_write.ts#googleDriveWriteTool",
    "external_api",
    ["external_send", "write", "credential_access"],
    [
      "tool:google.drive.write",
      "network:googleapis.com",
      "secrets:GOOGLE_DRIVE_ACCESS_TOKEN",
      "secrets:GOOGLE_ACCESS_TOKEN",
      "google:drive.write",
    ],
    15_000,
  ),
  toolDescriptor(
    "composio.search",
    "packages/blue-tanuki/src/tools/composio.ts#composioSearchTool",
    "composio",
    ["external_send", "read", "credential_access"],
    ["tool:composio.search", "network:composio.dev", "secrets:COMPOSIO_API_KEY"],
    15_000,
  ),
  toolDescriptor(
    "composio.execute",
    "packages/blue-tanuki/src/tools/composio.ts#composioExecuteTool",
    "composio",
    ["external_send", "read", "write", "delete", "credential_access"],
    [
      "tool:composio.execute",
      "network:composio.dev",
      "secrets:COMPOSIO_API_KEY",
      "external:send",
    ],
    15_000,
  ),
  toolDescriptor(
    "browser.read",
    "packages/blue-tanuki/src/tools/builtin.ts#browserReadTool",
    "external_api",
    ["external_send", "read"],
    ["tool:browser.read", "network:http"],
    15_000,
  ),
  toolDescriptor(
    "browser.snapshot",
    "packages/blue-tanuki/src/tools/builtin.ts#browserSnapshotTool",
    "browser",
    ["external_send", "read", "browser_action"],
    ["tool:browser.snapshot", "browser:snapshot", "network:http"],
    15_000,
  ),
  toolDescriptor(
    "browser.automation",
    "packages/blue-tanuki/src/tools/builtin.ts#browserAutomationTool",
    "browser",
    ["external_send", "read", "browser_action"],
    ["tool:browser.automation", "browser:act", "network:http"],
    15_000,
  ),
  toolDescriptor(
    "shell.exec",
    "packages/blue-tanuki/src/tools/shell_exec.ts#shellExecTool",
    "shell",
    [
      "process_spawn",
      "read",
      "write",
      "delete",
      "external_send",
      "credential_access",
      "settings_change",
    ],
    ["tool:shell.exec", "shell:exec"],
    15_000,
  ),
  toolDescriptor(
    "schedule.list",
    "apps/gateway/src/runtime_schedule.ts#RuntimeScheduleManager.tools",
    "internal_runtime",
    ["read"],
    ["tool:schedule.list", "schedule:read"],
    5_000,
  ),
  toolDescriptor(
    "schedule.create",
    "apps/gateway/src/runtime_schedule.ts#RuntimeScheduleManager.tools",
    "internal_runtime",
    ["schedule_change", "write"],
    ["tool:schedule.create", "schedule:create"],
    5_000,
  ),
  toolDescriptor(
    "schedule.update",
    "apps/gateway/src/runtime_schedule.ts#RuntimeScheduleManager.tools",
    "internal_runtime",
    ["schedule_change", "write"],
    ["tool:schedule.update", "schedule:update"],
    5_000,
  ),
  toolDescriptor(
    "schedule.delete",
    "apps/gateway/src/runtime_schedule.ts#RuntimeScheduleManager.tools",
    "internal_runtime",
    ["schedule_change", "delete", "write"],
    ["tool:schedule.delete", "schedule:delete"],
    5_000,
  ),
  operationDescriptor(
    "llm.call",
    "packages/blue-tanuki/src/executor.ts#executeLLMCall",
    "external_api",
    ["external_send"],
    [],
    30_000,
    ["draft.in_memory", "proofread.in_memory", "summarize.in_memory", "translate.in_memory", "reminder.draft"],
  ),
  operationDescriptor(
    "channel.send",
    "packages/blue-tanuki/src/executor.ts#executeChannelSend",
    "external_api",
    ["external_send"],
    ["channel:send"],
    30_000,
    ["daily_brief.channel_send"],
  ),
  operationDescriptor(
    "cron.process",
    "packages/operator-daily/src/daily_brief_integration.ts#dailyBriefSnapshotFromEnv",
    "internal_runtime",
    ["read"],
    [],
    5_000,
    ["daily_brief.status"],
  ),
]);

export const OPERATOR_SURFACE_OPERATION_IDS = Object.freeze({
  daily: Object.freeze([
    "daily_brief.status",
    "google.gmail.read",
    "google.calendar.read",
    "google.drive.read",
    "schedule.list",
    "reminder.draft",
    "schedule.create",
    "schedule.update",
    "schedule.delete",
    "gmail.write",
    "google.calendar.write",
    "google.drive.write",
    "daily_brief.channel_send",
  ] as const),
  developer: Object.freeze([
    "file.read",
    "github.read",
    "file.write",
    "file.edit",
    "browser.snapshot",
    "github.write",
    "browser.automation",
    "shell.exec",
  ] as const),
  writing: Object.freeze([
    "draft.in_memory",
    "proofread.in_memory",
    "summarize.in_memory",
    "translate.in_memory",
    "file.read",
    "file.write",
    "file.edit",
    "gmail.write",
    "google.drive.write",
  ] as const),
});

export type OperatorSurfaceName = keyof typeof OPERATOR_SURFACE_OPERATION_IDS;

const descriptorByName = new Map<string, OperationDescriptor>();
for (const descriptor of OPERATION_DESCRIPTOR_REGISTRY) {
  const names = [
    descriptor.operation_id,
    ...descriptor.aliases,
    ...(descriptor.tool_name ? ["tool." + descriptor.tool_name] : []),
  ];
  for (const name of names) {
    const registered = descriptorByName.get(name);
    if (registered && registered !== descriptor) {
      throw new Error("operation descriptor alias is ambiguous: " + name);
    }
    descriptorByName.set(name, descriptor);
  }
}

export function getOperationDescriptor(operation: string): OperationDescriptor | undefined {
  return descriptorByName.get(operation);
}

export function getToolOperationDescriptor(toolName: string): OperationDescriptor | undefined {
  const descriptor = getOperationDescriptor(toolName);
  return descriptor?.tool_name === toolName ? descriptor : undefined;
}

export function requireOperationDescriptor(operation: string): OperationDescriptor {
  const descriptor = getOperationDescriptor(operation);
  if (!descriptor) throw new Error("operation descriptor is not registered: " + operation);
  return descriptor;
}

export function requireToolOperationDescriptor(toolName: string): OperationDescriptor {
  const descriptor = getToolOperationDescriptor(toolName);
  if (!descriptor) throw new Error("tool operation descriptor is not registered: " + toolName);
  return descriptor;
}

export function requiredCapabilitiesForSurface(surface: OperatorSurfaceName): readonly string[] {
  const capabilities = new Set<string>();
  for (const operation of OPERATOR_SURFACE_OPERATION_IDS[surface]) {
    for (const capability of requireOperationDescriptor(operation).required_capabilities) {
      capabilities.add(capability);
    }
  }
  return Object.freeze([...capabilities].sort());
}
