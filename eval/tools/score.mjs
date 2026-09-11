// eval/tools/score.mjs — 라벨 기준으로 run 을 채점한다. 이 프로젝트 최초의 정확도 계산.
// usage: node tools/score.mjs --labels labels/test10.csv --run runs/<v2>.json [--compare runs/<v0>.json]
// 출력: 콘솔 + results/score_<ts>.md
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const labelPath = arg('--labels'), runPath = arg('--run'), cmpPath = arg('--compare');
if (!labelPath || !runPath) {
  console.error('usage: node tools/score.mjs --labels <csv> --run <run.json> [--compare <run.json>]');
  process.exit(1);
}

const ALIAS = {
  c: 'circle', s: 'slash', t: 'triangle', q: 'question', k: 'check', u: 'unmarked',
  circle: 'circle', slash: 'slash', triangle: 'triangle', question: 'question', check: 'check', unmarked: 'unmarked',
  slash_family_unclear: 'slash_family_unclear', unclear_st: 'slash_family_unclear', unclear: 'slash_family_unclear',
  other: 'other', other_handwritten: 'other',
};
const MARKS = ['circle', 'slash', 'triangle', 'question', 'check', 'unmarked'];
const norm = (m) => { if (m == null) return 'MISSING'; const s = String(m).trim().toLowerCase(); return ALIAS[s] ?? s; };

const FILE_KEYS = ['file', 'filename', 'fileName', 'image', 'imagePath', 'imageFile', 'photo', 'path', 'src', 'name'];
const NUM_KEYS = ['item_no', 'itemNo', 'item_number', 'number', 'no', 'num', 'qno', 'q_no', 'questionNumber', 'question_no', 'item', 'q', 'id'];
const MARK_KEYS = ['mark', 'markLabel', 'mark_label', 'symbol', 'm'];
const IMG_RE = /\.(jpe?g|png|webp|heic|heif|bmp)$/i;
const pick = (o, keys) => { for (const k of keys) if (k in o && o[k] != null) return k; return null; };

function walk(node, file, out, parentKey) {
  if (Array.isArray(node)) { for (const n of node) walk(n, file, out, parentKey); return; }
  if (!node || typeof node !== 'object') return;
  let f = file;
  for (const k of FILE_KEYS) {
    const v = node[k];
    if (typeof v === 'string' && IMG_RE.test(v)) { f = v.split(/[\\/]/).pop(); break; }
  }
  const mk = pick(node, MARK_KEYS), nk = pick(node, NUM_KEYS);
  if (mk && (typeof node[mk] === 'string' || typeof node[mk] === 'number')) {
    const num = nk ? String(node[nk]).trim()
      : (parentKey != null && /^\d+$/.test(String(parentKey)) ? String(parentKey) : null);
    if (num !== null) out.push({ key: (f ?? 'UNKNOWN') + ' ' + num, file: f ?? 'UNKNOWN', num, mark: norm(node[mk]) });
  }
  for (const [k, v] of Object.entries(node)) {
    const cf = (typeof k === 'string' && IMG_RE.test(k)) ? k.split(/[\\/]/).pop() : f;
    walk(v, cf, out, k);
  }
}
function loadRun(p) {
  const out = []; walk(JSON.parse(fs.readFileSync(p, 'utf8')), null, out, null);
  const m = new Map(); const dups = [];
  for (const it of out) { if (m.has(it.key)) dups.push(it.key); else m.set(it.key, it); }
  return { map: m, dups, raw: out.length };
}

// 라벨: "파일명,번호,mark" 한 줄에 하나
const truth = new Map();
for (const line of fs.readFileSync(labelPath, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const [f, n, m] = t.split(',').map((x) => x.trim());
  if (!f || !n || !m) { console.error('무시한 줄: ' + t); continue; }
  truth.set(f.split(/[\\/]/).pop() + ' ' + n, norm(m));
}

const runs = [{ label: path.basename(runPath).replace(/\.json$/, ''), ...loadRun(runPath) }];
if (cmpPath) runs.unshift({ label: path.basename(cmpPath).replace(/\.json$/, ''), ...loadRun(cmpPath) });

const L = []; const say = (s = '') => L.push(s);
const pct = (n, d) => (d === 0 ? 'n/a' : ((n / d) * 100).toFixed(1) + '%');

const tDist = {};
for (const v of truth.values()) tDist[v] = (tDist[v] ?? 0) + 1;
const major = Object.entries(tDist).sort((a, b) => b[1] - a[1])[0];

say('# 채점 결과');
say('');
say('라벨 ' + truth.size + '문항 · ' + new Set([...truth.keys()].map((k) => k.split(' ')[0])).size + '장');
say('');
say('## 0) 정답 분포와 기준선');
say('');
say('| mark | 개수 | 비율 |');
say('|---|---:|---:|');
for (const m of MARKS) if (tDist[m]) say('| ' + m + ' | ' + tDist[m] + ' | ' + pct(tDist[m], truth.size) + ' |');
say('');
say('**다수 클래스 기준선: 전부 `' + major[0] + '` 라고 답해도 ' + pct(major[1], truth.size) + '.**');
say('이 숫자를 못 넘으면 모델이 아무것도 안 한 것과 같다.');
say('');

for (const r of runs) {
  const inter = [...truth.keys()].filter((k) => r.map.has(k));
  const missing = [...truth.keys()].filter((k) => !r.map.has(k));          // 누락
  const halluc = [...r.map.keys()].filter((k) => !truth.has(k));           // 환각 문항
  const correct = inter.filter((k) => r.map.get(k).mark === truth.get(k));

  say('---');
  say('');
  say('## ' + r.label);
  say('');
  say('| 지표 | 값 | 임계 |');
  say('|---|---:|---:|');
  say('| 문항-마크 결합 정확도 (전체 라벨 기준) | **' + pct(correct.length, truth.size) + '** (' + correct.length + '/' + truth.size + ') | ≥ 90% |');
  say('| 정확도 (읽은 문항만) | ' + pct(correct.length, inter.length) + ' (' + correct.length + '/' + inter.length + ') | — |');
  say('| 문항 번호 누락률 | ' + pct(missing.length, truth.size) + ' (' + missing.length + ') | ≤ 5% |');
  say('| 환각 문항률 | ' + pct(halluc.length, r.map.size) + ' (' + halluc.length + ') | ≤ 3% |');
  say('| 중복 출력 | ' + r.dups.length + '건 | — |');
  say('| 기준선 대비 | ' + (correct.length / truth.size > major[1] / truth.size ? '+' : '') + (((correct.length - major[1]) / truth.size) * 100).toFixed(1) + '%p | > 0 |');
  say('');

  // 마크별 precision / recall
  say('### 마크별 precision / recall');
  say('');
  say('| mark | 정답 개수 | 예측 개수 | 맞힌 개수 | precision | recall |');
  say('|---|---:|---:|---:|---:|---:|');
  const preds = [...r.map.values()];
  for (const m of MARKS) {
    const nT = [...truth.values()].filter((x) => x === m).length;
    const nP = preds.filter((x) => x.mark === m).length;
    const tp = inter.filter((k) => r.map.get(k).mark === m && truth.get(k) === m).length;
    if (nT === 0 && nP === 0) continue;
    say('| ' + m + ' | ' + nT + ' | ' + nP + ' | ' + tp + ' | ' + pct(tp, nP) + ' | ' + pct(tp, nT) + ' |');
  }
  // 별칭표 밖 예측
  const odd = [...new Set(preds.map((x) => x.mark))].filter((m) => !MARKS.includes(m));
  if (odd.length) say('| (그 외) ' + odd.join(', ') + ' | 0 | ' + preds.filter((x) => odd.includes(x.mark)).length + ' | 0 | 0.0% | n/a |');
  say('');

  // 사선 <-> 세모 혼동률
  const st = inter.filter((k) => {
    const p = r.map.get(k).mark, t = truth.get(k);
    return (p === 'slash' && t === 'triangle') || (p === 'triangle' && t === 'slash');
  }).length;
  const stBase = [...truth.values()].filter((x) => x === 'slash' || x === 'triangle').length;
  say('**사선 ↔ 세모 혼동률: ' + pct(st, stBase) + ' (' + st + '/' + stBase + ')** — 임계 ≤ 5%');
  say('');

  // 페이지 exact match
  const pages = [...new Set([...truth.keys()].map((k) => k.split(' ')[0]))];
  const exact = pages.filter((p) => {
    const ks = [...truth.keys()].filter((k) => k.split(' ')[0] === p);
    return ks.every((k) => r.map.has(k) && r.map.get(k).mark === truth.get(k))
      && [...r.map.keys()].filter((k) => k.split(' ')[0] === p).length === ks.length;
  });
  say('**페이지 exact match: ' + pct(exact.length, pages.length) + ' (' + exact.length + '/' + pages.length + ')**');
  say('');

  // 혼동행렬
  say('### 혼동행렬 (행=정답, 열=예측)');
  say('');
  const cols = MARKS.filter((m) => tDist[m] || preds.some((x) => x.mark === m));
  say('| 정답＼예측 | ' + cols.join(' | ') + ' | 누락 |');
  say('|---|' + cols.map(() => '---:').join('|') + '|---:|');
  for (const t of MARKS) {
    if (!tDist[t]) continue;
    const row = cols.map((p) => inter.filter((k) => truth.get(k) === t && r.map.get(k).mark === p).length);
    const miss = missing.filter((k) => truth.get(k) === t).length;
    say('| **' + t + '** | ' + row.map((n, i) => (cols[i] === t ? '**' + n + '**' : n === 0 ? '·' : n)).join(' | ') + ' | ' + (miss || '·') + ' |');
  }
  say('');

  // 틀린 문항 전체
  const wrong = inter.filter((k) => r.map.get(k).mark !== truth.get(k));
  say('### 틀린 문항 ' + wrong.length + '개');
  say('');
  for (const k of wrong) say('- `' + k + '`  정답 **' + truth.get(k) + '**  →  읽음 ' + r.map.get(k).mark);
  if (missing.length) {
    say('');
    say('### 놓친 문항 ' + missing.length + '개');
    say('');
    for (const k of missing) say('- `' + k + '`  정답 ' + truth.get(k));
  }
  if (halluc.length) {
    say('');
    say('### 지어낸 문항 ' + halluc.length + '개');
    say('');
    for (const k of halluc) say('- `' + k + '`  읽음 ' + r.map.get(k).mark);
  }
  say('');
}

if (runs.length === 2) {
  const [a, b] = runs;
  const accOf = (r) => [...truth.keys()].filter((k) => r.map.has(k) && r.map.get(k).mark === truth.get(k)).length;
  const ca = accOf(a), cb = accOf(b);
  say('---');
  say('');
  say('## 대조');
  say('');
  say('| | ' + a.label + ' | ' + b.label + ' |');
  say('|---|---:|---:|');
  say('| 정확도 | ' + pct(ca, truth.size) + ' | ' + pct(cb, truth.size) + ' |');
  say('| 기준선(' + major[0] + ' 전부) 대비 | ' + (((ca - major[1]) / truth.size) * 100).toFixed(1) + '%p | ' + (((cb - major[1]) / truth.size) * 100).toFixed(1) + '%p |');
  say('');
  say('> 사진 10장 · 문항 ' + truth.size + '개는 스모크 테스트다. 페이지 내 상관을 반영하면 95% 구간이 ±7~13%p 로 벌어진다.');
  say('> **두 값의 차이를 근거로 어느 쪽이 낫다고 결론짓지 말 것.** 큰 차이만 읽는다.');
}

const text = L.join('\n');
console.log(text);
fs.mkdirSync('results', { recursive: true });
const out = path.join('results', 'score_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.md');
fs.writeFileSync(out, text);
console.error('\n(저장: ' + out + ')');
