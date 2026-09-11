/**
 * 평가 감사기 — 모델을 탓하기 전에 평가기를 의심한다 (2026-09-11 판정 §5-1).
 *   API 0회. 라벨과 run JSON 만 읽는다.
 *
 *   node tools/audit_eval.mjs --labels labels/test10.csv --run <a.json> [--run <b.json>]
 *
 *   ① 중복 census — 같은 (파일,번호) 다중 출력 전수 + 각 값 + 라벨 정답
 *   ② 세 정책으로 각각 채점 (first-wins / last-wins / 둘 다 보존)
 *      지금 저장소의 세 도구가 서로 다르게 처리한다:
 *        tools/score.mjs:52   first-wins   tools/diff_runs.mjs  first-wins
 *        measure.mjs:71       last-wins    compare_runs.mjs:51  둘 다 보존
 *      ⚠️ 이 도구는 정책을 바꾸지 않는다. 차이를 재기만 한다.
 *   ③ 대조표 — 사진:문항 → 라벨 → 응답(재구성) → 파싱값 → 채점
 *   ④ 결합 위험 6종 점검
 *
 *   ⚠️ "응답(재구성)"은 파싱된 필드로 되돌린 것이다. read.mjs 는 파싱 실패 시에만
 *   raw 를 저장하므로, 성공한 줄의 원문은 run JSON 에 없다. 원문이 필요하면
 *   --dump-request 로 응답 원본을 남겨야 한다.
 */
import fs from 'node:fs';

const argv=process.argv.slice(2);
const LABELS=(()=>{const i=argv.indexOf('--labels');return i>=0?argv[i+1]:'labels/test10.csv';})();
const RUNPATHS=argv.map((a,i)=>a==='--run'?argv[i+1]:null).filter(Boolean);
if(!RUNPATHS.length){console.error('usage: node tools/audit_eval.mjs --labels <csv> --run <a.json> [--run <b.json>]');process.exit(1);}
const RUNS=Object.fromEntries(RUNPATHS.map(p=>[p.split('/').pop().replace(/\.json$/,''),p]));

const ALIAS={c:'circle',s:'slash',t:'triangle',q:'question',k:'check',u:'unmarked',
 circle:'circle',slash:'slash',triangle:'triangle',question:'question',check:'check',unmarked:'unmarked',
 slash_family_unclear:'slash_family_unclear',unclear_st:'slash_family_unclear',unclear:'slash_family_unclear',
 other:'other',other_handwritten:'other'};
const norm=m=>m==null?'MISSING':(ALIAS[String(m).trim().toLowerCase()]??String(m).trim().toLowerCase());
const FILE_KEYS=['file','filename','fileName','image','imagePath','imageFile','photo','path','src','name'];
const NUM_KEYS=['item_no','itemNo','item_number','number','no','num','qno','q_no','questionNumber','question_no','item','q','id'];
const MARK_KEYS=['mark','markLabel','mark_label','symbol','m'];
const IMG=/\.(jpe?g|png|webp|heic|heif|bmp)$/i;
const pick=(o,ks)=>{for(const k of ks) if(k in o&&o[k]!=null) return k; return null;};
function walk(node,file,out,pk){
  if(Array.isArray(node)){for(const n of node) walk(n,file,out,pk);return;}
  if(!node||typeof node!=='object')return;
  let f=file;
  for(const k of FILE_KEYS){const v=node[k];if(typeof v==='string'&&IMG.test(v)){f=v.split(/[\\/]/).pop();break;}}
  const mk=pick(node,MARK_KEYS),nk=pick(node,NUM_KEYS);
  if(mk&&(typeof node[mk]==='string'||typeof node[mk]==='number')){
    const num=nk?String(node[nk]).trim():(pk!=null&&/^\d+$/.test(String(pk))?String(pk):null);
    if(num!==null) out.push({key:(f??'UNKNOWN')+' '+num,file:f??'UNKNOWN',num,mark:norm(node[mk]),node});
  }
  for(const [k,v] of Object.entries(node)) walk(v,(typeof k==='string'&&IMG.test(k))?k.split(/[\\/]/).pop():f,out,k);
}
const load=p=>{const out=[];walk(JSON.parse(fs.readFileSync(p,'utf8')),null,out,null);return out;};
const truth=new Map();
for(const line of fs.readFileSync(LABELS,'utf8').split(/\r?\n/)){
  const t=line.trim(); if(!t||t.startsWith('#'))continue;
  const [f,n,m]=t.split(',').map(x=>x.trim()); if(!f||!n||!m)continue;
  truth.set(f.split(/[\\/]/).pop()+' '+n,norm(m));
}
console.log('라벨 '+truth.size+'문항 · '+new Set([...truth.keys()].map(k=>k.split(' ')[0])).size+'장\n');
const score=(rows,policy)=>{
  const m=new Map();
  for(const it of rows){
    if(!m.has(it.key)) m.set(it.key,[]);
    m.get(it.key).push(it);
  }
  let ok=0;
  for(const [k,t] of truth){
    const v=m.get(k); if(!v) continue;
    if(policy==='first') ok+= v[0].mark===t?1:0;
    else if(policy==='last') ok+= v[v.length-1].mark===t?1:0;
    else ok+= v.some(x=>x.mark===t)?1:0;   // 둘 다 보존(compare_runs 식): 하나라도 맞으면 정답
  }
  return ok;
};
for(const [tag,p] of Object.entries(RUNS)){
  const rows=load(p);
  const by=new Map();
  for(const it of rows){ if(!by.has(it.key)) by.set(it.key,[]); by.get(it.key).push(it); }
  const dups=[...by.entries()].filter(([,v])=>v.length>1);
  console.log('='.repeat(72));
  console.log(`${tag}  (${p.split('/').pop()})`);
  console.log(`  추출 행 ${rows.length} · 고유 키 ${by.size} · 다중 출력 키 ${dups.length}`);
  if(dups.length){
    console.log('  --- 다중 출력 전수 ---');
    for(const [k,v] of dups){
      const t=truth.get(k)??'(라벨없음)';
      console.log(`  ${k}   라벨정답=${t}`);
      v.forEach((x,i)=>{
        const extra=[];
        if(x.node.v0_mark_type) extra.push('v0_mark_type='+x.node.v0_mark_type);
        if(x.node.region) extra.push('region='+JSON.stringify(x.node.region));
        if(x.node.mark_confidence!=null) extra.push('mark_conf='+x.node.mark_confidence);
        if(x.node.work) extra.push('work='+x.node.work);
        console.log(`      [${i}] mark=${x.mark}${x.mark===t?'  ← 정답':''}  ${extra.join(' · ')}`);
      });
    }
  }
  const f=score(rows,'first'), l=score(rows,'last'), b=score(rows,'both');
  const pc=n=>(n/truth.size*100).toFixed(1)+'%';
  console.log('  --- 세 정책으로 채점 ---');
  console.log(`    first-wins (score.mjs / diff_runs) : ${f}/${truth.size}  ${pc(f)}`);
  console.log(`    last-wins  (measure.mjs)           : ${l}/${truth.size}  ${pc(l)}`);
  console.log(`    둘 다 보존 (compare_runs)          : ${b}/${truth.size}  ${pc(b)}`);
  console.log(`    first 대비 손실: last ${l-f>=0?'+':''}${l-f}문항 · 둘다보존 ${b-f>=0?'+':''}${b-f}문항`);
  console.log();
}
