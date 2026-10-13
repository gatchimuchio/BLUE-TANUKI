import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const requiredDocs = [
  "AGENTS.md",
  "docs/PLATFORM_TARGETS_QE.md",
  "docs/BACKUP_REF_MIGRATION.md",
  "docs/IMPLEMENTATION_INSTRUCTIONS.md",
  "docs/ROADMAP.md",
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
  "docs/RELEASE_HARDENING.md",
  "docs/phase8-s2a-operator-usability-docs.md",
  "docs/phase10-s3-distribution-ux-hardening.md",
  "docs/v1.0-security-and-permanent-use-review.md",
  "docs/v1.0-release-candidate.md",
  "docs/v1.0-post-rc-closure-review.md",
  "docs/v1.0-ga-promotion-review.md",
  "docs/P13_OWNER_GO_READINESS.md",
  "docs/phase11-s12-plugin-review-gate-implementation.md",
  "docs/phase11-s13-v1-ga-promotion-execution.md",
  "規定/README.md",
  "規定/00_日本語基底規定.md",
  "規定/01_基底語彙.md",
  "規定/02_資産分類と局所例外.md",
  "規定/正本索引.json",
  "規定/局所例外台帳.json",
  "規定/移行台帳.json",
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

for (const rel of [
  "規定/README.md",
  "規定/00_日本語基底規定.md",
  "規定/01_基底語彙.md",
  "規定/02_資産分類と局所例外.md",
]) {
  if (!readme.includes(rel)) {
    failures.push(`README.md does not reference ${rel}`);
  }
}

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
  "docs/RELEASE_HARDENING.md",
  "docs/INDEX.md",
  "docs/v1.0-release-candidate.md",
  "docs/v1.0-post-rc-closure-review.md",
  "docs/v1.0-ga-promotion-review.md",
  "docs/P13_OWNER_GO_READINESS.md",
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
  "docs/RELEASE_HARDENING.md",
  "docs/INDEX.md",
  "docs/v1.0-release-candidate.md",
  "docs/v1.0-post-rc-closure-review.md",
  "docs/v1.0-ga-promotion-review.md",
  "docs/P13_OWNER_GO_READINESS.md",
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

// QE規定の現行文書間の構造的一致を確認する。
// 文書整合だけを確認し、製品のQC/QAや実機成功は証明しない。
const qeGovernanceRequired = {
  "AGENTS.md": ["QE_BUILD", "QE_QC", "QE_QA", "BUILD_BATCH", "refs/tags/codex/backup-main", "Android", "iOS", "MIGRATION_COMPLETE"],
  "docs/作業標準要領.md": ["QE_BUILD", "QE_QC", "QE_QA", "BUILD_BATCH", "refs/tags/codex/backup-main", "Android", "iOS", "MIGRATION_COMPLETE"],
  "docs/IMPLEMENTATION_INSTRUCTIONS.md": ["QE_BUILD", "BUILD_BATCH", "BUILD_GAP", "PENDING_OWNER_GO", "MIGRATION_COMPLETE"],
  "docs/ROADMAP.md": ["QE_BUILD", "QE_QC", "QE_QA", "BUILD_COVERED", "J4", "Android", "iOS", "MIGRATION_COMPLETE", "refs/tags/codex/backup-main"],
  "docs/DEVELOPMENT_PRACTICE.md": ["BUILD_BATCH", "refs/heads", "refs/tags/codex/backup-main", "MIGRATION_COMPLETE"],
  "docs/STRATEGY_FRAME.md": ["OpenClaw", "Muse", "D4Pocket", "QC", "QA"],
  "docs/NON_GOALS.md": ["ClawHub", "BUILD_GAP", "PENDING_OWNER_GO", "Android", "iOS"],
  "docs/OPENCLAW_REJECTION_AUDIT.md": ["ClawHub", "BUILD_GAP", "QC"],
  "docs/INDEX.md": ["D4Pocket", "QE", "P13", "PLATFORM_TARGETS_QE.md", "BACKUP_REF_MIGRATION.md", "MIGRATION_COMPLETE"],
  "docs/PLATFORM_TARGETS_QE.md": ["Windows", "Linux", "macOS", "Android", "iOS", "Device Link", "QE_QC", "QE_QA"],
  "docs/BACKUP_REF_MIGRATION.md": ["refs/heads/codex/backup-main", "refs/tags/codex/backup-main", "MIGRATION_COMPLETE", "force-with-lease"],
  "CLAIM.md": ["D4Pocket", "v1.0 RC"],
};
for (const [rel, tokens] of Object.entries(qeGovernanceRequired)) {
  const body = read(rel);
  for (const token of tokens) {
    if (!body.includes(token)) failures.push(`${rel}: QE現行正本の必須要素欠落: ${token}`);
  }
}
const qeGovernanceForbidden = {
  "docs/作業標準要領.md": ["一作業単位をmainへ一commit", "現行remote backupの正本はrefs/heads"],
  "docs/IMPLEMENTATION_INSTRUCTIONS.md": ["D01.02だけを実施する", "検証後に二世代backup branchを回す"],
  "docs/ROADMAP.md": ["一単位ずつ有限受入とGit完結を行う"],
  "docs/DEVELOPMENT_PRACTICE.md": ["現行二世代remote backupの正本はrefs/heads"],
  "docs/NON_GOALS.md": ["- No ClawHub compatibility"],
  "docs/STRATEGY_FRAME.md": [
    "does not modify GUI Shell, depend on GUI Shell at runtime",
    "does not mean set-theoretic inclusion of every OpenClaw feature",
  ],
  "docs/OPENCLAW_REJECTION_AUDIT.md": [
    "the coverage target does not require implementing every OpenClaw feature",
  ],
};
for (const [rel, patterns] of Object.entries(qeGovernanceForbidden)) {
  const body = read(rel);
  for (const pattern of patterns) {
    if (body.includes(pattern)) failures.push(`${rel}: 廃止済みの現行施工・設計規則が残存: ${pattern}`);
  }
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
