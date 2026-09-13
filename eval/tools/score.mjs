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
/* 채점 제외 — 정확도 분모에서 빼고 따로 센다. 두 종류를 반드시 나눈다: 처방이 다르다.
     판독불가 = 마크가 작거나 흐려서 안 보임        → 해상도·크롭으로 줄어든다
     겹침     = 동그라미 위에 X·슬래시가 겹침       → 해상도를 올려도 안 줄어든다 (내용 문제)
   ⚠️ 세모 위 사선은 겹침이 아니다 — triangle 정의 그대로 판독 대상이다. */
const EXCLUDE_KIND = {
  unreadable: '판독불가', unclear: '판독불가', pass: '판독불가', skip: '판독불가', '판독불가': '판독불가',
  overlapped: '겹침', overlap: '겹침', '겹침': '겹침',
};
const norm = (m) => { if (m == null) return 'MISSING'; const s = String(m).trim().toLowerCase(); return ALIAS[s] ?? s; };

const FILE_KEYS = ['file', 'filename', 'fileName', 'image', 'imagePath', 'imageFile', 'photo', 'path', 'src', 'name'];
const NUM_KEYS = ['item_no', 'itemNo', 'item_number', 'number', 'no', 'num', 'qno', 'q_no', 'questionNumber', 'question_no', 'item', 'q', 'id'];
// 'm' 은 뺐다 — 컬럼명이 m 인 입력에서 work 코드(s=solved)를 mark(s=slash)로
// 해석할 수 있다. 현재 스키마에선 발화하지 않지만 한 글자 키는 위험이 이득보다 크다.
const MARK_KEYS = ['mark', 'markLabel', 'mark_label', 'symbol'];
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
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const out = []; walk(j, null, out, null);
  const m = new Map(); const dups = [];
  for (const it of out) { if (m.has(it.key)) dups.push(it.key); else m.set(it.key, it); }
  /* 파싱 실패로 버려진 줄 — read.mjs 가 기록한다. 읽지 않으면 조용히 사라진다. */
  const photos = j.photos && typeof j.photos === 'object' ? Object.entries(j.photos) : [];
  const dropped = photos.reduce((a, [, v]) => a + (v?.dropped_lines || 0), 0);
  const droppedBy = photos.filter(([, v]) => v?.dropped_lines).map(([f, v]) => f + '×' + v.dropped_lines);
  return { map: m, dups, raw: out.length, dropped, droppedBy };
}

/* 라벨: "파일명,번호,mark[,work]" 한 줄에 하나. 3열 파일도 계속 읽힌다.
   work 는 s|b|p 와 solved|blank|partial 둘 다 허용.
   work 가 x·판독불가면 **work 채점에서만** 제외한다 — mark 채점에는 영향이 없다. */
const WORK_ALIAS = { s: 'solved', b: 'blank', p: 'partial',
                     solved: 'solved', blank: 'blank', partial: 'partial' };
const WORK_SKIP = new Set(['x', '판독불가', 'unreadable', '']);
const WORKS = ['solved', 'blank', 'partial'];

const truth = new Map();        // mark 채점 대상
const excluded = new Map();     // mark 채점 제외 → key -> { kind, raw }
const truthWork = new Map();    // work 채점 대상 (mark 제외와 독립)
const workSkipped = new Map();  // work 채점 제외 → key -> raw
for (const line of fs.readFileSync(labelPath, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const [f, n, m, w] = t.split(',').map((x) => (x ?? '').trim());
  if (!f || !n || !m) { console.error('무시한 줄: ' + t); continue; }
  const key = f.split(/[\\/]/).pop() + ' ' + n;
  const kind = EXCLUDE_KIND[m.toLowerCase()];
  if (kind) excluded.set(key, { kind, raw: m });
  else truth.set(key, norm(m));
  if (w !== undefined && w !== '') {
    const lw = w.toLowerCase();
    if (WORK_SKIP.has(lw)) workSkipped.set(key, w);
    else if (WORK_ALIAS[lw]) truthWork.set(key, WORK_ALIAS[lw]);
    else console.error(`알 수 없는 work 값 무시: ${w} (${key})`);
  }
}
const labelTotal = truth.size + excluded.size;

/* work 는 walk() 가 보지 않는다(MARK_KEYS 만 본다). run JSON 의 photos 구조에서 직접 읽는다. */
function loadWork(p) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const m = new Map();
  for (const [f, ph] of Object.entries(j.photos || {}))
    for (const it of (ph.items || [])) {
      const key = f.split(/[\\/]/).pop() + ' ' + it.item_no;
      if (!m.has(key)) m.set(key, { work: WORK_ALIAS[String(it.work ?? '').toLowerCase()] ?? null,
                                    wc: it.work_confidence ?? null,
                                    mark: norm(it.mark) });
    }
  return m;
}

const runs = [{ label: path.basename(runPath).replace(/\.json$/, ''), ...loadRun(runPath), work: loadWork(runPath) }];
if (cmpPath) runs.unshift({ label: path.basename(cmpPath).replace(/\.json$/, ''), ...loadRun(cmpPath), work: loadWork(cmpPath) });

const L = []; const say = (s = '') => L.push(s);
const pct = (n, d) => (d === 0 ? 'n/a' : ((n / d) * 100).toFixed(1) + '%');

const tDist = {};
for (const v of truth.values()) tDist[v] = (tDist[v] ?? 0) + 1;
const major = Object.entries(tDist).sort((a, b) => b[1] - a[1])[0];

say('# 채점 결과');
say('');
const WARN_SLOT = L.length;     // 상단 경고를 나중에 여기에 끼워 넣는다
const warnings = [];
say('');
const pageSet = new Set([...truth.keys(), ...excluded.keys()].map((k) => k.split(' ')[0]));
say('라벨 ' + labelTotal + '문항 · ' + pageSet.size + '장');
say('');
if (excluded.size) {
  const byKind = {};
  for (const { kind } of excluded.values()) byKind[kind] = (byKind[kind] ?? 0) + 1;
  say('## 채점 제외 ' + excluded.size + '문항 (' + pct(excluded.size, labelTotal) + ') — 채점 대상 ' + truth.size + '문항');
  say('');
  say('| 종류 | 개수 | 뜻 | 해상도·크롭으로 줄어드는가 |');
  say('|---|---:|---|---|');
  if (byKind['판독불가']) say('| 판독불가 | ' + byKind['판독불가'] + ' | 마크가 작거나 흐려서 안 보임 | **줄어든다** |');
  if (byKind['겹침']) say('| 겹침 | ' + byKind['겹침'] + ' | 동그라미 위에 X·슬래시가 겹침 | **줄지 않는다 (내용 문제)** |');
  say('');
  for (const kind of ['판독불가', '겹침']) {
    const ks = [...excluded.entries()].filter(([, v]) => v.kind === kind);
    if (ks.length) say('- **' + kind + '** ' + ks.map(([k, v]) => '`' + k + '`(' + v.raw + ')').join(', '));
  }
  say('');
  say('> ⚠️ **제외는 성공이 아니다. 제외율 자체가 제품 지표다.**');
  say('> 이 문항들은 학생 확인으로 넘어가며, 복습 큐에서 조용히 빠지지 않도록');
  say('> 화면에 명시 표시되어야 한다.');
  say('');
}
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
  // 제외 문항은 라벨에 있었으므로 지어낸 것이 아니다 — 환각에서 뺀다
  const halluc = [...r.map.keys()].filter((k) => !truth.has(k) && !excluded.has(k));
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
  say('| 파싱 실패로 버린 줄 | ' + r.dropped + '건' + (r.droppedBy.length ? ' (' + r.droppedBy.join(', ') + ')' : '') + ' | = 0 |');
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

  /* ── work 3분류 채점 ─────────────────────────────────────────────────────
     방향별로 나눠 센다. 한 숫자로 뭉치면 어느 쪽 오류인지 알 수 없다. */
  if (truthWork.size) {
    const wKeys = [...truthWork.keys()];
    const wPred = (k) => r.work.get(k)?.work ?? null;
    const wOk = wKeys.filter((k) => wPred(k) === truthWork.get(k));
    const wAcc = wOk.length / wKeys.length;

    /* ★ 다수클래스 기준선 — 게이트보다 먼저 본다.
       게이트가 기준선보다 낮으면 그 게이트는 무의미하다. */
    const wDist = {};
    for (const v of truthWork.values()) wDist[v] = (wDist[v] ?? 0) + 1;
    const wMajor = Object.entries(wDist).sort((a, b) => b[1] - a[1])[0];
    const wBase = wMajor[1] / wKeys.length;

    say('### work 3분류');
    say('');
    say('| 지표 | 값 | 기준 |');
    say('|---|---:|---:|');
    say('| work 3분류 정확도 | **' + pct(wOk.length, wKeys.length) + '** (' + wOk.length + '/' + wKeys.length + ') | ≥ 90% (게이트) |');
    say('| **다수클래스 기준선** (전부 `' + wMajor[0] + '`) | **' + pct(wMajor[1], wKeys.length) + '** | — |');
    say('| 기준선 대비 | ' + ((wAcc - wBase) * 100).toFixed(1) + '%p | > 0 |');
    if (workSkipped.size) say('| work 채점 제외 (x·판독불가) | ' + workSkipped.size + '문항 | — |');
    say('');
    if (wAcc < wBase) {
      const msg = '⚠️ **work 기준선 미달 — 이 지표로는 모델이 무작위 추측보다 못하다** ' +
        '(정확도 ' + pct(wOk.length, wKeys.length) + ' < 기준선 ' + pct(wMajor[1], wKeys.length) + ', run `' + r.label + '`)';
      warnings.push(msg);
      say(msg);
      say('');
    }
    if (wBase >= 0.90) {
      const msg2 = '⚠️ **work 게이트(90%)가 다수클래스 기준선(' + pct(wMajor[1], wKeys.length) + ')보다 낮다 — 이 게이트는 무의미하다.** ' +
        '전부 `' + wMajor[0] + '` 이라고 답해도 게이트를 통과한다.';
      if (!warnings.includes(msg2)) warnings.push(msg2);
      say(msg2);
      say('');
    }

    say('**방향별 오판** — 한 숫자로 뭉치지 않는다');
    say('');
    say('| 방향 | 건수 | 비율 (해당 라벨 기준) |');
    say('|---|---:|---:|');
    for (const a of WORKS) for (const b of WORKS) {
      if (a === b) continue;
      const n = wKeys.filter((k) => truthWork.get(k) === a && wPred(k) === b).length;
      const d = wKeys.filter((k) => truthWork.get(k) === a).length;
      if (n || d) say('| ' + a + ' → ' + b + ' | ' + n + ' | ' + pct(n, d) + ' |');
    }
    const wMiss = wKeys.filter((k) => wPred(k) === null).length;
    if (wMiss) say('| (출력 없음) | ' + wMiss + ' | ' + pct(wMiss, wKeys.length) + ' |');
    say('');

    const predBlank = wKeys.filter((k) => wPred(k) === 'blank').length;
    const truthBlank = wKeys.filter((k) => truthWork.get(k) === 'blank').length;
    say('**blank 비율** — 모델 ' + pct(predBlank, wKeys.length) + ' (' + predBlank + '/' + wKeys.length + ')' +
        ' · 라벨 ' + pct(truthBlank, wKeys.length) + ' (' + truthBlank + '/' + wKeys.length + ')');
    say('');

    /* mark × work 6×3 교차표 (모델 예측 기준) — circle×blank 가 fn_flag_pages 발화 조건 */
    say('**mark × work 교차표 (모델 예측 기준)**');
    say('');
    say('| mark＼work | ' + WORKS.join(' | ') + ' | 합 |');
    say('|---|' + WORKS.map(() => '---:').join('|') + '|---:|');
    let cxb = 0;
    for (const m of MARKS) {
      const cells = WORKS.map((w) => wKeys.filter((k) => r.work.get(k)?.mark === m && wPred(k) === w).length);
      const sum = cells.reduce((a, b) => a + b, 0);
      if (!sum) continue;
      if (m === 'circle') cxb = cells[WORKS.indexOf('blank')];
      say('| **' + m + '** | ' + cells.map((n, i) =>
        (m === 'circle' && WORKS[i] === 'blank') ? '**★ ' + n + '**' : (n || '·')).join(' | ') + ' | ' + sum + ' |');
    }
    say('');
    const cxbTruth = wKeys.filter((k) => truth.get(k) === 'circle' && truthWork.get(k) === 'blank').length;
    say('★ **circle × blank = ' + cxb + '건** (모델) vs **' + cxbTruth + '건** (사람 라벨).');
    say('`fn_flag_pages` 가 "확인할 게 있어요" 를 띄우는 조건이다 — 이 차이가 그대로 오탐이 된다.');
    say('');

    /* work_confidence 구간별 — 오답이 어느 구간에 몰리는지 */
    say('**work_confidence 구간별**');
    say('');
    say('| 구간 | 건수 | 그중 오답 | 오답률 |');
    say('|---|---:|---:|---:|');
    const bands = [[1.0, 1.01, '1.0'], [0.9, 1.0, '0.9–0.99'], [0.7, 0.9, '0.7–0.89'],
                   [0.5, 0.7, '0.5–0.69'], [0, 0.5, '< 0.5']];
    for (const [lo, hi, name] of bands) {
      const inBand = wKeys.filter((k) => { const c = r.work.get(k)?.wc; return c != null && c >= lo && c < hi; });
      if (!inBand.length) continue;
      const bad = inBand.filter((k) => wPred(k) !== truthWork.get(k)).length;
      say('| ' + name + ' | ' + inBand.length + ' | ' + bad + ' | ' + pct(bad, inBand.length) + ' |');
    }
    const noConf = wKeys.filter((k) => r.work.get(k)?.wc == null).length;
    if (noConf) say('| (confidence 없음) | ' + noConf + ' | — | — |');
    say('');
  }

  if (excluded.size) {
    say('');
    say('### 참고 — 채점 제외 문항에 이 run 이 낸 값 (정확도에 반영되지 않음)');
    say('');
    for (const [k, v] of excluded) {
      say('- `' + k + '`  제외사유 **' + v.kind + '**(' + v.raw + ')  →  읽음 ' +
          (r.map.has(k) ? r.map.get(k).mark : '(출력 없음)'));
    }
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
  say('> 사진 ' + pageSet.size + '장 · 채점 대상 ' + truth.size + '문항(제외 ' + excluded.size + ')은 스모크 테스트다. 페이지 내 상관을 반영하면 95% 구간이 ±7~13%p 로 벌어진다.');
  say('> **두 값의 차이를 근거로 어느 쪽이 낫다고 결론짓지 말 것.** 큰 차이만 읽는다.');
}

if (warnings.length) L.splice(WARN_SLOT, 0, ...warnings, '');
const text = L.join('\n');
console.log(text);
fs.mkdirSync('results', { recursive: true });
const out = path.join('results', 'score_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.md');
fs.writeFileSync(out, text);
console.error('\n(저장: ' + out + ')');
