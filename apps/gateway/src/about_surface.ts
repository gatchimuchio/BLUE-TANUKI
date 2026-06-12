import * as fs from "node:fs/promises";
import * as path from "node:path";

interface PackageJson {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  private?: unknown;
}

interface OwnerDecision {
  decision?: unknown;
  version?: unknown;
  public_claim_authorized?: unknown;
}

export interface AboutSnapshot {
  schema_version: 1;
  product_name: "BLUE-TANUKI";
  package: {
    name: string;
    version: string;
    license: string;
    private: boolean;
  };
  release: {
    stage: "rc" | "ga" | "development";
    owner_go: "pending" | "go";
    public_claim_allowed: boolean;
    validate_ga_remains_required: true;
  };
  claim_boundary: {
    claim_file: "CLAIM.md";
    pre_go_boundary_declared: boolean;
    signed_native_installer: "not shipped" | "unknown";
    automatic_updater: "not shipped" | "unknown";
    hds_authority_claim_declared: boolean;
  };
  authority_boundary: {
    hds_brain_owns_authority: true;
    ui_used_for_authority: false;
    claim_metadata_used_for_authority: false;
    used_for_authority: false;
  };
  evidence_source: ["CONFIG"];
}

export async function buildAboutSnapshot(root = process.cwd()): Promise<AboutSnapshot> {
  const pkg = await readPackage(root);
  const claim = await readOptionalText(path.join(root, "CLAIM.md"));
  const ownerDecision = await readOwnerDecision(root);
  const ownerGo =
    ownerDecision?.decision === "GO" &&
    ownerDecision.version === "1.0.0" &&
    ownerDecision.public_claim_authorized === true;
  const version = stringOr(pkg.version, "unknown");
  const publicClaimAllowed = ownerGo && version === "1.0.0";

  return {
    schema_version: 1,
    product_name: "BLUE-TANUKI",
    package: {
      name: stringOr(pkg.name, "blue-tanuki-workspace"),
      version,
      license: stringOr(pkg.license, "unknown"),
      private: pkg.private === true,
    },
    release: {
      stage: publicClaimAllowed ? "ga" : version.includes("-rc.") ? "rc" : "development",
      owner_go: ownerGo ? "go" : "pending",
      public_claim_allowed: publicClaimAllowed,
      validate_ga_remains_required: true,
    },
    claim_boundary: {
      claim_file: "CLAIM.md",
      pre_go_boundary_declared: claim.includes("public_claim_allowed=false"),
      signed_native_installer: claim.includes("Signed native installer and automatic updater: not shipped")
        ? "not shipped"
        : "unknown",
      automatic_updater: claim.includes("Signed native installer and automatic updater: not shipped")
        ? "not shipped"
        : "unknown",
      hds_authority_claim_declared: claim.includes("HDS-BRAIN"),
    },
    authority_boundary: {
      hds_brain_owns_authority: true,
      ui_used_for_authority: false,
      claim_metadata_used_for_authority: false,
      used_for_authority: false,
    },
    evidence_source: ["CONFIG"],
  };
}

async function readPackage(root: string): Promise<PackageJson> {
  const raw = await fs.readFile(path.join(root, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as PackageJson : {};
}

async function readOwnerDecision(root: string): Promise<OwnerDecision | null> {
  const raw = await readOptionalText(path.join(root, "docs", "ga-owner-decision.json"));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as OwnerDecision : null;
}

async function readOptionalText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") return "";
    throw error;
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
