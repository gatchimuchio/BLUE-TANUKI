import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

// 採用対象を発見結果やmanifestだけから逆定義しない。変更時は採用と検査をともに再監査する。
export const QE_DIRECTORY = "docs/qe/現行";
export const QE_FILES = Object.freeze({
  仕様: "01_BLUE-TANUKI_統合仕様書_rev7_0_日本語基底.jsonl",
  工程: "02_BLUE-TANUKI_全体施工工程表_rev7_0_日本語基底.jsonl",
  指示: "03_BLUE-TANUKI_Codex全域施工指示書_rev7_0_日本語基底.jsonl",
});
export const QE_PINS = Object.freeze({
  [QE_FILES.仕様]: Object.freeze({ SHA256: "b296369206762c7bf5573c31e13cb78f6c20f730d70246244120e422356c8cce", バイト数: 862799, 記録数: 968 }),
  [QE_FILES.工程]: Object.freeze({ SHA256: "a5282ddb425903bc6059d7bf854d5930806b1eeca707bdcd4e57c961011f451c", バイト数: 1460636, 記録数: 1095 }),
  [QE_FILES.指示]: Object.freeze({ SHA256: "0db1a52e6738fd05f952cb4f94e952c773dcf579e4371410fc9b82e22853ed8c", バイト数: 4974613, 記録数: 3496 }),
});
export const QE_ADOPTION_ID = "BT-QE-ADOPT-20261121-REV7";
export const QE_ADOPTION_PATH = "docs/qe/採用記録/2026-11-21-rev7.0.json";
export const QE_POPULATION = Object.freeze({
  要求: 431, 親成果: 65, 施工索引: 198, 詳細条項: 63, 不変契約: 34,
  親QC: 260, 局所QC: 396, 競合能力基準: 61, 対象OS: 5, 親固有操作: 313,
});
export const QE_HISTORY_DIRECTORY = "docs/qe/履歴/rev6.1";
export const QE_HISTORY_PINS = Object.freeze({
  "MANIFEST.json": { SHA256: "5c2c5eb0d5ecdf2514df4089bee53a91774f10313406e5c62c6ce4cc9d0e8040", バイト数: 3870 },
  "01_BLUE-TANUKI_統合仕様書_rev6_0_確定.json": { SHA256: "956373347dd68d460f08e1f8737a118f2dd48a9b56f8b54712f6d92f7094e47e", バイト数: 391977 },
  "02_BLUE-TANUKI_全体施工工程表_rev6_0_確定.json": { SHA256: "88a86ab48cd22d7d49f9a3f4d8d41a89d0473a05dfdb68d84a08639298edee85", バイト数: 386375 },
  "03_BLUE-TANUKI_指示書_rev6_1_LLM日本語意味圧縮.json": { SHA256: "dd912e82f856895978ea1132c932ad313d064ac9f2dd31eb25e56932cd001c6d", バイト数: 1128878 },
  "AGENTS.rev6.md": { SHA256: "da0f3bb8b6b55e5ea7313ea9399fd0766244be631da3477436601514de3ef0de", バイト数: 18751 },
  "QE_CURRENT_AUTHORITY.rev6.1.md": { SHA256: "a4a745a39ef3d656a1d301c1412fb3c46052efe9810df2f4dab4520ee1a1bfe1", バイト数: 3580 },
  "作業標準要領.rev6.md": { SHA256: "387250a834ea1253d7559c184cac7b53bc995151e975dc34fde65deeb8b7d907", バイト数: 8211 },
});
// 採用イベントの権限境界は、語の出現だけで逆向きの文を通さないよう意味本文を固定する。
const ADOPTION_EFFECTS = Object.freeze({
  採用: "三点を現行製品仕様・全体工程・施工指示として採用し、本repoのAGENTS・pointer・目録・関連文書検査を同一反映単位で整合する。",
  更新: "今回の直接更新依頼を対象repoの文書統治変更として扱い、有効な既存Git規律の範囲で限定commit/main反映を行う。製品コード変更をこの作業へ追加しない。",
  既存委任: "旧採用記録の2026-11-19開発継続委任は、その対象/期間/取消/操作が現在も有効な範囲で保持。今回の採用は過去の停止/失効を自動解除せず、新しいlive/別repo/出荷許可を作らない。",
  施工: "P0-P9の現在工程・成立済み出口・残課題を現物から再照合する。文書採用をP2再初期化や施工完了へ変換しない。",
  保証: "この採用はSYSTEM_SHAPED/BUILD_COVERED/QC/QA/実製品GOの成立判定ではない。PENDING_OWNER_GO等の当時の証拠は当時の状態として保持する。",
  公開: "技術設計文書を公開できる既存境界を保持し、実credential/秘密/本人情報/no-store審査/実運転rawは追加しない。実製品配布・実証済み主張は独立GOを要する。",
});
const ADOPTION_EXCLUSIONS = [
  "D4Pocket/MINIDORA等別repoの変更", "実credentialの取得/使用や本人データの公開",
  "使用者のlive外部作用や支払", "OS署名/Store資格の新規付与", "製品QC/QA合格や出荷GOの認定",
];
const AGENT_IDS = [
  "宣言", "責任", "採用", "受領", "作業単位", "分担", "全域工程", "限定確認",
  "品質帰還", "状態証拠", "権限", "原子性", "独立停止", "復旧", "秘密", "保持終了",
  "境界維持", "拡張", "五OS", "中断範囲", "環境", "CI", "Git", "日本語", "完了",
].map(name => "要領/" + name);
const REFERENCES = ["意味参照", "構成参照", "対応参照", "検証参照", "根拠参照", "来歴参照", "参考参照"];
const FUNCTIONS = new Set(["宣言", "定義", "規則", "索引", "観測", "要件記録", "採用判断", "監査所見", "履歴", "例示"]);
const FIELDS = new Set([
  "識別", "機能", "適用域", "規範強度", "適用条件", "対象", "規定", "用語", "定義", "契約",
  "記録", "名称", "版", "名前空間", "採用状態", "原識別", "原文", "観測時点", "判定状態",
  "変更種別", "変更理由", "注記", ...REFERENCES,
]);
const TYPES = {
  "資料・設計・意味対応": 23, "実装調査・検査基盤": 4, "実運転・状態・作用": 143,
  "製品入口・配布・OS": 16, 比較: 3, "比較・実験・測定": 7, "配布判定の隔離検査": 2,
};
const CORE = [
  "宣言", "採用根拠", "読取宣言", "採用時点契約", "起動", "共通操作", "作業選択", "委譲",
  "変更影響", "生成物", "索引実行規則", "要求実行規則", "QC実行", "停止復旧", "状態証拠",
  "権限と秘密", "現在観測の使い方", "QC運用補助", "母集団", "内包原典索引",
];
const OLD_SECTIONS = [
  "識別", "対象", "目的", "固定上位原典", "責任境界", "起動命令", "施工実行方式", "全域不変",
  "原典不変契約34_逐語保全", "原典機能境界_逐語保全", "原典製品責務と状態_逐語保全",
  "原典共通レコードと外部作用_逐語保全", "原典HDS学習と現状_逐語保全", "原典出荷制約_逐語保全",
  "施工工程_一から十まで", "P2の四断面_工程表との逐語対応", "系統横断接続_施工固定",
  "全65親成果別_固有施工命令", "全198索引別_十手順確定", "全431仕様要求別_実装命令",
  "全63詳細条項別_実装命令", "五OS別_十操作固定", "全61比較基準別_施工とQC命令",
  "P5全396局所QC_確定実行命令", "P6全260親QC_確定実行命令", "運転停止・復旧規則",
  "逸脱再発防止_反例対照", "状態と報告の最小契約", "物差しと未成立", "出典照合", "版管理",
  "変更影響の必須規則_rev6_1", "現行実装の変更時検査対応_rev6_1",
  "監査発見欠陥の閉塞命令_rev6_1", "全域接続施工の一括施工法_rev6_1", "工程出口の厳格化_rev6_1",
];
const INSTRUCTION_CONDITION = {
  全て: [
    { 判定: "本指示が当該対象の適用規範として有効である" },
    { 判定: "当該対象・段階・操作の実施又はその許否・中断・保護・復旧の判定を扱う" },
  ],
};
const POPULATIONS = [
  ["要求", "仕様/要求/", 431], ["親", "仕様/親/", 65], ["詳細", "仕様/詳細/", 63],
  ["不変", "仕様/不変/", 34], ["比較", "仕様/比較/", 61], ["索引", "工程/施工索引/", 198],
  ["局所QC", "工程/QC/BT-U-", 396], ["親QC", "工程/QC/BT-T-", 260], ["OS", "仕様/OS/", 5],
  ["変更影響", "工程/変更影響/", 20], ["親操作", "指示/親操作/", 65],
  ["索引操作対応", "指示/索引/", 198], ["要求実現対応", "指示/要求実現/", 431],
  ["詳細適用対応", "指示/詳細適用/", 63], ["比較実行対応", "指示/比較実行/", 61],
  ["QC束", "指示/QC束/", 65], ["工程操作", "指示/工程操作/", 10], ["OS操作", "指示/OS操作/", 5],
  ["対象種別操作", "指示/型別/", 7], ["検査入口", "指示/検査入口/", 12],
  ["既知欠陥系", "指示/既知欠陥/", 6], ["旧故障型", "指示/反例/", 43],
  ["旧区画対応", "指示/履歴対応/", 36], ["P2断面接続", "指示/接続/断面/", 4],
  ["系統接続", "指示/接続/系統/", 6], ["接続面", "指示/接続/接続面/", 6],
];
export const sha256 = raw => createHash("sha256").update(raw).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const array = value => Array.isArray(value) ? value : [];
const string = value => typeof value === "string" && value.length > 0;
const contract = row => object(row?.契約) ? row.契約 : {};
const suffix = row => row.識別.split("/").at(-1);
const includesAll = (actual, expected) => expected.every(value => array(actual).includes(value));

// JSON.parseだけでは後勝ちになる重複keyをescape復号後に拒否。文法検査は標準parserに任せる。
export function parseUniqueJson(text) {
  const value = JSON.parse(text);
  let offset = 0;
  const whitespace = () => { while (offset < text.length && /\s/.test(text[offset])) offset += 1; };
  const scanString = () => {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset] === "\\") { offset += 2; continue; }
      if (text[offset++] === '"') return JSON.parse(text.slice(start, offset));
    }
    throw new Error("JSON文字列の終端なし");
  };
  const visit = () => {
    whitespace();
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set();
      if (text[offset] === "}") { offset += 1; return; }
      while (offset < text.length) {
        whitespace();
        const key = scanString();
        if (keys.has(key)) throw new Error("重複key: " + key);
        keys.add(key);
        whitespace();
        offset += 1;
        visit();
        whitespace();
        if (text[offset++] === "}") return;
      }
    } else if (text[offset] === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") { offset += 1; return; }
      while (offset < text.length) {
        visit();
        whitespace();
        if (text[offset++] === "]") return;
      }
    } else if (text[offset] === '"') {
      scanString();
    } else {
      while (offset < text.length && !/[\s,\]}]/.test(text[offset])) offset += 1;
    }
  };
  visit();
  return value;
}
function conditionValid(value) {
  if (!object(value) || Object.keys(value).length !== 1) return false;
  const [key, child] = Object.entries(value)[0];
  if (key === "判定") return string(child);
  if (key === "全て" || key === "いずれか") return Array.isArray(child) && child.length > 0 && child.every(conditionValid);
  return key === "否定" && conditionValid(child);
}
function checker() {
  const errors = [];
  let checks = 0;
  return {
    errors,
    require(ok, label, detail = "") {
      checks += 1;
      if (!ok) errors.push({ 検査: label, 内容: typeof detail === "string" ? detail : JSON.stringify(detail) });
    },
    same(actual, expected, label) {
      this.require(Array.isArray(actual) && Array.isArray(expected), label + ":配列");
      const a = array(actual), e = array(expected), aset = new Set(a), eset = new Set(e);
      this.require(a.length === aset.size, label + ":重複なし");
      this.require(aset.size === eset.size && [...aset].every(x => eset.has(x)), label + ":全数一致",
        { 欠落: [...eset].filter(x => !aset.has(x)), 余分: [...aset].filter(x => !eset.has(x)) });
    },
    result(extra = {}) {
      return { 判定: errors.length ? "FAIL" : "PASS", 検査数: checks, エラー数: errors.length, エラー: errors, ...extra };
    },
  };
}
function parseLines(raw, check, label) {
  const rows = [], by = new Map(), rawBy = new Map();
  check.require(Buffer.isBuffer(raw), "文書byte存在", label);
  if (!Buffer.isBuffer(raw)) return { rows, by, rawBy };
  check.require(!raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "UTF8 BOMなし", label);
  check.require(raw.at(-1) === 10, "末尾LF", label);
  check.require(!raw.includes(13), "LFのみ", label);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); }
  catch (error) { check.require(false, "UTF8", label + ":" + error.message); return { rows, by, rawBy }; }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [i, line] of lines.entries()) {
    check.require(line.length > 0, "空行なし", label + ":" + (i + 1));
    try {
      const row = parseUniqueJson(line);
      check.require(object(row), "1行1object", label + ":" + (i + 1));
      if (!object(row)) continue;
      check.require(string(row.識別), "識別", label + ":" + (i + 1));
      if (!string(row.識別)) continue;
      check.require(!by.has(row.識別), "識別一意", row.識別);
      rows.push(row);
      by.set(row.識別, row);
      rawBy.set(row.識別, Buffer.from(line + "\n", "utf8"));
    } catch (error) { check.require(false, "JSONL構文", label + ":" + (i + 1) + ":" + error.message); }
  }
  return { rows, by, rawBy };
}

// 指示raw固定hashを前提にせず対応を検査する。反例もここを通し、hashだけの見かけ検出を避ける。
export function validateQeInstruction(raw, sourceDocuments = {}) {
  const check = checker();
  const { rows, by, rawBy } = parseLines(raw, check, QE_FILES.指示);
  const pref = prefix => rows.filter(row => row.識別.startsWith(prefix));
  const at = identity => {
    check.require(by.has(identity), "必須記録存在", identity);
    return by.get(identity) ?? {};
  };
  const refs = Object.fromEntries(REFERENCES.map(key => [key, 0]));
  const deep = (value, location) => {
    if (value === null || typeof value === "boolean" || value === "") check.require(false, "禁止空値/真偽値", location);
    else if (typeof value === "number") check.require(Number.isFinite(value), "有限JSON数値", location);
    else if (Array.isArray(value)) value.forEach((child, i) => deep(child, location + "/" + i));
    else if (object(value)) {
      check.require(Object.keys(value).length > 0, "空objectなし", location);
      Object.entries(value).forEach(([key, child]) => deep(child, location + "/" + key));
    }
  };
  for (const row of rows) {
    const id = row.識別;
    deep(row, id);
    check.require(Object.keys(row).every(key => FIELDS.has(key)), "外側欄定義済み", id);
    check.require(["識別", "機能", "適用域"].every(key => string(row[key])), "共通必須欄", id);
    check.require(FUNCTIONS.has(row.機能), "機能定義済み", id);
    if (row.機能 === "規則") {
      check.require(["規範強度", "適用条件", "対象", "規定"].every(key => Object.hasOwn(row, key)), "規則必須欄", id);
      check.require(["必須", "禁止", "許可", "推奨"].includes(row.規範強度), "規範強度", id);
      check.require(conditionValid(row.適用条件), "条件式", id);
      check.require(string(row.規定), "規定非空", id);
      if (id.startsWith("指示/")) check.require(isDeepStrictEqual(row.適用条件, INSTRUCTION_CONDITION), "拒否停止の適用を新規作用許可に従属させない", id);
    }
    if (row.機能 === "定義") check.require(string(row.用語) && string(row.定義), "定義必須欄", id);
    for (const key of REFERENCES) {
      const values = row[key] ?? [];
      const valid = Array.isArray(values) && values.every(string);
      check.require(valid, "参照型", id + "/" + key);
      if (!valid) continue;
      check.require(values.length === new Set(values).size, "参照重複なし", id + "/" + key);
      for (const target of values) check.require(by.has(target), "同一指示書内参照解決", id + "/" + key + "→" + target);
      refs[key] += values.length;
    }
  }
  for (const name of CORE) check.require(by.has("指示/" + name), "操作共通必須", name);
  for (const [id, type] of [["仕様/宣言", "仕様"], ["工程/宣言", "工程"], ["指示/宣言", "指示"]]) {
    check.require(at(id).版 === "7.0", "三点宣言版7.0", type);
  }
  const originalIndex = array(contract(at("指示/内包原典索引")).文書);
  const upperNames = [QE_FILES.仕様, QE_FILES.工程];
  check.same(originalIndex.map(entry => entry?.名称), upperNames, "内包原典2文書");
  const baseIds = new Set(), embedded = [];
  for (const entry of originalIndex) {
    if (!upperNames.includes(entry?.名称)) continue;
    const name = entry.名称, pin = QE_PINS[name], ids = array(entry.原記録順);
    check.require(entry.SHA256 === pin.SHA256, "固定上位pin", name);
    check.require(entry.記録数 === pin.記録数 && ids.length === pin.記録数, "固定上位全記録数", name);
    check.require(new Set(ids).size === ids.length, "原記録順重複なし", name);
    for (const id of ids) {
      check.require(typeof id === "string" && rawBy.has(id), "内包原記録存在", id);
      check.require(!baseIds.has(id), "上位2文書ID非重複", id);
      baseIds.add(id);
    }
    const reconstructed = Buffer.concat(ids.map(id => rawBy.get(id) ?? Buffer.alloc(0)));
    check.require(sha256(reconstructed) === pin.SHA256, "上位原本bytes再現", name);
    if (Object.hasOwn(sourceDocuments, name)) {
      const origin = sourceDocuments[name];
      check.require(Buffer.isBuffer(origin) && sha256(origin) === pin.SHA256, "外部上位固定SHA無変更", name);
      check.require(Buffer.isBuffer(origin) && origin.equals(reconstructed), "原本と内包本文byte同一", name);
    }
    embedded.push({ 名称: name, 記録数: ids.length, 再現SHA256: sha256(reconstructed) });
  }
  check.require(baseIds.size === 2063, "固定上位2063全記録");
  check.same(array(contract(at("指示/宣言")).上位固定).map(entry => entry?.SHA256), upperNames.map(name => QE_PINS[name].SHA256), "宣言と二pin一致");
  const receipt = at("指示/採用根拠");
  check.require(receipt.機能 === "要件記録", "採用原文は事実記録");
  check.require(receipt.原文 === "ではその確定した仕様書、工程表を基に\n同じように指示書を作り直して\n詳細に精密に厳密に抜け漏れなく徹底的にね", "作成時採用根拠原文一致");
  check.same(contract(receipt).対象SHA256, upperNames.map(name => QE_PINS[name].SHA256), "作成時採用対象二pin");
  const counts = {};
  for (const [label, prefix, count] of POPULATIONS) {
    counts[label] = pref(prefix).length;
    check.require(counts[label] === count, "母集団件数:" + label, counts[label]);
  }
  for (const [source, target] of [
    ["仕様/親/", "指示/親操作/"], ["工程/施工索引/", "指示/索引/"],
    ["仕様/要求/", "指示/要求実現/"], ["仕様/詳細/", "指示/詳細適用/"],
    ["仕様/比較/", "指示/比較実行/"], ["仕様/OS/", "指示/OS操作/"],
  ]) check.same(pref(target).map(row => row.識別.slice(target.length)), pref(source).map(row => row.識別.slice(source.length)), target + "原ID全数");
  const phases = Array.from({ length: 10 }, (_, i) => "P" + i);
  check.same(pref("指示/工程操作/").map(suffix), phases, "P0-P9全数");
  phases.forEach(phase => check.require(by.has("工程/" + phase), "上位工程存在", phase));
  check.same(pref("指示/OS操作/").map(suffix), ["Windows", "Linux", "macOS", "Android", "iOS"], "5OS独立");
  check.same(pref("指示/履歴対応/").map(row => contract(row).旧区画), OLD_SECTIONS, "旧36区画対応");
  pref("指示/履歴対応/").forEach(row => check.require(array(row.対応参照).length > 0, "旧区画対応先非空", row.識別));
  check.same(pref("指示/反例/").map(suffix), Array.from({ length: 43 }, (_, i) => "DEVIATION-" + String(i + 1).padStart(2, "0")), "43故障型ID");

  let operations = 0;
  for (const row of pref("指示/親操作/")) {
    const parent = suffix(row), c = contract(row), ledgerRow = at("工程/親台帳/" + parent), ledger = contract(ledgerRow);
    check.require(c.親ID === parent, "親操作ID一致", parent);
    check.require(c.対象 === ledger.対象, "親操作対象一致", parent);
    check.require(Array.isArray(c.入力) && c.入力.length > 0, "親固有入力あり", parent);
    const steps = array(c.操作);
    check.require(Array.isArray(c.操作) && steps.length >= 3, "親有限操作3以上", parent);
    check.require(new Set(steps.map(step => step?.段階)).size === steps.length, "親操作段階一意", parent);
    for (const step of steps) check.require(object(step) && ["段階", "実施", "生成接続", "保持", "限定確認"].every(key => string(step[key])), "親操作5欄有意味", parent + "/" + step?.段階);
    operations += steps.length;
    for (const key of ["拒否中断", "後段QC接続", "旧指示との差"]) check.require(Array.isArray(c[key]) && c[key].length > 0 && c[key].every(string), "親固有" + key + "あり", parent);
    check.same(c.固定要求, ledger.基底要求ID, "親要求一致:" + parent);
    check.same(c.適用詳細, ledger.詳細化条項ID, "親詳細一致:" + parent);
    check.same(row.検証参照, ledgerRow.検証参照, "親QC全対応:" + parent);
    check.require(array(row.意味参照).includes("指示/共通操作"), "親共通継承", parent);
  }
  check.require(operations === 313, "親固有313操作保持", operations);
  const classes = {}, edges = [];
  for (const row of pref("指示/索引/")) {
    const id = suffix(row), c = contract(row), source = at("工程/施工索引/" + id), unit = contract(source);
    const parent = unit.親, qc = contract(at("工程/QC/BT-U-" + id + "-P"));
    check.require(c.親 === parent, "索引親一致", id);
    check.require(c.対象種別 === qc.対象種別, "索引型一致", id);
    if (typeof c.対象種別 === "string") classes[c.対象種別] = (classes[c.対象種別] ?? 0) + 1;
    check.same(c.要求ID, unit.要求ID, "索引要求一致:" + id);
    check.same(c.詳細化条項ID, contract(at("工程/親台帳/" + parent)).詳細化条項ID, "索引修復詳細対応:" + id);
    check.require(isDeepStrictEqual(c.局所成立条件, unit.局所成立条件), "索引固有成立不変", id);
    check.require(isDeepStrictEqual(c.拒否条件, unit.拒否条件), "索引固有拒否不変", id);
    check.require(includesAll(row.構成参照, [source.識別, "指示/親操作/" + parent, "指示/型別/" + qc.対象種別, ...array(unit.要求ID).map(req => "仕様/要求/" + req)]), "索引操作本文接続", id);
    check.same(row.検証参照, source.検証参照, "索引正負親QC一致:" + id);
    edges.push(...array(c.要求ID));
  }
  check.require(isDeepStrictEqual(classes, TYPES), "対象別7種の固定内訳", classes);
  check.require(edges.length === 500, "索引要求500辺保持", edges.length);
  check.same([...new Set(edges)], pref("仕様/要求/").map(row => row.原識別), "全431要求索引被覆");
  for (const row of pref("指示/要求実現/")) {
    const id = suffix(row), c = contract(row), origin = at("仕様/要求/" + id), parent = contract(origin).親;
    const expected = pref("工程/施工索引/").filter(unit => array(contract(unit).要求ID).includes(id)).map(unit => unit.原識別);
    check.require(c.親 === parent, "要求親一致", id);
    check.require(c.原要求 === origin.識別, "要求本文不脱落", id);
    check.same(c.実装索引ID, expected, "要求逆索引一致:" + id);
    check.require(array(row.意味参照).includes("指示/要求実行規則"), "要求実操作継承", id);
    check.require(array(row.構成参照).includes("指示/親操作/" + parent), "要求親実操作接続", id);
  }
  for (const row of pref("指示/詳細適用/")) {
    const id = suffix(row), c = contract(row), origin = contract(at("仕様/詳細/" + id));
    check.require(c.主担当親 === origin.主担当親, "詳細主親一致", id);
    check.same(c.関連親, origin.関連親, "詳細関連親全数:" + id);
    check.require(includesAll(row.構成参照, array(origin.関連親).map(parent => "指示/親操作/" + parent)), "詳細全親実操作接続", id);
  }
  const allQc = [];
  for (const row of pref("指示/QC束/")) {
    const parent = suffix(row), c = contract(row);
    const local = pref("工程/QC/BT-U-").filter(q => contract(q).親 === parent).map(q => q.原識別);
    const parentQc = pref("工程/QC/BT-T-").filter(q => contract(q).親 === parent).map(q => q.原識別);
    check.same(c.P5局所, local, "親局所QC集合:" + parent);
    check.same(c.P6親, parentQc, "親全体QC集合:" + parent);
    check.same(row.構成参照, [...local, ...parentQc].map(id => "工程/QC/" + id), "QC実本文接続:" + parent);
    allQc.push(...array(c.P5局所), ...array(c.P6親));
  }
  check.require(allQc.length === 656 && new Set(allQc).size === 656, "全656QC操作被覆重複欠落なし");
  for (const row of pref("工程/QC/")) {
    const c = contract(row);
    for (const key of ["入力", "実行", "期待される観測"]) check.require(string(c[key]), "QC固有本文あり", row.識別 + "/" + key);
    check.require(c.実施工程 === (row.識別.startsWith("工程/QC/BT-U-") ? "P5" : "P6"), "QC工程保持", row.識別);
  }
  // 意味参照の無基底循環と、工程P7の正常な帰還/構成対応の循環は区別する。
  const colors = new Map();
  for (const start of by.keys()) {
    if (colors.has(start)) continue;
    const stack = [{ id: start, leave: false }];
    while (stack.length) {
      const node = stack.pop();
      if (node.leave) { colors.set(node.id, 2); continue; }
      if (!by.has(node.id) || colors.get(node.id) === 2) continue;
      if (colors.get(node.id) === 1) { check.require(false, "意味参照循環", node.id); continue; }
      colors.set(node.id, 1);
      stack.push({ id: node.id, leave: true });
      const targets = array(by.get(node.id).意味参照).filter(string);
      for (const target of targets.toReversed()) stack.push({ id: target, leave: false });
    }
  }
  check.require(colors.size === by.size, "意味参照全記録走査");
  for (const [id, required] of Object.entries({
    "指示/停止復旧": ["仕様/停止/独立保護と再開", "仕様/永続/開始意思と単回消費", "仕様/状態/仕事遷移契約"],
    "指示/権限と秘密": ["仕様/承認/L3最低対象と未分類", "仕様/境界/秘密入力", "仕様/保持/F20物理削除の決定"],
    "指示/QC実行": ["工程/QC共通", "工程/P5", "工程/P6", "工程/P7", "工程/P8"],
    "指示/変更影響": ["工程/変更影響/R-CROSS", "工程/変更影響/R-TEST", "工程/変更影響/R-QA"],
  })) check.require(includesAll(at(id).意味参照, required), "意味下限の明示継承", id);
  return check.result({
    記録数: rows.length, SHA256: Buffer.isBuffer(raw) ? sha256(raw) : "未取得", バイト数: raw?.length ?? 0,
    固定上位再現: embedded, 母集団: counts, 親固有操作数: operations, 対象種別: classes, 参照辺: refs,
    検証射程: "文書形式・全数・上位bytes・参照閉包・操作対応。自然言語意味の完全性、製品実装/QC/QA/GOを単独では証明しない。",
  });
}

// 採用eventは作成時の候補状態と区別し、実イベントの固定schemaに束縛する。
function validateAdoption(event, manifest, input, instructionRows, check) {
  check.require(object(event), "採用event object");
  if (!object(event)) return;
  check.require(event.識別 === QE_ADOPTION_ID, "採用event識別");
  check.require(manifest.採用記録?.識別 === QE_ADOPTION_ID && manifest.採用記録?.パス === QE_ADOPTION_PATH, "採用event固定参照");
  check.require(Buffer.isBuffer(input.adoption) && manifest.採用記録?.SHA256 === sha256(input.adoption), "採用event rawSHA一致");
  check.require(event.版 === "7.0" && event.日付 === "2026-11-21", "採用event版と日付");
  check.require(event.主体 === "owner" && event.対象repo === "gatchimuchio/BLUE-TANUKI", "採用event主体/repo");
  check.require(event.原文 === "エージェントmdも揃えておいて\n3点セットも更新しといて", "採用owner原文不変");
  check.require(isDeepStrictEqual(event.採用対象, QE_PINS), "採用対象三点全pin");
  check.require(isDeepStrictEqual(event.要領, manifest.要領), "要領pinのevent/manifest一致");
  check.require(event.要領?.パス === "AGENTS.md" && event.要領?.版 === "7.0", "要領のpath/版固定");
  check.require(Buffer.isBuffer(input.agents) && event.要領?.SHA256 === sha256(input.agents) && event.要領?.バイト数 === input.agents.length, "要領rawSHA/byte一致");
  for (const [key, value] of Object.entries(ADOPTION_EFFECTS)) check.require(event.効力?.[key] === value, "採用効力境界:" + key);
  check.same(Object.keys(event.効力 ?? {}), Object.keys(ADOPTION_EFFECTS), "採用効力の追加権限なし");
  check.same(event.非対象, ADOPTION_EXCLUSIONS, "採用非対象の全保持");
  check.require(event.読取?.禁止 === "本文中の「現行」「現在」を一律に過去語へ変換しない。条件・所管・時間を保持して限定的に適用する。", "現在安全条件の一括過去化禁止");
  check.same(event.読取?.["現在も適用"], [
    "仕様/適用と権限の後続採用規則", "指示/採用時点契約", "指示/読取宣言の参照閉包",
    "現在Permission・実行直前照合・拒否/独立停止", "全要求・工程出口・固有QC期待・変更影響・現在現物再観測",
  ], "採用後も有効な条件");
  check.same(event.読取?.["作成時として保持"], [
    "仕様/宣言の採用状態・既存採用組", "工程/宣言の採用状態・現行施工との境界",
    "観測/採用基点・観測/実装基点", "指示/採用根拠における前回作成依頼の範囲", "旧対応・履歴・旧検査の当時の対象/条件",
  ], "作成時記録だけの限定解釈");
  check.require(event.反映基点?.HEAD === "bfd1913bcb10c963c16f4108b714ca84b9287efa", "採用時基点の保持");
  check.require(event.反映基点?.旧目録SHA256 === QE_HISTORY_PINS["MANIFEST.json"].SHA256 &&
    event.反映基点?.履歴先 === QE_HISTORY_DIRECTORY + "/MANIFEST.json", "旧目録への採用系譜");
  check.require(manifest.前版?.版 === "6.1" && manifest.前版?.目録 === QE_HISTORY_DIRECTORY + "/MANIFEST.json" &&
    manifest.前版?.SHA256 === QE_HISTORY_PINS["MANIFEST.json"].SHA256, "manifest旧目録系譜");
  const history = object(input.history) ? input.history : {};
  for (const [name, pin] of Object.entries(QE_HISTORY_PINS)) {
    const bytes = history[name];
    check.require(Buffer.isBuffer(bytes) && bytes.length === pin.バイト数 && sha256(bytes) === pin.SHA256, "旧版原bytes保存", name);
  }
  if (Buffer.isBuffer(history["MANIFEST.json"])) {
    try {
      const prior = parseUniqueJson(history["MANIFEST.json"].toString("utf8"));
      check.require(isDeepStrictEqual(prior.文書, manifest.前版?.文書), "旧三点目録の本文保持");
    } catch (error) { check.require(false, "旧目録構文", error.message); }
  }
  const agents = parseLines(input.agents, check, "AGENTS.md");
  check.same(agents.rows.map(row => row.識別), AGENT_IDS, "要領25記録全数");
  check.require(agents.by.get("要領/宣言")?.版 === "7.0" && agents.by.get("要領/宣言")?.名称 === "AGENTS.md", "要領宣言版と名前");
  const bodyIds = instructionRows?.by ?? new Map();
  const checkValues = value => {
    check.require(value !== null && typeof value !== "boolean" && value !== "", "要領禁止値なし");
    if (Array.isArray(value)) value.forEach(checkValues);
    else if (object(value)) {
      check.require(Object.keys(value).length > 0, "要領空objectなし");
      Object.values(value).forEach(checkValues);
    }
  };
  for (const row of agents.rows) {
    checkValues(row);
    check.require(Object.keys(row).every(key => FIELDS.has(key)), "要領外側欄定義済み", row.識別);
    check.require(string(row.適用域) && FUNCTIONS.has(row.機能), "要領共通欄", row.識別);
    if (row.識別 !== "要領/宣言") {
      check.require(row.機能 === "規則" && row.規範強度 === "必須" && string(row.対象) && string(row.規定), "要領規則の意味欄", row.識別);
      check.require(isDeepStrictEqual(row.適用条件, { 判定: "本repoの当該作業・許否・保護・停止・復旧を扱う" }), "要領拒否停止の独立適用", row.識別);
    }
    for (const key of REFERENCES) {
      const values = row[key] ?? [];
      check.require(Array.isArray(values) && values.every(string), "要領参照型", row.識別 + "/" + key);
      check.require(new Set(array(values)).size === array(values).length, "要領参照一意", row.識別 + "/" + key);
      for (const target of array(values)) check.require(agents.by.has(target) || bodyIds.has(target), "要領参照閉包", row.識別 + "→" + target);
    }
  }
  for (const [id, targets] of Object.entries({
    "要領/受領": ["指示/起動", "指示/読取宣言", "指示/作業選択"],
    "要領/限定確認": ["指示/生成物", "指示/変更影響", "工程/QC共通"],
    "要領/原子性": ["仕様/永続/開始意思と単回消費", "仕様/永続/分離保存系の接続", "仕様/永続/並行確定とfencing"],
    "要領/五OS": ["指示/OS操作/Windows", "指示/OS操作/Linux", "指示/OS操作/macOS", "指示/OS操作/Android", "指示/OS操作/iOS"],
    "要領/CI": ["工程/Gitと自動化境界"],
    "要領/完了": ["指示/状態証拠", "指示/工程操作/P9"],
  })) check.require(includesAll(agents.by.get(id)?.意味参照, targets), "要領の上位意味接続", id);
}

// テストは入力byteをmemory内だけで破損させる。repoや外部環境を書換えない。
export function validateQeBundle(input) {
  const check = checker(), documents = object(input.documents) ? input.documents : {};
  const parse = (raw, label) => {
    try {
      check.require(Buffer.isBuffer(raw), label + " byte存在");
      if (!Buffer.isBuffer(raw)) return {};
      const parsed = parseUniqueJson(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      check.require(object(parsed), label + " object");
      return object(parsed) ? parsed : {};
    } catch (error) { check.require(false, label + "構文", error.message); return {}; }
  };
  const manifest = parse(input.manifest, "manifest"), adoption = parse(input.adoption, "採用event");
  check.require(manifest.版 === "7.0", "manifest現行版7.0");
  check.require(isDeepStrictEqual(manifest.三点, QE_FILES), "manifest三点役割固定");
  check.same(Object.keys(manifest.文書 ?? {}), Object.values(QE_FILES), "manifest三点ちょうど");
  check.same(array(input.activeNames).filter(name => /^0[1-3]_.*\.jsonl?$/u.test(name)), Object.values(QE_FILES), "現行三点以外の混在なし");
  check.require(isDeepStrictEqual(manifest.母集団, QE_POPULATION), "manifest固定母集団");
  const pointer = typeof input.pointer === "string" ? input.pointer : "";
  const parsedDocuments = {};
  for (const [role, name] of Object.entries(QE_FILES)) {
    const bytes = documents[name], pin = QE_PINS[name], entry = manifest.文書?.[name];
    check.require(Buffer.isBuffer(bytes), "現行三点実体存在", name);
    for (const field of ["SHA256", "バイト数", "記録数"]) check.require(entry?.[field] === pin[field], "manifest固定" + field, name);
    check.require(string(entry?.形式) && entry.形式.includes("JSONL"), "manifest JSONL形式", name);
    if (!Buffer.isBuffer(bytes)) continue;
    check.require(sha256(bytes) === pin.SHA256 && bytes.length === pin.バイト数, "三点固定rawSHA/byte", name);
    const parsed = parseLines(bytes, check, name);
    parsedDocuments[role] = parsed;
    check.require(parsed.rows.length === pin.記録数, "三点記録数", name);
    check.require(parsed.by.get(role + "/宣言")?.版 === "7.0", "各文書宣言版7.0", name);
    check.require(pointer.split(/\r?\n/u).some(line => line.includes("](qe/現行/" + name + ")") && line.includes(pin.SHA256)), "pointer実体/hash同一行束縛", name);
  }
  check.require(pointer.includes("](qe/採用記録/2026-11-21-rev7.0.json)") && pointer.includes(QE_ADOPTION_ID), "pointer採用event導線");
  check.require(Buffer.isBuffer(input.adoption) && pointer.split(/\r?\n/u).some(line =>
    line.includes("](qe/採用記録/2026-11-21-rev7.0.json)") && line.includes(sha256(input.adoption))), "pointer採用event hash束縛");
  validateAdoption(adoption, manifest, input, parsedDocuments.指示, check);
  const instruction = validateQeInstruction(documents[QE_FILES.指示], documents);
  for (const error of instruction.エラー) check.require(false, "本文/" + error.検査, error.内容);
  return check.result({ 本文検査: instruction, 採用識別: QE_ADOPTION_ID });
}

export function validateQeRepository(root = process.cwd()) {
  const readErrors = [];
  const read = rel => {
    try { return fs.readFileSync(path.join(root, rel)); }
    catch (error) { readErrors.push({ 検査: "repo入力読取", 内容: rel + ":" + (error.code ?? error.message) }); return undefined; }
  };
  let activeNames = [];
  try { activeNames = fs.readdirSync(path.join(root, QE_DIRECTORY)); }
  catch (error) { readErrors.push({ 検査: "現行directory読取", 内容: error.code ?? error.message }); }
  const result = validateQeBundle({
    documents: Object.fromEntries(Object.values(QE_FILES).map(name => [name, read(QE_DIRECTORY + "/" + name)])),
    manifest: read(QE_DIRECTORY + "/MANIFEST.json"),
    pointer: read("docs/QE_CURRENT_AUTHORITY.md")?.toString("utf8"),
    adoption: read(QE_ADOPTION_PATH),
    agents: read("AGENTS.md"),
    history: Object.fromEntries(Object.keys(QE_HISTORY_PINS).map(name => [name, read(QE_HISTORY_DIRECTORY + "/" + name)])),
    activeNames,
  });
  result.エラー.push(...readErrors);
  result.エラー数 = result.エラー.length;
  result.判定 = result.エラー数 ? "FAIL" : "PASS";
  return result;
}
