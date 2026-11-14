import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = process.cwd();

const requiredDocs = [
  "AGENTS.md",
  "docs/PLATFORM_TARGETS_QE.md",
  "docs/BACKUP_REF_MIGRATION.md",
  "docs/QE_CURRENT_AUTHORITY.md",
  "docs/qe/現行/MANIFEST.json",
  "docs/qe/現行/01_BLUE-TANUKI_統合仕様書_rev5_3.json",
  "docs/qe/現行/02_BLUE-TANUKI_全体施工工程表_rev5_3.json",
  "docs/qe/現行/03_BLUE-TANUKI_Codex施工指示書_rev5_3.json",
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
  "AGENTS.md": ["QE_BUILD", "QE_QC", "QE_QA", "全5OS", "三文書すべてと適用AGENTS.mdを読み直す", "refs/tags/codex/backup-main", "Android", "iOS", "MIGRATION_COMPLETE", "三点セットの作成・提出はGitHub反映の許可ではない"],
  "docs/作業標準要領.md": ["QE_BUILD", "QE_QC", "QE_QA", "全5OS", "現行ピンの三文書すべて", "refs/tags/codex/backup-main", "Android", "iOS", "MIGRATION_COMPLETE"],
  "docs/QE_CURRENT_AUTHORITY.md": ["現行ピン", "三文書すべて", "履歴", "MANIFEST.json", "rev5.3", "次の局所BUILD_BATCH選定"],
  "docs/ROADMAP.md": ["QE_BUILD", "QE_QC", "QE_QA", "BUILD_COVERED", "固定された現行三点セット全文を読み直す", "J4", "Android", "iOS", "MIGRATION_COMPLETE", "refs/tags/codex/backup-main", "rev5.3"],
  "docs/DEVELOPMENT_PRACTICE.md": ["QE_CURRENT_AUTHORITY.md", "作業標準要領.md", "履歴ログ", "最新の三点正本全文を読み直す"],
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
  "docs/ROADMAP.md": ["一単位ずつ有限受入とGit完結を行う", "現行はrev5.2の三点正本"],
  "AGENTS.md": ["現行rev5.2は", "BUILD_BATCHはP2全体施工内の技術的checkpoint", "BUILD_BATCH終了時に限定commitをmainへpushし"],
  "docs/DEVELOPMENT_PRACTICE.md": ["三点正本は今回に必要な節だけ読む", "三点全文の再読は新版指定", "現行二世代remote backupの正本はrefs/heads"],
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

// 公開された三点正本を唯一の現行施工指示として照合する。旧版のhistoryは対象外。
const qeManifest = JSON.parse(read("docs/qe/現行/MANIFEST.json"));
const qeCanonicalFiles = Object.keys(qeManifest.文書 ?? {});
const qeParsed = {};
if (qeManifest.版 !== "5.3" || qeCanonicalFiles.length !== 3) {
  failures.push("現行QE manifestがrev5.3・三文書ではない");
}
const activeNames = fs.readdirSync(path.join(root, "docs/qe/現行")).filter(file => /^0[1-3]_.*\.json$/.test(file)).sort();
if (JSON.stringify(activeNames) !== JSON.stringify([...qeCanonicalFiles].sort())) {
  failures.push("現行ディレクトリに現行三点以外の版/不足ファイルが混在");
}
for (const file of qeCanonicalFiles) {
  const rel = `docs/qe/現行/${file}`;
  if (!exists(rel)) continue;
  const actualHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex");
  const doc = JSON.parse(read(rel));
  qeParsed[file.slice(0, 2)] = doc;
  if (actualHash !== qeManifest.文書[file].SHA256) failures.push(`${rel}: manifest SHA-256不一致`);
  if (doc.識別?.版 !== "5.3" || doc.識別?.公開 !== true || /未採用|リポジトリ未反映/.test(doc.識別?.状態 ?? "") || Object.hasOwn(doc.正本切替 ?? {}, "秘匿")) {
    failures.push(`${rel}: 旧版・未採用状態または非公開規則が現行三点正本に残存`);
  }
  if (doc.版管理?.採用記録?.対象?.includes("gatchimuchio/BLUE-TANUKI") !== true ||
      doc.権限境界_rev5_3?.リポジトリ反映?.includes("個別命令") !== true) {
    failures.push(`${rel}: 指示者による明示的なリポジトリ採用と製品施工の分離が欠落`);
  }
  if (!read("docs/QE_CURRENT_AUTHORITY.md").includes(actualHash)) {
    failures.push(`${rel}: 現行ピンにSHA-256がない`);
  }
}
const qeActualCounts = {
  要求: qeParsed["01"]?.要求?.length,
  親成果: qeParsed["02"]?.親成果?.length,
  施工単位: qeParsed["02"]?.施工単位?.length,
  親QC候補: qeParsed["03"]?.親QC候補?.length,
  局所QC候補: qeParsed["03"]?.局所QC候補?.length,
  競合能力基準: qeParsed["01"]?.競合能力基準?.length,
};
for (const [name, count] of Object.entries(qeActualCounts)) {
  if (count !== qeManifest.母集団?.[name]) failures.push(`QE現行正本母集団 ${name}: ${count} != ${qeManifest.母集団?.[name]}`);
}
// ID連結と原点資料の責任境界を構造的に検査。歴史的な原文詳細は規範ではない。
const qeSpec = qeParsed["01"];
const qePlan = qeParsed["02"];
const qeWork = qeParsed["03"];
if (qeSpec && qePlan && qeWork) {
  const requirementIDs = qeSpec.要求.map(item => item.ID);
  const unitIDs = qePlan.施工単位.map(item => item.ID);
  const reqSet = new Set(requirementIDs);
  const unitSet = new Set(unitIDs);
  if (reqSet.size !== requirementIDs.length || unitSet.size !== unitIDs.length) failures.push("QE要件/施工索引にID重複");
  if (JSON.stringify([...requirementIDs].sort()) !== JSON.stringify([...(qeWork.要求ID台帳照合?.["431"] ?? [])].sort())) {
    failures.push("QE仕様書431要求とCodex指示書の要求ID台帳が不一致");
  }
  for (const unit of qePlan.施工単位) {
    for (const req of unit.要求ID ?? []) if (!reqSet.has(req)) failures.push(`施工単位${unit.ID}に不存在の要求ID: ${req}`);
  }
  for (const test of qeWork.局所QC候補) {
    if (!unitSet.has(test.単位)) failures.push(`局所QC ${test.ID}が不存在の施工単位を参照: ${test.単位}`);
  }
  if (Object.hasOwn(qeSpec["HDS有限射影と学習"] ?? {}, "原典") ||
      (qeSpec["欠損・決定待ち"] ?? []).some(item => item.ID === "OD-02" || /HDS原点|HDS原典/.test(item.事項 ?? "")) ||
      (qeSpec.要求 ?? []).some(item => /HDS原点|HDS原典/.test(item.成立内容 ?? "")) ||
      (qePlan.施工単位 ?? []).some(item => /HDS原点|内部HDS原典/.test(item.拒否条件 ?? "")) ||
      (qeWork.局所QC候補 ?? []).some(item => /HDS原点|内部HDS原典/.test(item.成立条件 ?? ""))) {
    failures.push("現行製品仕様/施工/検査に不存在のHDS原点資料の依存が復活");
  }
  if (!qeWork.最初に実行する命令_rev5?.施工?.includes("全製品") ||
      !qePlan.施工方式_rev5?.全体施工?.includes("一工程")) {
    failures.push("全域一括施工の現行工程・指示が欠落");
  }
  if (!qeWork.LLM読取規約?.注意?.includes("現行repo pin") ||
      !qeWork.施工起動ゲート_rev5_3?.未委任状態?.includes("製品実装は未委任") ||
      !qePlan.根拠参照?.三点の所在?.includes("docs/qe/現行") ||
      /提出候補|未反映/.test(qeSpec.版管理?.本版 ?? "")) {
    failures.push("rev5.3現行採用後も提出ZIPの未採用状態・施工権限混同が残存");
  }
}
if (exists("docs/IMPLEMENTATION_INSTRUCTIONS.md")) {
  failures.push("廃止済みの第四施工指示書が復活している");
}
for (const rel of ["AGENTS.md", "README.md", "docs/INDEX.md", "docs/ROADMAP.md", "docs/作業標準要領.md", "docs/DEVELOPMENT_PRACTICE.md"]) {
  if (/\]\(IMPLEMENTATION_INSTRUCTIONS\.md\)/.test(read(rel))) {
    failures.push(`${rel}: 削除済み第四施工指示書へのリンクが残存`);
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
