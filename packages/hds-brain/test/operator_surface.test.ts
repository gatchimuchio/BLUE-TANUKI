import { describe, expect, it } from "vitest";
import { createGatewayInternalInboundRequest } from "@blue-tanuki/protocol";
import { frame } from "../src/frame.js";
import { DEFAULT_POLICY } from "../src/policy.js";

describe("operator surface framing", () => {
  it("recognizes Writing Operator by content prefix without changing process authority", () => {
    const result = frame(
      {
        id: "req-1",
        channel: "webchat",
        user: "alice",
        content: "writing: draft a release note",
        timestamp: 1,
      },
      { default_policy: DEFAULT_POLICY },
    );

    expect(result.operator_surface).toEqual({
      id: "writing",
      layer: "A",
      source: "content_prefix",
      authority: "downstream_device_only",
    });
    expect(result.process.process_kind).toBe("chat");
    expect(result.world_closure.x).toContain("surface:writing");
    expect(result.world_closure.r).toContain("operator_surface_binding");
  });

  it("accepts gateway-owned Writing metadata but ignores untrusted surface metadata", () => {
    const untrusted = frame(
      {
        id: "req-2",
        channel: "slack",
        user: "external-user",
        content: "draft this",
        timestamp: 1,
        metadata: { "blue_tanuki.operator_surface": "writing" },
      },
      { default_policy: DEFAULT_POLICY },
    );
    expect(untrusted.operator_surface).toBeUndefined();
    expect(untrusted.operation_core).toBeUndefined();

    const trusted = frame(
      createGatewayInternalInboundRequest({
        id: "req-3",
        channel: "webchat",
        user: "alice",
        content: "draft this",
        timestamp: 1,
        metadata: {
          "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.operator_surface": "writing",
          "blue_tanuki.operation_core.version": "operation-core.v1",
          "blue_tanuki.operation_core.request_id": "operation-request:req-3",
          "blue_tanuki.operation_core.projection_id": "operator:writing:operation-core",
          "blue_tanuki.operation_core.source_interface": "gui",
          "blue_tanuki.operation_core.used_for_authority": false,
          "blue_tanuki.operation_core.planner_output_used_for_authority": false,
          "blue_tanuki.operation_core.ui_projection_used_for_authority": false,
        },
      }),
      { default_policy: DEFAULT_POLICY },
    );
    expect(trusted.operator_surface?.source).toBe("gateway_internal_metadata");
    expect(trusted.operation_core).toMatchObject({
      source: "gateway_internal_metadata",
      projection_id: "operator:writing:operation-core",
      used_for_authority: false,
      planner_output_used_for_authority: false,
      ui_projection_used_for_authority: false,
      request: {
        version: "operation-core.v1",
        request_id: "operation-request:req-3",
        source_interface: "gui",
        actor: "alice",
        goal: "draft this",
        target: {
          kind: "runtime",
          id: "operator:writing",
          scope: "operator_surface",
        },
        constraints: {
          hds_brain_authority_required: true,
          disallow_raw_command_as_authority: true,
        },
        used_for_authority: false,
      },
    });
    expect(trusted.world_closure.x).toContain("operation_core:operation-request:req-3");
    expect(trusted.world_closure.r).toContain("operation_core_request_binding");
  });

  it("ignores malformed internal Operation Core metadata without changing the HDS process", () => {
    const result = frame(
      createGatewayInternalInboundRequest({
        id: "req-3b",
        channel: "webchat",
        user: "alice",
        content: "draft this",
        timestamp: 1,
        metadata: {
          "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.operator_surface": "writing",
          "blue_tanuki.operation_core.version": "operation-core.v1",
          "blue_tanuki.operation_core.request_id": "x".repeat(201),
          "blue_tanuki.operation_core.source_interface": "gui",
          "blue_tanuki.operation_core.used_for_authority": false,
          "blue_tanuki.operation_core.planner_output_used_for_authority": false,
          "blue_tanuki.operation_core.ui_projection_used_for_authority": false,
        },
      }),
      { default_policy: DEFAULT_POLICY },
    );

    expect(result.operator_surface?.id).toBe("writing");
    expect(result.process.process_kind).toBe("chat");
    expect(result.operation_core).toBeUndefined();
    expect(result.world_closure.x).not.toContain(`operation_core:${"x".repeat(201)}`);
  });

  it("recognizes Daily Operator without changing process authority", () => {
    const prefixed = frame(
      {
        id: "req-4",
        channel: "webchat",
        user: "alice",
        content: "daily: show my brief status",
        timestamp: 1,
      },
      { default_policy: DEFAULT_POLICY },
    );
    expect(prefixed.operator_surface?.id).toBe("daily");
    expect(prefixed.process.process_kind).toBe("chat");

    const trusted = frame(
      createGatewayInternalInboundRequest({
        id: "req-5",
        channel: "webchat",
        user: "alice",
        content: "show daily",
        timestamp: 1,
        metadata: {
          "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.operator_surface": "daily",
        },
      }),
      { default_policy: DEFAULT_POLICY },
    );
    expect(trusted.operator_surface).toEqual({
      id: "daily",
      layer: "A",
      source: "gateway_internal_metadata",
      authority: "downstream_device_only",
    });
  });

  it("recognizes Developer Operator without changing process authority", () => {
    const prefixed = frame(
      {
        id: "req-6",
        channel: "webchat",
        user: "alice",
        content: "developer: inspect the failing test",
        timestamp: 1,
      },
      { default_policy: DEFAULT_POLICY },
    );
    expect(prefixed.operator_surface?.id).toBe("developer");
    expect(prefixed.process.process_kind).toBe("chat");
    expect(prefixed.world_closure.x).toContain("surface:developer");

    const trusted = frame(
      createGatewayInternalInboundRequest({
        id: "req-7",
        channel: "webchat",
        user: "alice",
        content: "inspect the repo",
        timestamp: 1,
        metadata: {
          "blue_tanuki.authority_context": "gateway_internal_v1",
          "blue_tanuki.operator_surface": "developer",
        },
      }),
      { default_policy: DEFAULT_POLICY },
    );
    expect(trusted.operator_surface).toEqual({
      id: "developer",
      layer: "A",
      source: "gateway_internal_metadata",
      authority: "downstream_device_only",
    });
  });
});
