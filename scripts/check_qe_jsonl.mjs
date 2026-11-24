import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateQeBundle as validateRev7Bundle, QE_FILES as OLD_FILES, QE_HISTORY_DIRECTORY as OLD_HISTORY, QE_HISTORY_PINS as OLD_HISTORY_PINS, QE_ADOPTION_PATH as OLD_ADOPTION_PATH } from './check_qe_rev7_history.mjs';
export const QE_DIRECTORY = "docs/qe/現行";
export const QE_FILES = Object.freeze({
  "要求": "01_BLUE-TANUKI_要求仕様書_rev8_0_案_日本語JSONL.jsonl",
  "設計": "02_BLUE-TANUKI_設計仕様書_rev8_0_案_日本語JSONL.jsonl",
  "実装": "03_BLUE-TANUKI_開発実装工程表_rev8_0_案_日本語JSONL.jsonl",
  "品質": "04_BLUE-TANUKI_品質工程表_rev8_0_案_日本語JSONL.jsonl",
  "指示": "05_BLUE-TANUKI_Codex全域施工指示書_rev8_0_案_日本語JSONL.jsonl"
});
export const QE_PINS = Object.freeze({
  "01_BLUE-TANUKI_要求仕様書_rev8_0_案_日本語JSONL.jsonl": {
    "SHA256": "920ccf5ee820a5026f8d48a0782df20b962c7919c6ae1efbbbf1fb4e56202a89",
    "バイト数": 880247,
    "記録数": 654,
    "形式": "日本語基底JSONL/UTF-8/BOMなし/LF"
  },
  "02_BLUE-TANUKI_設計仕様書_rev8_0_案_日本語JSONL.jsonl": {
    "SHA256": "dc8d7658d4a3e8970b6731d850e0426f6a10857e354b433fe3131266b51cbb84",
    "バイト数": 717348,
    "記録数": 494,
    "形式": "日本語基底JSONL/UTF-8/BOMなし/LF"
  },
  "03_BLUE-TANUKI_開発実装工程表_rev8_0_案_日本語JSONL.jsonl": {
    "SHA256": "cc754e531bd8270dd20ad21d2acbae8cdf98509f34b41b86a4046d9003288bdf",
    "バイト数": 2720446,
    "記録数": 1235,
    "形式": "日本語基底JSONL/UTF-8/BOMなし/LF"
  },
  "04_BLUE-TANUKI_品質工程表_rev8_0_案_日本語JSONL.jsonl": {
    "SHA256": "39e233ae3377cadcb87d52ececcba5a66f934a5bf53ec5338d8b2f0cf172fed6",
    "バイト数": 2364048,
    "記録数": 1329,
    "形式": "日本語基底JSONL/UTF-8/BOMなし/LF"
  },
  "05_BLUE-TANUKI_Codex全域施工指示書_rev8_0_案_日本語JSONL.jsonl": {
    "SHA256": "24e57d152843c3bdd7e75a0c98e676c27815f384340d928c5d2dc957238bea3b",
    "バイト数": 10645410,
    "記録数": 5645,
    "形式": "日本語基底JSONL/UTF-8/BOMなし/LF",
    "保存方式": "生JSONL連続6分割・順序連結で原本byte同一",
    "分割": [
      {
        "パス": "05_BLUE-TANUKI_Codex全域施工指示書_rev8_0_案_日本語JSONL.jsonl.parts/0001-1000.jsonl",
        "SHA256": "363cc8eb1b821c4f2917cc27bb1bb0c963afa9a531449b8ac77d3c0440a328c2",
        "バイト数": 2424413,
        "記録数": 1000
      },
      {
        "パス": "05_BLUE-TANUKI_Codex全域施工指示書_rev8_0_案_日本語JSONL.jsonl.parts/1001-2000.jsonl",
        "SHA256": "4483ed34246f900fc37a175b1ece3cbbee13629ac9b6caaecc66d73bcdc409d7",
        "バイト数": 1625587,
        "記録数": 1000
      },
      {
        "パス": "05_BLUE-TANUKI_Codex全域施工指示書_rev8_0_案_日本語JSONL.jsonl.parts/2001-3000.jsonl",
        "SHA256": "0c38dc930f856a7fdbe6b36ac08a19bdb34f1e51b4623d84588500bc15a336cd",
        "バイト数": 1322554,
        "記録数": 1000
      },
      {
        "パス": "05_BLUE-TANUKI_Codex全域施工指示書_rev8_0_案_日本語JSONL.jsonl.parts/3001-4000.jsonl",
        "SHA256": "7023fbbe2f10cf21a8a293fac50b90f6903b5a471e0e056dd4a7c0ae079bff6a",
        "バイト数": 2209669,
        "記録数": 1000
      },
      {
        "パス": "05_BLUE-TANUKI_Codex全域施工指示書_rev8_0_案_日本語JSONL.jsonl.parts/4001-5000.jsonl",
        "SHA256": "4d5a2e02972203d9db942d9220792ad3ca7e37e4d409da010eeaaa176b564354",
        "バイト数": 1829072,
        "記録数": 1000
      },
      {
        "パス": "05_BLUE-TANUKI_Codex全域施工指示書_rev8_0_案_日本語JSONL.jsonl.parts/5001-5645.jsonl",
        "SHA256": "72ccd0437bfdc82040153d5c9d4262d814e2414ac58b94d61c62a9aab7bef631",
        "バイト数": 1234115,
        "記録数": 645
      }
    ]
  }
});
export const QE_KERNEL = Object.freeze({
  "ファイル": "00_BLUE-TANUKI_Codex起動操作核_rev8_0_案_日本語JSONL.jsonl",
  "SHA256": "1a72bf0aca9edeef957354751faab147e9d36f88c2d1932a3fd4dde8c9029dfd",
  "バイト数": 31959,
  "記録数": 34,
  "効力": "05先頭34行の同値投影、独立の施工規範ではない"
});
export const QE_AGENT_PIN = Object.freeze({
  "パス": "AGENTS.md",
  "版": "8.0",
  "SHA256": "44d4a7ded688dd177490bfafbe93b559928d629d993ee2aa941639a0f7f2bf5e",
  "バイト数": 32510,
  "記録数": 25
});
export const QE_EVENT_PIN = Object.freeze({
  "識別": "BT-QE-ADOPT-20261125-REV8",
  "パス": "docs/qe/採用記録/2026-11-25-rev8.0.json",
  "SHA256": "ce65654e65eb5a96a82ced65adab15839f01d1673aa3b299a6c85fb0ef5ccdac",
  "バイト数": 7718
});
export const QE_POPULATION = Object.freeze({
  "要求": 431,
  "親成果": 65,
  "施工索引": 198,
  "詳細条項": 63,
  "不変契約": 34,
  "親QC": 260,
  "局所QC": 396,
  "競合能力基準": 61,
  "対象OS": 5,
  "親固有操作": 313,
  "上位要求": 19,
  "変更影響": 20,
  "検査入口": 12,
  "既知故障": 43,
  "旧欠陥": 6,
  "継承原記録": 3496,
  "同梱標準": 276,
  "上位四文書記録": 3712
});
export const QE_PRIOR = Object.freeze({
  "版": "7.0",
  "目録": "docs/qe/履歴/rev7.0/MANIFEST.json",
  "SHA256": "11c5c248c9154f2d92b919f0eab7fa272b2faffc2ebc0815e4efcf868505be6d",
  "採用記録": "docs/qe/採用記録/2026-11-21-rev7.0.json",
  "基点": "46b9b5f8b15963b9d2288cdfabc49cb0dbfb58bc"
});
export const QE_MANIFEST_PIN = Object.freeze({
  "SHA256": "cd7877e10ea3294615e050be692bb1ef7195ba38bf55f5bd8b244be4576545e8",
  "バイト数": 5786
});
export const QE_ADOPTION_PATH = "docs/qe/採用記録/2026-11-25-rev8.0.json";
export const OLD_PIN = Object.freeze({
  "SHA256": "0db1a52e6738fd05f952cb4f94e952c773dcf579e4371410fc9b82e22853ed8c",
  "バイト数": 4974613,
  "記録数": 3496
});
export const OLD_INSTRUCTION = "docs/qe/履歴/rev7.0/03_BLUE-TANUKI_Codex全域施工指示書_rev7_0_日本語基底.jsonl";
export const AGENT_IDS = Object.freeze([
  "要領/宣言",
  "要領/責任",
  "要領/採用",
  "要領/受領",
  "要領/作業単位",
  "要領/分担",
  "要領/全域工程",
  "要領/限定確認",
  "要領/品質帰還",
  "要領/状態証拠",
  "要領/権限",
  "要領/原子性",
  "要領/独立停止",
  "要領/復旧",
  "要領/秘密",
  "要領/保持終了",
  "要領/境界維持",
  "要領/拡張",
  "要領/五OS",
  "要領/中断範囲",
  "要領/環境",
  "要領/CI",
  "要領/Git",
  "要領/日本語",
  "要領/完了"
]);
export const sha256 = s => createHash('sha256').update(s, 'utf8').digest('hex');
const byteLength = s => Buffer.byteLength(s, 'utf8');
export function parseUniqueJson(s){
 const obj=JSON.parse(s);let i=0;const ws=()=>{while(i<s.length&&/\s/.test(s[i]))i++};const str=()=>{const start=i++;while(i<s.length){if(s[i]==="\\"){i+=2;continue}if(s[i++]==='"')return JSON.parse(s.slice(start,i))}throw Error("文字列終端")};
 const visit=()=>{ws();if(s[i]==="{"){i++;ws();const keys=new Set();if(s[i]==="}"){i++;return}for(;;){ws();const key=str();if(keys.has(key))throw Error("重複key: "+key);keys.add(key);ws();i++;visit();ws();if(s[i++]==="}")return}}else if(s[i]==="["){i++;ws();if(s[i]==="]"){i++;return}for(;;){visit();ws();if(s[i++]==="]")return}}else if(s[i]==='"')str();else while(i<s.length&&!/[\s,\]}]/.test(s[i]))i++};
 visit();return obj;
}
function canonical(x){if(Array.isArray(x))return x.map(canonical);if(x!==null&&typeof x==="object")return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));return x}
function equal(a,b){return JSON.stringify(canonical(a))===JSON.stringify(canonical(b))}
export function validateQeBundle(input){
 const errors=[];let checks=0;const check=(ok,label,detail="")=>{checks++;if(!ok)errors.push({検査:label,内容:typeof detail==="string"?detail:JSON.stringify(detail)})};
 const obj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
 const parse=(s,label)=>{try{const x=parseUniqueJson(s);check(obj(x),label+" object");return obj(x)?x:{}}catch(e){check(false,label+" JSON",e.message);return {}}};
 const same=(a,b,label,detail="")=>check(equal(a,b),label,detail);
 const set=(a,b,label)=>check(Array.isArray(a)&&Array.isArray(b)&&new Set(a).size===a.length&&new Set(b).size===b.length&&a.length===b.length&&a.every(x=>b.includes(x)),label);
 const raw=(s,p,label)=>{const ok=typeof s==="string";check(ok,label+" 実体");if(!ok)return "";check(!s.startsWith("\ufeff")&&!s.includes("\r")&&s.endsWith("\n"),label+" UTF8/BOMなし/LF");check(byteLength(s)===p.バイト数&&sha256(s)===p.SHA256,label+" 固定SHA/byte");return s};
 const lines=(s,label,n)=>{const a=[],raws=s.endsWith("\n")?s.slice(0,-1).split("\n"):s.split("\n"),seen=new Set();for(const [i,l] of raws.entries()){try{const z=parseUniqueJson(l);if(!obj(z)||typeof z.識別!=="string"||!z.識別||seen.has(z.識別))throw Error("識別欠落/重複又はobject不正");seen.add(z.識別);a.push(z)}catch(e){check(false,label+" JSONL/識別",`${i+1}:${e.message}`)}}check(a.length===n,label+" 記録数");return {rows:a,raws}};
 const manifest=parse(raw(input.manifest,QE_MANIFEST_PIN,"manifest"),"manifest");
 same(manifest.五点,QE_FILES,"五点の役割");same(manifest.文書,QE_PINS,"固定文書pin");same(manifest.起動操作核,QE_KERNEL,"起動核pin");same(manifest.要領,QE_AGENT_PIN,"要領pin");same(manifest.採用記録,QE_EVENT_PIN,"採用pin");same(manifest.母集団,QE_POPULATION,"固定母集団");same(manifest.前版,QE_PRIOR,"旧版系譜");check(manifest.版==="8.0","採用版");
 set(input.activeNames,["MANIFEST.json",QE_KERNEL.ファイル,...Object.values(QE_FILES).filter(x=>x!==QE_FILES.指示),QE_FILES.指示+".parts"],"現行一組のみ");
 const partPins=QE_PINS[QE_FILES.指示].分割;set(input.partNames,partPins.map(x=>x.パス.split("/").at(-1)),"原文分割全数");
 check(input.parts?.length===partPins.length,"分割数");
 const pieces=partPins.map((p,i)=>raw(input.parts?.[i],p,"05分割 "+p.パス));for(let i=0;i<pieces.length;i++)check(pieces[i].split("\n").length-1===partPins[i].記録数,"05分割行数",partPins[i].パス);
 const full=raw(pieces.join(""),QE_PINS[QE_FILES.指示],"05原本"),body=lines(full,"05原本",QE_PINS[QE_FILES.指示].記録数),rows=body.rows,by=new Map(rows.map(x=>[x.識別,x]));
 for(const [role,name] of Object.entries(QE_FILES)){if(role==="指示")continue;const s=raw(input.documents?.[name],QE_PINS[name],role),d=lines(s,role,QE_PINS[name].記録数);check(d.rows.every(x=>x.識別.startsWith(role+"/")),role+" 名前空間");const embedded=body.raws.filter((l,i)=>rows[i]?.識別.startsWith(role+"/")).join("\n")+"\n";check(embedded===s,role+" 内包原本byte一致");check(by.has(role+"/宣言"),role+" 宣言");}
 const kernel=raw(input.kernel,QE_KERNEL,"00起動操作核");lines(kernel,"00起動操作核",QE_KERNEL.記録数);check(kernel===body.raws.slice(0,QE_KERNEL.記録数).join("\n")+"\n","00は05冒頭同値投影");
 const declaration=by.get("指示/宣言");check(declaration?.版==="8.0案","原文候補表記保持");for(const entry of declaration?.上位四文書??[]){const p=QE_PINS[entry.文書];check(p?.SHA256===entry.SHA256&&p?.記録数===entry.行数&&p?.バイト数===entry.バイト,"宣言四文書pin",entry.文書)}check(declaration?.上位四文書?.length===4,"四文書宣言全数");
 const old=lines(raw(input.oldInstruction,OLD_PIN,"旧rev7指示書"),"旧rev7指示書",OLD_PIN.記録数),oldBy=new Map(old.rows.map(x=>[x.識別,x]));const legacy=rows.filter(x=>x.種類==="原記録保持");const alias=new Map(legacy.map(x=>[x.元識別,x]));check(legacy.length===3496&&alias.size===3496,"3496原記録全数一意");for(const x of old.rows)check(equal(alias.get(x.識別)?.原記録,x),"rev7原記録object一致",x.識別);
 const std=rows.filter(x=>x.種類==="同梱標準保持");check(std.length===276,"二標準全数");for(const d of declaration?.標準同梱??[]){const kind=d.文書.startsWith("自然言語コード")?"自然言語コード":"暗黙処理";const ss=std.filter(x=>x.標準===kind);check(ss.length===d.記録&&new Set(ss.map(x=>x.原識別)).size===ss.length,"標準記録全数",kind);const r=ss.map(x=>JSON.stringify(x.標準記録)).join("\n")+"\n";check(sha256(r)===d.SHA256&&byteLength(r)===d.バイト,"標準原文再現",kind)}
 const groups=[["親別施工操作","親","仕様/親/",65],["実装索引操作","原索引","工程/施工索引/",198],["要求別実現操作","原要求ID","仕様/要求/",431],["詳細横断操作","条項ID","仕様/詳細/",63],["全域不変確認","不変ID","仕様/不変/",34],["競合比較操作","比較ID","仕様/比較/",61],["固有品質ケース","ケースID","工程/QC/BT-",656],["OS固有施工操作","OS","仕様/OS/",5]];
 const kind=k=>rows.filter(x=>x.種類===k);
 for(const [k,key,pre,n] of groups){const a=kind(k);check(a.length===n,k+" 母集団");const ids=old.rows.filter(x=>x.識別.startsWith(pre)).map(x=>x.識別.split("/").at(-1));set(a.map(x=>x[key]),ids,k+" 原識別全数");}
 const get=id=>oldBy.get(id);
 for(const z of kind("要求別実現操作")){const x=get("仕様/要求/"+z.原要求ID);check(!!x&&z.固有成立規定===x.規定&&z.規範強度===x.規範強度&&equal(z.適用条件,x.適用条件)&&equal(z.固有契約,x.契約)&&z.親===x.契約?.親,"要求固有成立/条件",z.識別);}
 for(const z of kind("固有品質ケース")){const x=get("工程/QC/"+z.ケースID)?.契約;check(!!x&&z.前提入力===x.入力&&z.実行方法===x.実行&&z.合格期待===x.期待される観測&&z.工程===x.実施工程&&z.親===x.親&&z.対象種別===x.対象種別,"QC固有入力/実行/期待",z.識別);}
 check(kind("固有品質ケース").filter(x=>x.工程==="P5").length===396&&kind("固有品質ケース").filter(x=>x.工程==="P6").length===260,"P5/P6品質母集団");
 for(const z of kind("親別施工操作")){const x=get("指示/親操作/"+z.親)?.契約;check(equal(x,z.固有操作)&&Array.isArray(z.固有操作?.操作),"親固有操作本文",z.識別);check(by.has("設計/親設計/"+z.親)&&by.has("実装/親/"+z.親),"親設計実装追跡",z.識別);}
 check(kind("親別施工操作").reduce((n,z)=>n+(z.固有操作?.操作?.length??0),0)===313,"313親固有操作");
 for(const z of kind("実装索引操作")){const x=get("工程/施工索引/"+z.原索引)?.契約;check(!!x&&equal(z.個別要求,x.要求ID)&&z.固有成立===x.局所成立条件&&z.固有拒否===x.拒否条件,"索引固有要求/成立/拒否",z.識別)}
 for(const z of kind("詳細横断操作")){const x=get("仕様/詳細/"+z.条項ID);check(!!x&&z.成立規定===x.規定&&z.固有成立===x.契約.成立判定&&z.固有拒否===x.契約.拒否&&equal(z.関連親,x.契約.関連親),"詳細固有成立/拒否/親",z.識別)}
 for(const z of kind("全域不変確認")){const x=get("仕様/不変/"+z.不変ID);check(!!x&&z.固定規定===x.規定&&z.規範強度===x.規範強度&&equal(z.適用条件,x.適用条件),"不変契約",z.識別)}
 for(const z of kind("競合比較操作")){const x=get("仕様/比較/"+z.比較ID);check(!!x&&z.要求規定===x.規定&&z.規範強度===x.規範強度,"比較固有規定",z.識別)}
 for(const z of kind("OS固有施工操作")){const x=get("指示/OS操作/"+z.OS)?.契約;check(!!x&&equal(z.個別操作,x.操作)&&equal(z.保証媒体,x.保証媒体)&&equal(z.保留境界,x.保留境界),"OS固有操作",z.識別)}
 for(const [k,n] of [["要求接続",19],["工程実行",10],["変更影響起動",20],["検査入口操作",12],["既知故障回避操作",43],["時点別不一致の照合",6],["設計追跡",65],["施工対象",65]])check(kind(k).length===n,k+" 全数");
 const explicit=rows.filter(x=>x.識別.startsWith("指示/"));let refCount=0;
 for(const x of explicit){for(const k of ["参照先","出典","根拠識別","関連上位要求","上位参照","source"]){for(const y of [x[k]].flat()){if(typeof y==="string"&&/^(指示|要求|設計|実装|品質|仕様|工程|読取|標準)\//.test(y)){refCount++;check(by.has(y)||alias.has(y),"施工明示参照閉包",x.識別+"→"+y)}}}}
 for(const x of old.rows)for(const k of ["意味参照","構成参照","対応参照","検証参照","根拠参照","来歴参照","参考参照"])for(const y of x[k]??[]){refCount++;check(oldBy.has(y),"継承参照閉包",x.識別+"→"+y)}
 const event=parse(raw(input.adoption,QE_EVENT_PIN,"採用記録"),"採用記録");
 check(event.識別===QE_EVENT_PIN.識別&&event.版==="8.0"&&event.主体==="owner"&&event.対象repo==="gatchimuchio/BLUE-TANUKI","採用主体/対象/版");
 same(event.採用対象,QE_PINS,"採用対象全pin");same(event.起動操作核,QE_KERNEL,"採用核pin");same(event.要領,QE_AGENT_PIN,"採用要領pin");
 check(event.原文==="リポをいじっていいから\n資料を更新しといて\nあとエージェントMDも更新して\nリポの整合性も整えといて","採用owner原文");check(event.効力?.完成?.includes("製品完成はowner原要求")&&event.効力?.完成?.includes("製品完成そのものの必要条件ではない")&&event.非対象?.includes("製品QC/QA合格や出荷GOの認定"),"要求完成/公開GO境界");
 const ag=lines(raw(input.agents,QE_AGENT_PIN,"AGENTS"),"AGENTS",QE_AGENT_PIN.記録数);set(ag.rows.map(x=>x.識別),AGENT_IDS,"要領全数");const agBy=new Map(ag.rows.map(x=>[x.識別,x]));check(agBy.get("要領/宣言")?.版==="8.0","要領版");
 for(const x of ag.rows){for(const y of x.意味参照??[]){refCount++;check(by.has(y)||agBy.has(y),"要領参照閉包",x.識別+"→"+y)}if(x.識別!=="要領/宣言")check(x.規範強度==="必須"&&x.適用条件?.判定==="本repoの当該作業・許否・保護・停止・復旧を扱う","要領独立拒否/停止",x.識別);}
 check(agBy.get("要領/完了")?.契約?.要求照合===event.効力?.完成,"要領完成境界一致");
 const pointer=input.pointer??"";check(pointer.includes("rev8.0")&&pointer.includes("五点一組")&&pointer.includes(QE_EVENT_PIN.SHA256)&&pointer.includes(QE_EVENT_PIN.識別),"正本入口採用束縛");
 for(const name of Object.values(QE_FILES)){const h=QE_PINS[name].SHA256;const p=name===QE_FILES.指示?name+".parts":name;check(pointer.split("\n").some(l=>l.includes("](qe/現行/"+p+")")&&l.includes(h)),"正本入口本文pin",name)}
 check(pointer.includes(QE_KERNEL.SHA256)&&pointer.includes(event.効力?.完成??"\0"),"正本入口起動核/完成境界");
 return {判定:errors.length?"FAIL":"PASS",検査数:checks,エラー数:errors.length,エラー:errors,記録数:rows.length,参照検査数:refCount,母集団:QE_POPULATION,採用識別:QE_EVENT_PIN.識別};
}

export function loadQeBundle(root = process.cwd()) {
 const readErrors=[];
 const read = rel => {try {const bytes=fs.readFileSync(path.join(root,rel));return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}catch(error){readErrors.push({検査:'repo入力読取/UTF8',内容:rel+':'+error.message});return ''}};
 const names=rel=>{try{return fs.readdirSync(path.join(root,rel))}catch(error){readErrors.push({検査:'directory読取',内容:rel+':'+error.message});return []}};
 return {manifest:read(QE_DIRECTORY+'/MANIFEST.json'),adoption:read(QE_ADOPTION_PATH),agents:read('AGENTS.md'),pointer:read('docs/QE_CURRENT_AUTHORITY.md'),documents:Object.fromEntries(Object.values(QE_FILES).filter(n=>n!==QE_FILES.指示).map(n=>[n,read(QE_DIRECTORY+'/'+n)])),parts:QE_PINS[QE_FILES.指示].分割.map(p=>read(QE_DIRECTORY+'/'+p.パス)),kernel:read(QE_DIRECTORY+'/'+QE_KERNEL.ファイル),oldInstruction:read(OLD_INSTRUCTION),activeNames:names(QE_DIRECTORY),partNames:names(QE_DIRECTORY+'/'+QE_FILES.指示+'.parts'),readErrors};
}
export function validateQeRepository(root=process.cwd()) {
 const input=loadQeBundle(root),result=validateQeBundle(input);
 result.エラー.push(...input.readErrors);
 // rev7固有の全原本・意味参照・旧版履歴・旧採用規則は、その版の独立検証器で保持する。
 try {
   const hist='docs/qe/履歴/rev7.0',read=rel=>fs.readFileSync(path.join(root,rel));
   const old=validateRev7Bundle({documents:Object.fromEntries(Object.values(OLD_FILES).map(n=>[n,read(hist+'/'+n)])),manifest:read(hist+'/MANIFEST.json'),pointer:read(hist+'/QE_CURRENT_AUTHORITY.rev7.md').toString('utf8'),adoption:read(OLD_ADOPTION_PATH),agents:read(hist+'/AGENTS.rev7.md'),history:Object.fromEntries(Object.keys(OLD_HISTORY_PINS).map(n=>[n,read(OLD_HISTORY+'/'+n)])),activeNames:fs.readdirSync(path.join(root,hist))});
   result.旧版検査=old.判定; result.検査数+=old.検査数??0;
   result.エラー.push(...old.エラー.map(x=>({検査:'rev7履歴/'+x.検査,内容:x.内容})));
 } catch(error) {result.エラー.push({検査:'rev7履歴読取',内容:error.message})}
 result.エラー数=result.エラー.length;result.判定=result.エラー数?'FAIL':'PASS';return result;
}
export function readQeInstruction(root=process.cwd()) {
 const p=QE_PINS[QE_FILES.指示],pieces=p.分割.map(x=>{const b=fs.readFileSync(path.join(root,QE_DIRECTORY,x.パス));if(b.length!==x.バイト数||createHash('sha256').update(b).digest('hex')!==x.SHA256)throw Error('分割SHA不一致 '+x.パス);return b});
 const b=Buffer.concat(pieces);if(b.length!==p.バイト数||createHash('sha256').update(b).digest('hex')!==p.SHA256)throw Error('05原本SHA不一致');return b;
}
