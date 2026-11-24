import { readQeInstruction, parseUniqueJson } from './check_qe_jsonl.mjs';
// 原文の連続byteを取得するだけ。復号・置換・新しい規範の生成は行わない。
const args=process.argv.slice(2), raw=readQeInstruction();
if(args.length===0)process.stdout.write(raw);
else if(args.length===2&&args[0]==='--id') {const lines=raw.toString('utf8').trimEnd().split('\n');const matches=lines.filter(l=>{const r=parseUniqueJson(l);return r.識別===args[1]||r.元識別===args[1]});if(matches.length!==1)throw Error('識別が一意に解決しない '+args[1]);process.stdout.write(matches[0]+'\n')}
else throw Error('使用: node scripts/read_qe_instruction.mjs [--id 識別]');
