/**
 * mark_confidence 캘리브레이션 — API 0회.
 *
 *   질문: "확신도 낮은 것만 확인하세요" UX 가 성립하는가.
 *   그 UX 는 **오류가 낮은 확신도에 몰려 있을 때만** 성립한다.
 *   work_confidence 는 그 반대였다 — 1.0 구간 37건 중 오답 20건(54.1%).
 *   mark 도 같은지 본다. 같다면 선별 UX 는 제품 전체에서 폐기다.
 *
 *   node tools/calibration.mjs --run runs/<run>.json --labels labels/test10.csv
 *   node tools/calibration.mjs --run <run> --labels <csv> --out notes/mark_calibration.md
 *
 *   ⚠️ 판정 기준은 측정 **전에** 고정했다 (2026-09-13 지시). 숫자를 보고 바꾸지 않는다:
 *        최고 확신도 구간 오답률 ≥ 30%  → 확신도 기반 선별 UX 폐기. 전건 확인만 남는다
 *                                ≤ 10%  → 선별 UX 생존. coverage-risk 곡선으로 임계 결정
 *                                 사이   → 판정 보류, n 부족으로 기록
 *
 *   mark 채점 제외(겹침·판독불가) 문항은 분모에서 뺀다 — score.mjs 와 같은 규율.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const runPath = arg('--run'), labelPath = arg('--labels'), OUT = arg('--out');
if (!runPath || !labelPath) {
  console.error('usage: node tools/calibration.mjs --run <run.json> --labels <csv> [--out <md>]');
  process.exit(1);
}

/* ── score.mjs 와 같은 정규화 규칙 ───────────────────────────────────────── */
const ALIAS = {
  c: 'circle', s: 'slash', t: 'triangle', q: 'question', k: 'check', u: 'unmarked',
  circle: 'circle', slash: 'slash', triangle: 'triangle', question: 'question',
  check: 'check', unmarked: 'unmarked',
};
const EXCLUDE_KIND = {
  unreadable: '판독불가', unclear: '판독불가', pass: '판독불가', skip: '판독불가', '판독불가': '판독불가',
  overlapped: '겹침', overlap: '겹침', '겹침': '겹침',
};
const norm = (m) => { if (m == null) return 'MISSING'; const s = String(m).trim().toLowerCase(); return ALIAS[s] ?? s; };

/* 확신도 스케일 정규화 — 0~1 로 들어오든 0~100 으로 들어오든 100점으로 맞춘다.
   ⚠️ 1 은 모호하다(1% 인가 100% 인가). 이 스키마에서 1 은 1.0 = 100 이다:
   read.mjs 의 압축 포맷이 0~100 정수를 내고 파서가 /100 하므로 최대값이 1 이 된다. */
const pct = (v) => (v == null ? null : (v <= 1 ? v * 100 : v));

/* ── 라벨 ────────────────────────────────────────────────────────────────── */
const truth = new Map(), excluded = new Map();
for (const line of fs.readFileSync(labelPath, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const [f, n, m] = t.split(',').map((x) => (x ?? '').trim());
  if (!f || !n || !m) continue;
  const key = f.split(/[\\/]/).pop() + ' ' + n;
  const kind = EXCLUDE_KIND[m.toLowerCase()];
  if (kind) { excluded.set(key, kind); continue; }
  if (!truth.has(key)) truth.set(key, norm(m));
}

/* ── run ─────────────────────────────────────────────────────────────────── */
const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
const runName = path.basename(runPath).replace(/\.json$/, '');
const pred = new Map();
for (const [f, ph] of Object.entries(run.photos || {})) {
  for (const it of (ph.items || [])) {
    const key = f.split(/[\\/]/).pop() + ' ' + it.item_no;
    if (pred.has(key)) continue;                     // first-wins — score.mjs 와 동일
    pred.set(key, { mark: norm(it.mark), conf: pct(it.mark_confidence) });
  }
}

/* 채점 대상: 라벨에 있고 제외가 아닌 문항. 예측이 없으면 '누락'으로 오답 취급하되
   확신도가 없으므로 구간 집계에서는 뺀다 — 어느 구간에 넣어도 거짓말이 된다. */
const rows = [];
let missing = 0;
for (const [key, gold] of truth) {
  const p = pred.get(key);
  if (!p) { missing++; continue; }
  rows.push({ key, gold, read: p.mark, conf: p.conf, ok: p.mark === gold });
}
const noConf = rows.filter((r) => r.conf == null).length;
const scored = rows.filter((r) => r.conf != null);

/* ── 구간 ────────────────────────────────────────────────────────────────── */
const BANDS = [
  { name: '100 (최고)', lo: 100, hi: 100.001 },
  { name: '90–99',      lo: 90,  hi: 100 },
  { name: '70–89',      lo: 70,  hi: 90 },
  { name: '~69',        lo: -1,  hi: 70 },
];
const inBand = (c, b) => c >= b.lo && c < b.hi;

const L = [];
const say = (s = '') => L.push(s);
const p1 = (x) => (x * 100).toFixed(1) + '%';

say('# mark_confidence 캘리브레이션');
say('');
say(`- run: \`${runName}\``);
say(`- 라벨: \`${path.basename(labelPath)}\` · 채점 대상 ${truth.size}문항 (제외 ${excluded.size}문항)`);
say(`- 측정일: ${new Date().toISOString().slice(0, 10)} · **API 0회** (기존 run JSON 재분석)`);
if (missing) say(`- ⚠️ 예측 누락 ${missing}문항 — 확신도가 없어 구간 집계에서 제외했다 (오답으로도 세지 않는다)`);
if (noConf) say(`- ⚠️ mark_confidence 없는 예측 ${noConf}건 — 구간 집계에서 제외`);
say('');
say('> 판정 기준은 측정 **전에** 고정했다. 숫자를 보고 바꾸지 않는다.');
say('> 최고 구간 오답률 ≥30% → 선별 UX 폐기 · ≤10% → 생존 · 사이 → 보류(n 부족).');
say('');

say('## 1) 확신도 구간별 오답률');
say('');
say('| 구간 | 문항 | 오답 | 오답률 |');
say('|---|---:|---:|---:|');
let top = null;
for (const b of BANDS) {
  const g = scored.filter((r) => inBand(r.conf, b));
  if (!g.length) { say(`| ${b.name} | 0 | · | — |`); continue; }
  const wrong = g.filter((r) => !r.ok).length;
  const rate = wrong / g.length;
  const bold = b === BANDS[0];
  if (bold) top = { n: g.length, wrong, rate };
  say(`| ${bold ? '**' + b.name + '**' : b.name} | ${g.length} | ${wrong} | ${bold ? '**' + p1(rate) + '**' : p1(rate)} |`);
}
say('');
if (top) {
  say(`**최고 확신도 구간 오답률 ${p1(top.rate)}** (${top.wrong}/${top.n})`);
  say('');
  say('| | 최고 확신도 구간 오답률 |');
  say('|---|---:|');
  say(`| mark_confidence | **${p1(top.rate)}** |`);
  say('| work_confidence | **54.1%** (20/37, 같은 run) |');
  say('');
}

/* ── coverage-risk ───────────────────────────────────────────────────────── */
say('## 2) coverage-risk 곡선');
say('');
say('확신도 내림차순으로 정렬한 뒤 상위 k% 를 **사람 확인 없이 자동 확정**했을 때,');
say('그 자동 확정분에 남는 오류율. 오류가 낮은 확신도에 몰려 있으면 k 가 커질수록 단조 증가한다.');
say('평평하면 확신도가 오류와 무관하다는 뜻이고, 선별할 근거가 없다.');
say('');
/* 동점이 많다 — 동점 안에서 순서를 정할 근거가 없으므로 키로 안정 정렬만 한다.
   그래서 "상위 k%" 는 동점 덩어리를 임의로 자르는 구간이 된다. 그 사실을 표에 적는다. */
const sorted = [...scored].sort((a, b) => (b.conf - a.conf) || a.key.localeCompare(b.key));
say('| 자동 확정 k% | 문항 수 | 그중 오답 | 잔여 오류율 | 경계 확신도 |');
say('|---:|---:|---:|---:|---:|');
const curve = [];
for (let k = 10; k <= 100; k += 10) {
  const n = Math.max(1, Math.round(sorted.length * k / 100));
  const slice = sorted.slice(0, n);
  const wrong = slice.filter((r) => !r.ok).length;
  curve.push({ k, n, wrong, rate: wrong / n });
  say(`| ${k}% | ${n} | ${wrong} | ${p1(wrong / n)} | ${slice[n - 1].conf.toFixed(0)} |`);
}
say('');
/* 곡선의 방향 — 선별 UX 가 성립하려면 k 가 커질수록 잔여 오류율이 **올라가야** 한다.
   내려간다면 확신도가 높은 쪽에 오류가 더 몰려 있다는 뜻이고, 정렬을 뒤집어도 답이 아니다. */
const first = curve[0].rate, last = curve[curve.length - 1].rate;
if (last > first) {
  say(`곡선 방향: 상승 (10%→${p1(first)}, 100%→${p1(last)}) — 오류가 낮은 확신도 쪽에 있다. 선별에 필요한 모양이다.`);
} else {
  say(`⚠️ 곡선 방향: **하강** (10% ${p1(first)} → 100% ${p1(last)}) — 선별 UX 가 요구하는 모양의 **반대**다.`);
  say('가장 확신하는 문항들이 오히려 더 많이 틀렸다. 정렬을 뒤집어도 선별이 되지 않는다 —');
  say('그건 "확신하는 것만 사람이 확인하라"는 말이 되고, 아무 문항도 자동 확정할 수 없다.');
}
say('');
const confVals = [...new Set(scored.map((r) => r.conf))].sort((a, b) => b - a);
say(`서로 다른 확신도 값 ${confVals.length}종: ${confVals.map((v) => v.toFixed(0)).join(' · ')}`);
if (top) {
  say('');
  say(`최고값(100)에 ${top.n}/${scored.length}문항 = ${p1(top.n / scored.length)} 가 몰려 있다.`);
  say(`"확신도 낮은 것만 확인하세요" 를 그대로 적용하면 ${top.n}문항이 확인 없이 통과하고,`);
  say(`그 안에 오답 ${top.wrong}건이 남는다 — 전체 오답 ${scored.filter((r) => !r.ok).length}건의 ${p1(top.wrong / Math.max(1, scored.filter((r) => !r.ok).length))}.`);
}
if (confVals.length <= 3) {
  say('');
  say('⚠️ **확신도가 사실상 상수다.** 값이 몇 종류뿐이라 "상위 k%" 는 동점 덩어리를 임의로 자른 것이고,');
  say('곡선의 모양은 정렬이 아니라 우연이 만든다. 이 신호로는 어떤 임계도 정할 수 없다.');
}
say('');

/* ── ★ 오답계열 미탐 ─────────────────────────────────────────────────────── */
say('## 3) ★ 오답계열 미탐 — 틀린 문항을 맞았다고 읽은 건');
say('');
say('실제 `slash`·`triangle`·`question` 을 `circle` 로 읽은 건. **복습 큐에서 조용히 사라지는 오류**다.');
say('여기가 고확신이면 가장 나쁘다 — 확신도로 건질 수 없다는 뜻이라서.');
say('');
const WRONG_FAMILY = new Set(['slash', 'triangle', 'question']);
const missed = scored.filter((r) => WRONG_FAMILY.has(r.gold) && r.read === 'circle');
if (!missed.length) {
  say('해당 없음 — 이 run 에서 오답계열을 `circle` 로 읽은 건은 0건이다.');
} else {
  say('| 문항 | 정답 | 읽음 | mark_confidence |');
  say('|---|---|---|---:|');
  for (const r of missed) say(`| \`${r.key}\` | ${r.gold} | circle | ${r.conf.toFixed(0)} |`);
  say('');
  const hi = missed.filter((r) => r.conf >= 100).length;
  say(`미탐 ${missed.length}건 중 최고 확신도(100) **${hi}건** (${p1(hi / missed.length)}).`);
  const denom = scored.filter((r) => WRONG_FAMILY.has(r.gold)).length;
  say(`오답계열 전체 ${denom}건 기준 미탐률 ${p1(missed.length / denom)}.`);
}
say('');

/* ── 판정 ────────────────────────────────────────────────────────────────── */
say('## 4) 판정');
say('');
if (!top || !top.n) {
  say('최고 확신도 구간에 문항이 없다 — 판정 불가.');
} else if (top.rate >= 0.30) {
  say(`🔴 **확신도 기반 선별 UX 폐기.** 최고 확신도 구간 오답률 ${p1(top.rate)} ≥ 30%.`);
  say('');
  say('"확신도 낮은 것만 확인하세요" 는 성립하지 않는다. 모델이 가장 확신하는 곳에서 가장 많이 틀린다.');
  say('남는 선택지는 **전건 확인**뿐이다. 제품 전체에서 이 UX 를 뺀다.');
} else if (top.rate <= 0.10) {
  say(`🟢 **선별 UX 생존.** 최고 확신도 구간 오답률 ${p1(top.rate)} ≤ 10%.`);
  say('§2 coverage-risk 곡선에서 허용 오류율에 맞는 k 를 고른다.');
} else {
  say(`🟡 **판정 보류 — n 부족.** 최고 확신도 구간 오답률 ${p1(top.rate)} 은 10%~30% 사이다 (n=${top.n}).`);
  say('이 표본으로는 폐기도 생존도 말할 수 없다. 라벨을 늘린 뒤 다시 잰다.');
}
say('');

const text = L.join('\n') + '\n';
console.log(text);
if (OUT) {
  const outPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, 'utf8');
  console.error(`저장: ${OUT}`);
}
