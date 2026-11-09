import { operationPlanDigest } from "@blue-tanuki/hds-brain";
import {
  MemoryPersonalizationTargetVersionObservationSchema,
  memoryPersonalizationTargetIdentityDigest,
  requireToolOperationDescriptor,
  type MemoryPersonalizationTargetVersionObservation,
} from "@blue-tanuki/protocol";
import type { Tool, ToolContentReview } from "./registry.js";

interface MemoryPersonalizationStorePort {
  inspectPersonalizationTarget(request_id: string, entry_hash: string): {
    status: "available" | "already_excluded" | "unavailable";
    entry_hash: string | null;
    exclusion_revision_digest: string;
  };
  stopPersonalizationUse(input: {
    request_id: string;
    expected_entry_hash: string;
    expected_exclusion_revision_digest: string;
    command_digest: string;
    operation_plan_binding_digest: string;
    timestamp_ms: number;
  }): {
    status: "excluded" | "already_excluded";
    entry_hash: string;
    exclusion_digest: string;
    exclusion_revision_digest: string;
    historical_record_retained: true;
    physical_deletion: false;
    used_for_authority: false;
    may_execute: false;
  };
}

const BUILTIN_MEMORY_PERSONALIZATION_TOOLS = new WeakSet<Tool>();

/** Create the only registered adapter allowed to append a future-personalization exclusion. */
export function createMemoryPersonalizationStopTool(store: MemoryPersonalizationStorePort): Tool {
  const tool: Tool = {
    name: "memory.personalization.stop",
    description: "Stop future memory citation and personalization use of one exact retained memory record.",
    required_capabilities: requireToolOperationDescriptor("memory.personalization.stop").required_capabilities,
    async inspect_target_version(rawArgs, options = {}): Promise<MemoryPersonalizationTargetVersionObservation> {
      const args = parseArgs(rawArgs);
      const commandDigest = requireDigest(options.command_digest, "command");
      const planDigest = requireDigest(options.operation_plan_binding_digest, "operation plan");
      const target = store.inspectPersonalizationTarget(requestId(args.reference), args.entry_hash);
      if (target.status !== "available" || target.entry_hash !== args.entry_hash ||
          !/^[a-f0-9]{64}$/.test(target.exclusion_revision_digest)) {
        throw new Error("memory_personalization_target_unavailable_or_already_excluded");
      }
      return MemoryPersonalizationTargetVersionObservationSchema.parse({
        schema_version: "blue-tanuki.memory-personalization-target-version.v1",
        target_identity_digest: memoryPersonalizationTargetIdentityDigest(args.reference, args.entry_hash),
        entry_hash: args.entry_hash,
        exclusion_revision_digest: target.exclusion_revision_digest,
        command_digest: commandDigest,
        operation_plan_binding_digest: planDigest,
        target_state: "available",
        used_for_authority: false,
        may_execute: false,
      });
    },
    async inspect_content_review(rawArgs, options = {}): Promise<ToolContentReview> {
      const args = parseArgs(rawArgs);
      const observation = MemoryPersonalizationTargetVersionObservationSchema.parse(
        await tool.inspect_target_version!(rawArgs, options),
      );
      const commandDigest = requireDigest(options.command_digest, "command");
      const planDigest = requireDigest(options.operation_plan_binding_digest, "operation plan");
      const reviewBase = {
        kind: "memory_personalization_stop" as const,
        operation: "memory.personalization.stop" as const,
        reference: args.reference,
        entry_hash: args.entry_hash,
        exclusion_revision_digest: observation.exclusion_revision_digest,
        request_payload_digest: requestPayloadDigest(args.reference, args.entry_hash),
        target_version_digest: operationPlanDigest(observation),
        operation_plan_binding_digest: planDigest,
        command_digest: commandDigest,
        historical_record_retained: true as const,
        physical_deletion: false as const,
        used_for_authority: false as const,
        may_execute: false as const,
      };
      return { ...reviewBase, review_digest: operationPlanDigest(reviewBase) };
    },
    async invoke(rawArgs, context): Promise<unknown> {
      const args = parseArgs(rawArgs);
      const commandDigest = requireDigest(context.command_digest, "approved command");
      const observation = MemoryPersonalizationTargetVersionObservationSchema.parse(context.target_version_observation);
      if (observation.target_identity_digest !== memoryPersonalizationTargetIdentityDigest(args.reference, args.entry_hash) ||
          observation.entry_hash !== args.entry_hash || observation.command_digest === "" ||
          context.upstream_commit_hash.length === 0) {
        throw new Error("memory_personalization_approved_target_mismatch");
      }
      const current = store.inspectPersonalizationTarget(requestId(args.reference), args.entry_hash);
      if (current.status !== "available" || current.entry_hash !== args.entry_hash ||
          current.exclusion_revision_digest !== observation.exclusion_revision_digest) {
        throw new Error("memory_personalization_target_changed_before_invoke");
      }
      return store.stopPersonalizationUse({
        request_id: requestId(args.reference),
        expected_entry_hash: args.entry_hash,
        expected_exclusion_revision_digest: observation.exclusion_revision_digest,
        command_digest: commandDigest,
        operation_plan_binding_digest: observation.operation_plan_binding_digest,
        timestamp_ms: Date.now(),
      });
    },
  };
  BUILTIN_MEMORY_PERSONALIZATION_TOOLS.add(tool);
  return tool;
}

export function isMemoryPersonalizationStopTool(tool: Tool | undefined): boolean {
  return !!tool && BUILTIN_MEMORY_PERSONALIZATION_TOOLS.has(tool);
}

function parseArgs(value: Record<string, unknown>): { reference: string; entry_hash: string } {
  if (Object.keys(value).sort().join(",") !== "entry_hash,reference" || typeof value.reference !== "string" ||
      !/^F:[A-Za-z0-9_.:-]{1,96}$/.test(value.reference) || typeof value.entry_hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.entry_hash)) {
    throw new Error("memory_personalization_arguments_invalid");
  }
  return { reference: value.reference, entry_hash: value.entry_hash };
}

function requestId(reference: string): string {
  return reference.slice(2);
}

function requestPayloadDigest(reference: string, entryHash: string): string {
  return operationPlanDigest({ schema_version: "blue-tanuki.memory-personalization-request.v1", reference, entry_hash: entryHash });
}

function requireDigest(value: string | undefined, field: string): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`memory_personalization_${field.replaceAll(" ", "_")}_digest_required`);
  return value;
}
