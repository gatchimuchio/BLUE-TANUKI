import test from 'node:test';
import assert from 'node:assert/strict';
import { loadQeBundle, validateQeBundle, validateQeRepository, parseUniqueJson, readQeInstruction, QE_FILES, QE_PINS, sha256 } from '../check_qe_jsonl.mjs';
const input=loadQeBundle();const copy=()=>({...input,parts:[...input.parts],documents:{...input.documents},activeNames:[...input.activeNames]});
test('現行五点・旧版履歴・全原文・要求照合・権限境界',()=>{const r=validateQeRepository();assert.equal(r.判定,'PASS',JSON.stringify(r.エラー.slice(0,15)));assert.equal(r.記録数,5645);assert.equal(r.旧版検査,'PASS')});
test('05分割を連結して原本byteを取得する',()=>assert.equal(sha256(readQeInstruction().toString('utf8')),QE_PINS[QE_FILES.指示].SHA256));
test('JSON重複keyを拒否',()=>assert.throws(()=>parseUniqueJson('{"識別":"a","識別":"b"}'),/重複key/));
const mutations=[['分割順',x=>{[x.parts[0],x.parts[1]]=[x.parts[1],x.parts[0]]}],['要求原文欠落',x=>{x.documents[QE_FILES.要求]=x.documents[QE_FILES.要求].split('\n').slice(1).join('\n')}],['要領停止境界改変',x=>{x.agents=x.agents.replace('本repoの当該作業・許否・保護・停止・復旧を扱う','現在Permissionが成立する')}],['採用完成境界改変',x=>{x.adoption=x.adoption.replace('製品完成そのものの必要条件ではない','製品完成そのものの必要条件である')}],['旧原記録欠落',x=>{x.oldInstruction=x.oldInstruction.split('\n').slice(1).join('\n')}],['現行異版混入',x=>{x.activeNames.push('old.jsonl')}],['起動核改変',x=>{x.kernel=x.kernel.replace('8.0案','8.1案')}]];
for(const [name,mutate] of mutations)test('反例: '+name,()=>{const x=copy();mutate(x);assert.equal(validateQeBundle(x).判定,'FAIL')});
