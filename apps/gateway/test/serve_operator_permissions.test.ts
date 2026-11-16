import { describe, expect, it } from "vitest";
import { requiredCapabilitiesForSurface } from "@blue-tanuki/protocol";
import { DEVELOPER_OPERATOR_REQUIRED_PERMISSIONS } from "../src/serve_operator_permissions.js";

describe("Gateway operator plugin permissions", () => {
  it("keeps core HDS settings writes out of the Developer plugin permission manifest", () => {
    expect(DEVELOPER_OPERATOR_REQUIRED_PERMISSIONS).toEqual(
      requiredCapabilitiesForSurface("developer").filter((permission) =>
        permission !== "settings:write" && permission !== "tool:settings.write"),
    );
    expect(DEVELOPER_OPERATOR_REQUIRED_PERMISSIONS).not.toContain("settings:write");
    expect(DEVELOPER_OPERATOR_REQUIRED_PERMISSIONS).not.toContain("tool:settings.write");
    expect(DEVELOPER_OPERATOR_REQUIRED_PERMISSIONS).toContain("tool:github.write");
  });
});
