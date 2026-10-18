import { requireToolOperationDescriptor } from "@blue-tanuki/protocol";
import type { Tool, ToolContext } from "@blue-tanuki/core";
import {
  factoryResetRecovery,
  resetRecoveryConnector,
  resetRecoveryProvider,
  restoreRecoveryBackup,
  type RecoveryActionResult,
} from "./recovery_surface.js";
import { CANONICAL_STATE_STORE_PATHS, type CanonicalStateStoreKey } from "./canonical_state_backup.js";
import type { GatewayExecutionIntentStore } from "./execution_intent_store.js";

export const RECOVERY_TOOL_NAMES = [
  "recovery.restore",
  "recovery.reset_provider",
  "recovery.reset_connector",
  "recovery.factory_reset",
] as const;

export type RecoveryToolName = (typeof RECOVERY_TOOL_NAMES)[number];

const CANONICAL_STORE_RESTORE_CONSUMERS: Record<CanonicalStateStoreKey, readonly string[]> = {
  j_control: ["hds_control_store"],
  m_state: ["hds_memory_store"],
  broker: [],
  operation_plans: [],
  cron_events: [],
};

/**
 * J/M still lack a live quiesce boundary. Cron restore has a serve-owned
 * scheduler pause and store reopen path; Broker preserves its active restore
 * receipt inside the Broker-owned snapshot transaction. Operation Plans retain
 * their dedicated in-process HDS refresh path.
 */
export function canonicalStoreRestoreConsumersNotQuiesced(storeKey: unknown): readonly string[] {
  if (typeof storeKey !== "string" || !Object.hasOwn(CANONICAL_STORE_RESTORE_CONSUMERS, storeKey)) return [];
  return CANONICAL_STORE_RESTORE_CONSUMERS[storeKey as CanonicalStateStoreKey];
}

const CONFIRMATION: Record<RecoveryToolName, string> = {
  "recovery.restore": "RESTORE",
  "recovery.reset_provider": "RESET_PROVIDER",
  "recovery.reset_connector": "RESET_CONNECTOR",
  "recovery.factory_reset": "FACTORY_RESET",
};

export function normalizeRecoveryMutationArguments(
  toolName: RecoveryToolName,
  raw: unknown,
  options: { readonly latestBackupId?: string | null } = {},
): Record<string, string> {
  if (!isRecord(raw)) throw new Error("invalid_recovery_request");
  const allowedKeys = toolName === "recovery.restore"
    ? ["backup_id", "store_key", "scope_kind", "scope_digest", "confirm"]
    : ["confirm"];
  if (Object.keys(raw).some((key) => !allowedKeys.includes(key))) {
    throw new Error("invalid_recovery_request");
  }
  if (raw.confirm !== CONFIRMATION[toolName]) throw new Error("recovery_confirmation_required");
  if (toolName !== "recovery.restore") return { confirm: CONFIRMATION[toolName] };

  const storeKey = raw.store_key;
  if (storeKey !== undefined &&
      (typeof storeKey !== "string" || !CANONICAL_STATE_STORE_PATHS.some((store) => store.key === storeKey))) {
    throw new Error("invalid_store_key");
  }
  const scopeKind = raw.scope_kind;
  const scopeDigest = raw.scope_digest;
  if (storeKey === "operation_plans") {
    if (scopeKind !== "operation_plan") throw new Error("operation_plan_scope_required");
    if (typeof scopeDigest !== "string" || !/^[a-f0-9]{64}$/i.test(scopeDigest)) {
      throw new Error("operation_plan_scope_invalid");
    }
  } else if (scopeKind !== undefined || scopeDigest !== undefined) {
    throw new Error("invalid_recovery_request");
  }

  const requestedId = raw.backup_id;
  if (requestedId !== undefined && typeof requestedId !== "string") {
    throw new Error("invalid_backup_id");
  }
  const backupId = requestedId === undefined || requestedId === "latest"
    ? options.latestBackupId
    : requestedId;
  if (typeof backupId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(backupId) || backupId === "latest") {
    throw new Error(backupId ? "invalid_backup_id" : "backup_not_found");
  }
  return {
    backup_id: backupId,
    ...(typeof storeKey === "string" ? { store_key: storeKey } : {}),
    ...(scopeKind === "operation_plan" && typeof scopeDigest === "string"
      ? { scope_kind: "operation_plan", scope_digest: scopeDigest.toLowerCase() }
      : {}),
    confirm: CONFIRMATION[toolName],
  };
}

export function createRecoveryMutationTools(
  env: NodeJS.ProcessEnv = process.env,
  getBrokerStore?: () => GatewayExecutionIntentStore | undefined,
  options: { readonly cronEventsStoreQuiesced?: () => boolean } = {},
): readonly Tool[] {
  const restoreRecoveryTool: Tool = {
    name: "recovery.restore",
    description: "Restore one explicitly selected local recovery backup after HDS L3 owner final review.",
    required_capabilities: requireToolOperationDescriptor("recovery.restore").required_capabilities,
    async invoke(raw, ctx?: ToolContext) {
      const args = normalizeRecoveryMutationArguments("recovery.restore", raw);
      if (canonicalStoreRestoreConsumersNotQuiesced(args.store_key).length > 0) {
        throw new Error("canonical_state_restore_consumers_not_quiesced");
      }
      if (args.store_key === "cron_events" && options.cronEventsStoreQuiesced?.() !== true) {
        throw new Error("canonical_state_restore_consumers_not_quiesced");
      }
      if (args.store_key === "broker" && !/^[a-f0-9]{64}$/.test(ctx?.idempotency_key ?? "")) {
        throw new Error("broker_restore_execution_context_missing");
      }
      const brokerStore = args.store_key === "broker" ? getBrokerStore?.() : undefined;
      if (args.store_key === "broker" && !brokerStore) {
        throw new Error("broker_restore_execution_store_unavailable");
      }
      const result = await invokeRecoverySafely(() => restoreRecoveryBackup(env, {
        backup_id: args.backup_id,
        ...(args.store_key ? { store_key: args.store_key as CanonicalStateStoreKey } : {}),
        ...(args.scope_kind === "operation_plan" && args.scope_digest
          ? { scope_kind: "operation_plan" as const, scope_digest: args.scope_digest }
          : {}),
        ...(args.store_key === "broker" && ctx?.idempotency_key
          ? { executor_command_key: ctx.idempotency_key }
          : {}),
        ...(brokerStore ? { broker_execution_store: brokerStore } : {}),
        confirm: args.confirm,
      }));
      return operatorSafeRecoveryResult(result);
    },
  };
  const resetRecoveryProviderTool: Tool = {
    name: "recovery.reset_provider",
    description: "Reset the configured LLM provider to the offline stub after HDS L3 owner final review.",
    required_capabilities: requireToolOperationDescriptor("recovery.reset_provider").required_capabilities,
    async invoke(raw) {
      const args = normalizeRecoveryMutationArguments("recovery.reset_provider", raw);
      return operatorSafeRecoveryResult(await invokeRecoverySafely(() => resetRecoveryProvider(env, { confirm: args.confirm })));
    },
  };
  const resetRecoveryConnectorTool: Tool = {
    name: "recovery.reset_connector",
    description: "Reset connector configuration to dry-run after HDS L3 owner final review.",
    required_capabilities: requireToolOperationDescriptor("recovery.reset_connector").required_capabilities,
    async invoke(raw) {
      const args = normalizeRecoveryMutationArguments("recovery.reset_connector", raw);
      return operatorSafeRecoveryResult(await invokeRecoverySafely(() => resetRecoveryConnector(env, { confirm: args.confirm })));
    },
  };
  const factoryResetRecoveryTool: Tool = {
    name: "recovery.factory_reset",
    description: "Reset local runtime state while preserving audit and recovery roots after HDS L3 owner final review.",
    required_capabilities: requireToolOperationDescriptor("recovery.factory_reset").required_capabilities,
    async invoke(raw) {
      const args = normalizeRecoveryMutationArguments("recovery.factory_reset", raw);
      return operatorSafeRecoveryResult(await invokeRecoverySafely(() => factoryResetRecovery(env, { confirm: args.confirm })));
    },
  };
  return [restoreRecoveryTool, resetRecoveryProviderTool, resetRecoveryConnectorTool, factoryResetRecoveryTool];
}

async function invokeRecoverySafely<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new Error(/^[a-z][a-z0-9_]{0,80}$/.test(message) ? message : "recovery_mutation_failed");
  }
}

function operatorSafeRecoveryResult(result: RecoveryActionResult): Record<string, unknown> {
  return {
    schema_version: result.schema_version,
    surface: result.surface,
    action: result.action,
    status: result.status,
    ...(result.backup_id ? { backup_id: result.backup_id } : {}),
    ...(result.restored_backup_id ? { restored_backup_id: result.restored_backup_id } : {}),
    ...(result.restored_store_key ? { restored_store_key: result.restored_store_key } : {}),
    ...(result.restored_store_archive_digest ? { restored_store_archive_digest: result.restored_store_archive_digest } : {}),
    ...(result.restored_store_state_digest ? { restored_store_state_digest: result.restored_store_state_digest } : {}),
    ...(result.restore_scope_kind ? { restore_scope_kind: result.restore_scope_kind } : {}),
    ...(result.restore_scope_digest ? { restore_scope_digest: result.restore_scope_digest } : {}),
    ...(result.canonical_state_cross_store_atomic !== undefined
      ? { canonical_state_cross_store_atomic: result.canonical_state_cross_store_atomic }
      : {}),
    ...(result.restored_items_count !== undefined ? { restored_items_count: result.restored_items_count } : {}),
    ...(result.removed_paths_count !== undefined ? { removed_paths_count: result.removed_paths_count } : {}),
    ...(result.reset_keys ? { reset_keys: result.reset_keys } : {}),
    ...(result.pre_action_backup_id ? { pre_action_backup_id: result.pre_action_backup_id } : {}),
    authority_boundary: result.authority_boundary,
    secret_material: true,
    used_for_authority: false,
    hds_brain_remains_authority: true,
    evidence_source: result.evidence_source,
    next_safe_action: result.next_safe_action,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
