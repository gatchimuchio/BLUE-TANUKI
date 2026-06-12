import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAboutSnapshot } from "../src/about_surface.js";

describe("buildAboutSnapshot", () => {
  it("reports pre-GO claim and authority boundaries from repository metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blue-tanuki-about-"));
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "blue-tanuki-workspace",
      version: "1.0.0-rc.1",
      license: "MIT",
      private: true,
    }));
    await writeFile(path.join(root, "CLAIM.md"), [
      "public_claim_allowed=false",
      "Signed native installer and automatic updater: not shipped",
      "HDS-BRAIN owns authority.",
    ].join("\n"));

    const snapshot = await buildAboutSnapshot(root);

    expect(snapshot).toMatchObject({
      schema_version: 1,
      product_name: "BLUE-TANUKI",
      package: {
        name: "blue-tanuki-workspace",
        version: "1.0.0-rc.1",
        license: "MIT",
        private: true,
      },
      release: {
        stage: "rc",
        owner_go: "pending",
        public_claim_allowed: false,
        validate_ga_remains_required: true,
      },
      claim_boundary: {
        pre_go_boundary_declared: true,
        signed_native_installer: "not shipped",
        automatic_updater: "not shipped",
        hds_authority_claim_declared: true,
      },
      authority_boundary: {
        hds_brain_owns_authority: true,
        ui_used_for_authority: false,
        claim_metadata_used_for_authority: false,
        used_for_authority: false,
      },
      evidence_source: ["CONFIG"],
    });
  });
});
