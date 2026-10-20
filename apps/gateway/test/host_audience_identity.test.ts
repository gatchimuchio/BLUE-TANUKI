import { describe, expect, it } from "vitest";
import { deriveHostAudienceDigest } from "../src/host_audience_identity.js";

describe("Gateway host audience identity", () => {
  it("hashes stable OS identifiers into a platform-scoped digest", () => {
    const windows = deriveHostAudienceDigest("win32", "8f14e45f-ea6e-4f4a-a8a2-78a5d4f3d590");
    expect(windows).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveHostAudienceDigest("win32", "{8F14E45F-EA6E-4F4A-A8A2-78A5D4F3D590}")).toBe(windows);
    expect(deriveHostAudienceDigest("linux", "8f14e45fea6e4f4aa8a278a5d4f3d590")).not.toBe(windows);
    expect(windows).not.toContain("8f14e45f-ea6e-4f4a-a8a2-78a5d4f3d590");
  });

  it("fails closed for missing, malformed, or unsupported host identities", () => {
    expect(() => deriveHostAudienceDigest("linux", "")).toThrow("gateway_host_audience_identity_unavailable");
    expect(() => deriveHostAudienceDigest("linux", "0".repeat(32))).toThrow("gateway_host_audience_identity_unavailable");
    expect(() => deriveHostAudienceDigest("win32", "not-a-machine-guid")).toThrow("gateway_host_audience_identity_unavailable");
    expect(() => deriveHostAudienceDigest("android", "8f14e45f-ea6e-4f4a-a8a2-78a5d4f3d590"))
      .toThrow("gateway_host_audience_identity_unavailable");
  });
});
