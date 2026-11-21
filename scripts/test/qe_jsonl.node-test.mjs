import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QE_DIRECTORY, QE_FILES, QE_PINS, QE_ADOPTION_PATH, QE_HISTORY_DIRECTORY, QE_HISTORY_PINS,
  parseUniqueJson, sha256, validateQeInstruction, validateQeBundle, validateQeRepository,
} from "../check_qe_jsonl.mjs";

// node:test専用。Vitestの*.test.mjsには混ぜず、node --testで明示実行する。
// 全反例はmemory内だけで変更し、製品source/正本/採用記録を変更しない。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = rel => fs.readFileSync(path.join(root, rel));
const documents = Object.fromEntries(Object.values(QE_FILES).map(name => [name, read(QE_DIRECTORY + "/" + name)]));
const raw = documents[QE_FILES.指示];
const rows = raw.toString("utf8").trimEnd().split("\n").map(parseUniqueJson);
const encode = value => Buffer.from(value.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
const json = value => Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
const mutateOne = (identity, change) => {
  const copy = structuredClone(rows);
  const row = copy.find(item => item.識別 === identity);
  assert.ok(row, "試験対象IDが実在する");
  change(row);
  return encode(copy);
};
const assertFailure = (result, expected) => {
  assert.equal(result.判定, "FAIL");
  assert.ok(result.エラー数 > 0);
  assert.ok(result.エラー.some(item => item.検査.includes(expected)), "固有の失敗を検出: " + expected + "\n" + JSON.stringify(result.エラー.slice(0, 12)));
};
const bundle = () => ({
  documents: { ...documents },
  manifest: read(QE_DIRECTORY + "/MANIFEST.json"),
  pointer: read("docs/QE_CURRENT_AUTHORITY.md").toString("utf8"),
  adoption: read(QE_ADOPTION_PATH),
  agents: read("AGENTS.md"),
  history: Object.fromEntries(Object.keys(QE_HISTORY_PINS).map(name => [name, read(QE_HISTORY_DIRECTORY + "/" + name)])),
  activeNames: fs.readdirSync(path.join(root, QE_DIRECTORY)),
});
const mutateManifest = (input, change) => {
  const manifest = parseUniqueJson(input.manifest.toString("utf8"));
  change(manifest);
  input.manifest = json(manifest);
};
const mutateEvent = (input, change) => {
  const oldHash = sha256(input.adoption);
  const event = parseUniqueJson(input.adoption.toString("utf8"));
  change(event);
  input.adoption = json(event);
  // eventそのものの意味検査を試し、hash不一致だけの見かけ検出を避ける。
  mutateManifest(input, manifest => { manifest.採用記録.SHA256 = sha256(input.adoption); });
  input.pointer = input.pointer.replace(oldHash, sha256(input.adoption));
};
const mutateAgents = (input, change) => {
  const agents = input.agents.toString("utf8").trimEnd().split("\n").map(parseUniqueJson);
  change(agents);
  input.agents = encode(agents);
  const pin = { パス: "AGENTS.md", 版: "7.0", SHA256: sha256(input.agents), バイト数: input.agents.length };
  mutateManifest(input, manifest => { manifest.要領 = pin; });
  mutateEvent(input, event => { event.要領 = pin; });
};

test("確定三点のraw固定SHAと再符号化無改変対照が一致する", () => {
  for (const [name, bytes] of Object.entries(documents)) {
    assert.equal(sha256(bytes), QE_PINS[name].SHA256);
    assert.equal(bytes.length, QE_PINS[name].バイト数);
  }
  assert.deepEqual(encode(rows), raw);
});

test("本文は全3496行/313操作/656QC/43579参照を照合してPASSする", () => {
  const result = validateQeInstruction(raw, documents);
  assert.equal(result.判定, "PASS", JSON.stringify(result.エラー));
  assert.equal(result.記録数, 3496);
  assert.equal(result.親固有操作数, 313);
  assert.equal(result.母集団.局所QC + result.母集団.親QC, 656);
  assert.equal(Object.values(result.参照辺).reduce((a, b) => a + b, 0), 43579);
  assert.equal(result.固定上位再現.reduce((n, item) => n + item.記録数, 0), 2063);
});

test("実repoのpointer/manifest/採用event/三点を一体検査する", () => {
  const result = validateQeRepository(root);
  assert.equal(result.判定, "PASS", JSON.stringify(result.エラー));
  assert.equal(result.本文検査.判定, "PASS");
});

const firstRequirement = rows.find(row => row.識別.startsWith("仕様/要求/")).識別;
const firstParentQc = rows.find(row => row.識別.startsWith("工程/QC/BT-T-")).識別;
const firstDetail = rows.find(row => row.識別.startsWith("指示/詳細適用/")).識別;
const oldMutations = [
  ["要求本文欠落", () => encode(rows.filter(row => row.識別 !== firstRequirement)), "母集団件数:要求"],
  ["QC固有期待改変", () => mutateOne(firstParentQc, row => { row.契約.期待される観測 = "改変された期待"; }), "上位原本bytes再現"],
  ["未解決意味参照", () => mutateOne("指示/共通操作", row => row.意味参照.push("不存在/参照")), "同一指示書内参照解決"],
  ["重複識別", () => encode([...rows, rows[0]]), "識別一意"],
  ["未知外側欄", () => mutateOne("指示/起動", row => { row.未定義外側欄 = "不適合"; }), "外側欄定義済み"],
  ["条件空配列", () => mutateOne("指示/起動", row => { row.適用条件 = { 全て: [] }; }), "条件式"],
  ["停止規則のPermission従属", () => mutateOne("指示/停止復旧", row => { row.適用条件 = { 判定: "現在Permissionが成立する" }; }), "拒否停止の適用を新規作用許可に従属させない"],
  ["上位pinすり替え", () => mutateOne("指示/宣言", row => { row.契約.上位固定[0].SHA256 = "0".repeat(64); }), "宣言と二pin一致"],
  ["対象型誤適用", () => mutateOne("指示/索引/A01.01", row => { row.契約.対象種別 = "実運転・状態・作用"; }), "索引型一致"],
  ["局所負例QC脱落", () => mutateOne("指示/索引/A01.01", row => { row.検証参照 = row.検証参照.filter(id => id !== "工程/QC/BT-U-A01.01-N"); }), "索引正負親QC一致:A01.01"],
  ["旧区画未対応", () => encode(rows.filter(row => row.識別 !== "指示/履歴対応/36")), "母集団件数:旧区画対応"],
  ["親生成接続欠落", () => mutateOne("指示/親操作/A01", row => { delete row.契約.操作[0].生成接続; }), "親操作5欄有意味"],
  ["詳細関連親欠落", () => mutateOne(firstDetail, row => { row.契約.関連親 = []; }), "詳細関連親全数:"],
];
for (const [name, mutated, label] of oldMutations) {
  test("旧独立検証器から継承した反例: " + name, () => assertFailure(validateQeInstruction(mutated()), label));
}

test("同じJSON object内のkey重複をescape復号後にも拒否する", () => {
  assert.throws(() => parseUniqueJson('{"a":1,"a":2}'), /重複key/u);
  assert.throws(() => parseUniqueJson('{"a":1,"\\u0061":2}'), /重複key/u);
  assert.throws(() => parseUniqueJson('{"x":[{"a":1,"a":2}]}'), /重複key/u);
  assert.deepEqual(parseUniqueJson('{"a":1,"x":{"a":2}}'), { a: 1, x: { a: 2 } });
  assert.deepEqual(parseUniqueJson('{"文":"括弧 } と引用符 \\" を含む","配列":[1,{"正":2}]}'), { 文: '括弧 } と引用符 " を含む', 配列: [1, { 正: 2 }] });
});
test("本文JSONLの重複keyを後勝ちで受理しない", () => {
  const changed = raw.toString("utf8").replace('"識別":', '"識別":"差替え","識別":');
  assertFailure(validateQeInstruction(Buffer.from(changed)), "JSONL構文");
});
for (const [name, data, label] of [
  ["UTF8破損", () => Buffer.concat([Buffer.from([0xff]), raw]), "UTF8"],
  ["BOM", () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]), "UTF8 BOMなし"],
  ["CRLF", () => Buffer.from(raw.toString("utf8").replace(/\n/gu, "\r\n")), "LFのみ"],
  ["末尾LFなし", () => raw.subarray(0, raw.length - 1), "末尾LF"],
  ["空行", () => Buffer.concat([raw, Buffer.from("\n")]), "空行なし"],
]) test("形式破損を検出: " + name, () => assertFailure(validateQeInstruction(data()), label));

for (const [name, value] of [["真偽値", true], ["null", null], ["空文字", ""], ["空object", {}]]) {
  test("本文禁止値を検出: " + name, () => {
    const changed = mutateOne("指示/起動", row => { row.契約.検査用 = value; });
    assertFailure(validateQeInstruction(changed), name === "空object" ? "空objectなし" : "禁止空値/真偽値");
  });
}
test("意味参照循環を工程の正常な帰還と混同せず検出する", () => {
  const changed = mutateOne("指示/共通操作", row => row.意味参照.push("指示/共通操作"));
  assertFailure(validateQeInstruction(changed), "意味参照循環");
});

const bundleMutations = [
  ["manifest旧版", input => mutateManifest(input, m => { m.版 = "6.1"; }), "manifest現行版7.0"],
  ["manifest三点役割すり替え", input => mutateManifest(input, m => { m.三点.仕様 = QE_FILES.工程; }), "manifest三点役割固定"],
  ["manifest不足", input => mutateManifest(input, m => { delete m.文書[QE_FILES.工程]; }), "manifest三点ちょうど"],
  ["manifest記録数改変", input => mutateManifest(input, m => { m.文書[QE_FILES.指示].記録数 = 1; }), "manifest固定記録数"],
  ["manifest母集団縮減", input => mutateManifest(input, m => { m.母集団.局所QC = 395; }), "manifest固定母集団"],
  ["現行に旧JSON混在", input => input.activeNames.push("03_旧rev6.json"), "現行三点以外の混在なし"],
  ["現行に余分JSONL混在", input => input.activeNames.push("03_別rev7.jsonl"), "現行三点以外の混在なし"],
  ["現行ファイル不足", input => { delete input.documents[QE_FILES.仕様]; }, "現行三点実体存在"],
  ["pointer他版link", input => { input.pointer = input.pointer.replace("](qe/現行/" + QE_FILES.仕様 + ")", "](qe/履歴/誤った旧版.json)"); }, "pointer実体/hash同一行束縛"],
  ["pointerにhashだけ残す", input => { input.pointer = input.pointer.replace(QE_PINS[QE_FILES.仕様].SHA256, "誤hash") + "\n" + QE_PINS[QE_FILES.仕様].SHA256; }, "pointer実体/hash同一行束縛"],
  ["pointer採用導線欠落", input => { input.pointer = input.pointer.replace("](qe/採用記録/2026-11-21-rev7.0.json)", "](存在しない採用記録.json)"); }, "pointer採用event導線"],
  ["採用event改変", input => { input.adoption = Buffer.concat([input.adoption, Buffer.from(" ")]); }, "採用event rawSHA一致"],
  ["採用event識別すり替え", input => mutateEvent(input, event => { event.識別 = "別の採用"; }), "採用event識別"],
  ["整合hashで採用対象仕様SHAをすり替え", input => mutateEvent(input, event => { event.採用対象[QE_FILES.仕様].SHA256 = "0".repeat(64); }), "採用対象三点全pin"],
  ["整合hashで採用repoを別製品へ変更", input => mutateEvent(input, event => { event.対象repo = "別owner/別製品"; }), "採用event主体/repo"],
  ["AGENTSを空byteへ変更", input => { input.agents = Buffer.alloc(0); }, "要領rawSHA/byte一致"],
  ["整合hashでowner原文をすり替え", input => mutateEvent(input, event => { event.原文 = "出荷GO"; }), "採用owner原文不変"],
  ["整合hashで採用を出荷GOへ変更", input => mutateEvent(input, event => { event.効力.保証 = "この採用を製品GOとする"; }), "採用効力境界:保証"],
  ["整合hashで既存委任を無条件取消", input => mutateEvent(input, event => { event.効力.既存委任 = "旧委任はすべて無効"; }), "採用効力境界:既存委任"],
  ["整合hashで非対象を縮減", input => mutateEvent(input, event => { event.非対象 = []; }), "採用非対象の全保持"],
  ["整合hashで現在Permissionも過去扱い", input => mutateEvent(input, event => { event.読取.現在も適用 = []; }), "採用後も有効な条件"],
  ["旧履歴の消去", input => { delete input.history["AGENTS.rev6.md"]; }, "旧版原bytes保存"],
  ["旧履歴の書換え", input => { input.history["MANIFEST.json"] = Buffer.from("{}\n"); }, "旧版原bytes保存"],
  ["整合hashでも要領の未閉包参照拒否", input => mutateAgents(input, agents => { agents[1].意味参照.push("不存在/要領参照"); }), "要領参照閉包"],
  ["整合hashでも要領の上位接続脱落拒否", input => mutateAgents(input, agents => { agents.find(row => row.識別 === "要領/五OS").意味参照 = []; }), "要領の上位意味接続"],
  ["整合hashでも要領の停止適用従属拒否", input => mutateAgents(input, agents => { agents.find(row => row.識別 === "要領/独立停止").適用条件 = { 判定: "現在Permissionが成立する" }; }), "要領拒否停止の独立適用"],
  ["採用参照path逸脱", input => mutateManifest(input, m => { m.採用記録.パス = "../別repo/event.json"; }), "採用event固定参照"],
  ["rawとmanifest同時すり替え", input => {
    input.documents[QE_FILES.仕様] = Buffer.concat([input.documents[QE_FILES.仕様], Buffer.from("\n")]);
    mutateManifest(input, m => { m.文書[QE_FILES.仕様].SHA256 = sha256(input.documents[QE_FILES.仕様]); m.文書[QE_FILES.仕様].バイト数 = input.documents[QE_FILES.仕様].length; });
  }, "三点固定rawSHA/byte"],
];
for (const [name, change, label] of bundleMutations) {
  test("現行採用導線の反例: " + name, () => {
    const input = bundle();
    change(input);
    assertFailure(validateQeBundle(input), label);
  });
}
