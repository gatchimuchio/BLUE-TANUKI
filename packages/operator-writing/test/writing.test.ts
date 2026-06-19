import { describe, expect, it } from "vitest";
import { OperationCoreProjectionSchema } from "@blue-tanuki/protocol";
import {
  WRITING_OPERATOR_REQUIRED_PERMISSIONS,
  buildWritingInvocation,
  getWritingOperationSpec,
  getWritingSurfaceSnapshot,
  writingMetadataForOperation,
} from "../src/index.js";

describe("Writing Operator surface", () => {
  it("declares itself as a Layer A downstream surface, not an authority source", () => {
    const snapshot = getWritingSurfaceSnapshot();
    expect(snapshot.surface).toBe("writing");
    expect(snapshot.layer).toBe("A");
    expect(snapshot.authority).toBe("hds_brain_downstream_device");
    expect(snapshot.replaces_authority).toBe(false);
    expect(snapshot.raw_authority_added).toBe(false);
  });

  it("keeps L1, L2, and L3 operation boundaries explicit", () => {
    expect(getWritingOperationSpec("draft.in_memory").approval_level).toBe("L1_observe");
    expect(getWritingOperationSpec("file.write").approval_level).toBe("L2_operate");
    expect(getWritingOperationSpec("gmail.write").approval_level).toBe("L3_final_review");
    expect(getWritingOperationSpec("google.drive.write").final_review_required).toBe(true);
  });

  it("projects writing operations into display-only Operation Core steps", () => {
    const projection = getWritingSurfaceSnapshot().operation_core_projection;
    const editStep = projection.steps.find((step) => step.operation === "file.edit");
    const gmailStep = projection.steps.find((step) => step.operation === "gmail.write");

    expect(OperationCoreProjectionSchema.safeParse(projection).success).toBe(true);
    expect(projection.source_surface).toBe("writing");
    expect(projection.ui_projection_used_for_authority).toBe(false);
    expect(projection.planner_output_used_for_authority).toBe(false);
    expect(projection.raw_command_policy.raw_command_is_core_operation).toBe(false);
    expect(editStep).toMatchObject({
      target: { kind: "file", scope: "operator:writing" },
      effects: ["write"],
      permission: {
        risk: "medium",
        approval_level: "L2_operate",
        approval_gate_required: false,
      },
      adapter: "internal_runtime",
      adapter_is_authority: false,
      command_generated_by_adapter_only: false,
    });
    expect(gmailStep).toMatchObject({
      effects: ["external_send"],
      permission: {
        risk: "high",
        approval_level: "L3_final_review",
        final_review_required: true,
        approval_gate_required: true,
      },
      adapter: "external_api",
      adapter_is_authority: false,
    });
  });

  it("uses only existing downstream capability names", () => {
    expect(WRITING_OPERATOR_REQUIRED_PERMISSIONS).toContain("tool:file.search");
    expect(WRITING_OPERATOR_REQUIRED_PERMISSIONS).toContain("tool:gmail.write");
    expect(WRITING_OPERATOR_REQUIRED_PERMISSIONS).not.toContain("authority:write");
    expect(WRITING_OPERATOR_REQUIRED_PERMISSIONS).not.toContain("hds:bypass");
  });

  it("builds digest-only invocation traces", () => {
    const invocation = buildWritingInvocation({
      operation: "proofread.in_memory",
      content: "hello",
      source: "provided_text",
    });
    expect(invocation.input_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(invocation).not.toHaveProperty("content");
  });

  it("emits structured operation metadata for gateway-owned requests", () => {
    expect(writingMetadataForOperation("file.edit")).toEqual({
      "blue_tanuki.operator_surface": "writing",
      "blue_tanuki.writing.operation": "file.edit",
      "blue_tanuki.approval_level": "L2_operate",
      "blue_tanuki.approval_risk": "medium",
      "blue_tanuki.final_review_required": "false",
    });
  });
});
