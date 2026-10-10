import { describe, expect, it } from "vitest";
import {
  getOperationDescriptor,
  getToolOperationDescriptor,
  OPERATION_DESCRIPTOR_REGISTRY,
  requiredCapabilitiesForSurface,
  requireOperationDescriptor,
} from "../src/index.js";

describe("BT-U-D01.01-P operation descriptor catalog", () => {
  it("maps every routed tool and surface alias to an immutable reviewed descriptor", () => {
    const routedTools = [
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
    ];

    expect(OPERATION_DESCRIPTOR_REGISTRY.filter((descriptor) => descriptor.tool_name).map((descriptor) => descriptor.tool_name).sort())
      .toEqual([...routedTools].sort());
    for (const toolName of routedTools) {
      const descriptor = getToolOperationDescriptor(toolName);
      expect(descriptor).toBeDefined();
      expect(descriptor!.required_capabilities).toContain(`tool:${toolName}`);
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor!.effects)).toBe(true);
      expect(Object.isFrozen(descriptor!.required_capabilities)).toBe(true);
    }

    expect(getOperationDescriptor("file.read")).toBe(getToolOperationDescriptor("file.search"));
    expect(getOperationDescriptor("google.gmail.read")).toBe(getToolOperationDescriptor("gmail.read"));
    expect(getOperationDescriptor("draft.in_memory")?.operation_id).toBe("llm.call");
    expect(getOperationDescriptor("daily_brief.channel_send")?.operation_id).toBe("channel.send");
    expect(() => requireOperationDescriptor("unreviewed.operation")).toThrow("operation descriptor is not registered");
  });

  it("keeps the complete mixed effects and runtime capabilities for known operations", () => {
    expect(getToolOperationDescriptor("file.edit")?.effects).toEqual(["read", "write"]);
    expect(getToolOperationDescriptor("gmail.read")?.effects).toEqual([
      "external_send",
      "read",
      "credential_access",
    ]);
    expect(getToolOperationDescriptor("schedule.delete")?.effects).toEqual([
      "schedule_change",
      "delete",
      "write",
    ]);
    expect(getToolOperationDescriptor("gmail.read")?.required_capabilities).toContain(
      "secrets:GOOGLE_ACCESS_TOKEN",
    );
  });

  it("derives operator permission envelopes from the shared operation catalog", () => {
    expect(requiredCapabilitiesForSurface("daily")).toContain("secrets:GOOGLE_ACCESS_TOKEN");
    expect(requiredCapabilitiesForSurface("developer")).toContain("tool:shell.exec");
    expect(requiredCapabilitiesForSurface("writing")).toContain("fs:read");
    expect(requiredCapabilitiesForSurface("writing")).toEqual(
      [...requiredCapabilitiesForSurface("writing")].sort(),
    );
  });
});
