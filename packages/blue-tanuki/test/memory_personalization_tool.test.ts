import { describe, expect, it } from "vitest";
import { approvalContextFromCommand, finalReviewRequired, operationPlanDigest } from "@blue-tanuki/hds-brain";
import { requireToolOperationDescriptor, type MemoryPersonalizationTargetVersionObservation } from "@blue-tanuki/protocol";
import { createMemoryPersonalizationStopTool, isMemoryPersonalizationStopTool } from "../src/tools/memory_personalization.js";

describe("memory.personalization.stop tool", () => {
  it("binds a digest-only review to one exact M record and runs only after target recheck", async () => {
    const entryHash = "a".repeat(64);
    const exclusionRevision = "b".repeat(64);
    let status: "available" | "already_excluded" = "available";
    let stoppedInput: Record<string, unknown> | undefined;
    const store = {
      inspectPersonalizationTarget(request_id: string, entry_hash: string) {
        expect(request_id).toBe("memory-17");
        expect(entry_hash).toBe(entryHash);
        return { status, entry_hash: status === "available" ? entry_hash : null,
          exclusion_revision_digest: exclusionRevision };
      },
      stopPersonalizationUse(input: Record<string, unknown>) {
        stoppedInput = input;
        status = "already_excluded";
        return { status: "excluded" as const, entry_hash: entryHash, exclusion_digest: "c".repeat(64),
          exclusion_revision_digest: "d".repeat(64), historical_record_retained: true as const,
          physical_deletion: false as const, used_for_authority: false as const, may_execute: false as const };
      },
    };
    const tool = createMemoryPersonalizationStopTool(store);
    expect(isMemoryPersonalizationStopTool(tool)).toBe(true);
    const args = { reference: "F:memory-17", entry_hash: entryHash };
    const commandDigest = "e".repeat(64);
    const planBinding = "f".repeat(64);
    const observation = await tool.inspect_target_version!(args, {
      command_digest: commandDigest, operation_plan_binding_digest: planBinding,
    }) as MemoryPersonalizationTargetVersionObservation;
    const review = await tool.inspect_content_review!(args, {
      command_digest: commandDigest, operation_plan_binding_digest: planBinding,
    });
    expect(review).toMatchObject({ kind: "memory_personalization_stop", reference: args.reference,
      entry_hash: entryHash, exclusion_revision_digest: exclusionRevision,
      target_version_digest: operationPlanDigest(observation), historical_record_retained: true,
      physical_deletion: false, used_for_authority: false, may_execute: false });
    expect(JSON.stringify(review)).not.toContain("memory body");

    const command = { id: "stop-memory-17", type: "tool_call" as const,
      payload: { tool_name: tool.name, arguments: args },
      constraints: { allowed_capabilities: [...requireToolOperationDescriptor(tool.name).required_capabilities] },
      upstream_decision: { request_id: "request-17", commit_hash: "1".repeat(64), commit_decision: "ASSERT" as const } };
    const approvalContext = approvalContextFromCommand(command, { actor: "fixture-owner" });
    expect(approvalContext.operation).toBe("settings.write");
    expect(approvalContext.risk).toBe("high");
    expect(finalReviewRequired(approvalContext)).toBe(true);

    const result = await tool.invoke(args, { command_id: command.id, upstream_commit_hash: "1".repeat(64),
      command_digest: "2".repeat(64), target_version_observation: observation });
    expect(result).toMatchObject({ status: "excluded", entry_hash: entryHash,
      historical_record_retained: true, physical_deletion: false, used_for_authority: false, may_execute: false });
    expect(stoppedInput).toMatchObject({ request_id: "memory-17", expected_entry_hash: entryHash,
      expected_exclusion_revision_digest: exclusionRevision, command_digest: "2".repeat(64),
      operation_plan_binding_digest: planBinding });
  });

  it("rejects a changed target, missing plan binding, and unknown input keys", async () => {
    const entryHash = "a".repeat(64);
    const revision = "b".repeat(64);
    const tool = createMemoryPersonalizationStopTool({
      inspectPersonalizationTarget: () => ({ status: "available", entry_hash: entryHash,
        exclusion_revision_digest: revision }),
      stopPersonalizationUse: () => { throw new Error("must not mutate"); },
    });
    await expect(tool.inspect_target_version!({ reference: "F:memory-17", entry_hash: entryHash, extra: "x" }, {
      command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64),
    })).rejects.toThrow(/arguments_invalid/);
    await expect(tool.inspect_target_version!({ reference: "F:memory-17", entry_hash: entryHash }, {
      command_digest: "c".repeat(64),
    })).rejects.toThrow(/operation_plan_digest_required/);
    const observation = await tool.inspect_target_version!({ reference: "F:memory-17", entry_hash: entryHash }, {
      command_digest: "c".repeat(64), operation_plan_binding_digest: "d".repeat(64),
    }) as MemoryPersonalizationTargetVersionObservation;
    await expect(tool.invoke({ reference: "F:other", entry_hash: entryHash }, {
      command_id: "mismatch", upstream_commit_hash: "1".repeat(64), command_digest: "e".repeat(64),
      target_version_observation: observation,
    })).rejects.toThrow(/approved_target_mismatch/);
  });
});
