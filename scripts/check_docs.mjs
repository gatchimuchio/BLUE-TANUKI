import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const requiredDocs = [
  "docs/INDEX.md",
  "docs/FIRST_RUN_CHECKLIST.md",
  "docs/PERMANENT_USE_CHECKLIST.md",
  "docs/SUPPORT_BOUNDARY.md",
  "docs/KNOWN_LIMITATIONS.md",
  "docs/CHANNEL_READINESS_MATRIX.md",
  "docs/CHANNEL_PROMOTION_GATE.md",
  "docs/CREDENTIAL_READINESS_MATRIX.md",
  "docs/PLUGIN_REVIEW_GATE.md",
  "docs/UPDATE_ROLLBACK_RUNBOOK.md",
  "docs/phase8-s2a-operator-usability-docs.md",
  "docs/phase10-s3-distribution-ux-hardening.md",
  "docs/v1.0-security-and-permanent-use-review.md",
  "docs/v1.0-release-candidate.md",
  "docs/v1.0-post-rc-closure-review.md",
  "docs/v1.0-ga-promotion-review.md",
  "docs/phase11-s12-plugin-review-gate-implementation.md",
  "docs/phase11-s13-v1-ga-promotion-execution.md",
];

const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

for (const rel of requiredDocs) {
  if (!exists(rel)) {
    failures.push(`missing required doc: ${rel}`);
  }
}

const readme = read("README.md");
const quickstart = read("QUICKSTART.md");
const config = read("CONFIG.md");
const troubleshooting = read("TROUBLESHOOTING.md");

const currentReleaseDocs = [
  "README.md",
  "QUICKSTART.md",
  "CLAIM.md",
  "SECURITY.md",
  "AUDIT.md",
  "CONFIG.md",
  "TROUBLESHOOTING.md",
  "docs/FIRST_RUN_CHECKLIST.md",
  "docs/PERMANENT_USE_CHECKLIST.md",
  "docs/SUPPORT_BOUNDARY.md",
  "docs/KNOWN_LIMITATIONS.md",
  "docs/CHANNEL_READINESS_MATRIX.md",
  "docs/CHANNEL_PROMOTION_GATE.md",
  "docs/CREDENTIAL_READINESS_MATRIX.md",
  "docs/PLUGIN_REVIEW_GATE.md",
  "docs/UPDATE_ROLLBACK_RUNBOOK.md",
  "docs/INDEX.md",
  "docs/v1.0-release-candidate.md",
  "docs/v1.0-post-rc-closure-review.md",
  "docs/v1.0-ga-promotion-review.md",
  "docs/v1.0-security-and-permanent-use-review.md",
];

for (const rel of [
  "docs/FIRST_RUN_CHECKLIST.md",
  "docs/PERMANENT_USE_CHECKLIST.md",
  "docs/SUPPORT_BOUNDARY.md",
  "docs/KNOWN_LIMITATIONS.md",
  "docs/CHANNEL_READINESS_MATRIX.md",
  "docs/CHANNEL_PROMOTION_GATE.md",
  "docs/CREDENTIAL_READINESS_MATRIX.md",
  "docs/PLUGIN_REVIEW_GATE.md",
  "docs/UPDATE_ROLLBACK_RUNBOOK.md",
  "docs/INDEX.md",
  "docs/v1.0-release-candidate.md",
  "docs/v1.0-post-rc-closure-review.md",
  "docs/v1.0-ga-promotion-review.md",
  "docs/v1.0-security-and-permanent-use-review.md",
]) {
  const basename = path.basename(rel);
  if (!readme.includes(rel) && !readme.includes(`docs/${basename}`) && !readme.includes(`./docs/${basename}`)) {
    failures.push(`README.md does not reference ${rel}`);
  }
}

if (!quickstart.includes("FIRST_RUN_CHECKLIST.md")) {
  failures.push("QUICKSTART.md does not reference FIRST_RUN_CHECKLIST.md");
}

if (!quickstart.includes("PERMANENT_USE_CHECKLIST.md")) {
  failures.push("QUICKSTART.md does not reference PERMANENT_USE_CHECKLIST.md");
}

if (!config.includes("CREDENTIAL_READINESS_MATRIX.md")) {
  failures.push("CONFIG.md does not reference CREDENTIAL_READINESS_MATRIX.md");
}

if (!troubleshooting.includes("FIRST_RUN_CHECKLIST.md")) {
  failures.push("TROUBLESHOOTING.md does not reference FIRST_RUN_CHECKLIST.md");
}

const stalePatterns = [
  new RegExp(["runtime schedule creation", "is not enabled in v0\\.1"].join(" "), "i"),
  new RegExp(["Runtime schedule creation", "remains outside v0\\.1"].join(" "), "i"),
];

for (const rel of ["README.md", "QUICKSTART.md", "CONFIG.md", "TROUBLESHOOTING.md", "docs/FIRST_RUN_CHECKLIST.md"]) {
  const text = read(rel);
  for (const pattern of stalePatterns) {
    if (pattern.test(text)) {
      failures.push(`${rel} contains stale runtime schedule text: ${pattern}`);
    }
  }
}

for (const rel of currentReleaseDocs) {
  if (/\bv0\.1\b/.test(read(rel))) {
    failures.push(`${rel} contains stale v0.1 release text`);
  }
}

const matrix = JSON.parse(read("docs/compatibility-matrix.json"));
const channels = matrix.channels ?? {};
const expectedStatuses = {
  webchat: "first-party",
  telegram: "first-party",
  slack: "first-party-preview",
  discord: "first-party-preview",
  teams: "first-party-preview",
  line: "first-party-preview",
  whatsapp: "reserved-third-party",
};

for (const [channel, status] of Object.entries(expectedStatuses)) {
  if (channels[channel]?.status !== status) {
    failures.push(`compatibility matrix ${channel}.status expected ${status}, got ${channels[channel]?.status}`);
  }
}

if (channels.whatsapp?.core_supported !== false) {
  failures.push("compatibility matrix whatsapp.core_supported must be false");
}

if (failures.length > 0) {
  console.error("docs check failed");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("docs check passed");
