/**
 * work=blank 예측 건수를 run 끼리 나란히 센다 — API 0회.
 *
 *   질문: blank 오탐이 **픽셀 문제인가**.
 *   해상도를 올리고(high) 조각을 내서(crop4, 이미지 토큰 4.05배) 같은 수가 나오면
 *   픽셀이 아니라 모델이 "손글씨 있음"을 판정하지 못하는 문제다.
 *
 *   node tools/blank_census.mjs runs/<a>.json runs/<b>.json ...
 *   node tools/blank_census.mjs --labels labels/test10.csv runs/*.json
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const li = argv.indexOf('--labels');
const labelPath = li >= 0 ? argv[li + 1] : null;
const runs = argv.filter((a, i) => a !== '--labels' && i !== li + 1 && !a.startsWith('--'));
if (!runs.length) { console.error('usage: node tools/blank_census.mjs [--labels <csv>] <run.json> ...'); process.exit(1); }

const WORK_ALIAS = { s: 'solved', b: 'blank', p: 'partial', solved: 'solved', blank: 'blank', partial: 'partial' };
const w = (v) => WORK_ALIAS[String(v ?? '').trim().toLowerCase()] ?? null;

const rows = [];
for (const p of runs) {
  if (!fs.existsSync(p)) { rows.push({ name: path.basename(p), missing: true }); continue; }
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const counts = { solved: 0, blank: 0, partial: 0, null: 0 };
  let items = 0;
  for (const ph of Object.values(j.photos || {}))
    for (const it of (ph.items || [])) { items++; const k = w(it.work); counts[k ?? 'null']++; }
  rows.push({
    name: path.basename(p).replace(/\.json$/, ''),
    media_res: j.media_res ?? j.mode ?? '-',
    slices: j.slices ?? null,
    items, ...counts,
  });
}

if (labelPath && fs.existsSync(labelPath)) {
  const c = { solved: 0, blank: 0, partial: 0, null: 0 }; let n = 0;
  for (const line of fs.readFileSync(labelPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const col = t.split(',').map((x) => x.trim());
    if (col.length < 3) continue;
    n++; const k = w(col[3]); c[k ?? 'null']++;
  }
  rows.unshift({ name: '사람 라벨', media_res: '—', items: n, ...c, isLabel: true });
}

const pc = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '—');
console.log('\n| run | media_res | 문항 | solved | **blank** | partial | blank 비율 |');
console.log('|---|---|---:|---:|---:|---:|---:|');
for (const r of rows) {
  if (r.missing) { console.log(`| \`${r.name}\` | — | — | — | **없음** | — | — |`); continue; }
  console.log(`| ${r.isLabel ? '**' + r.name + '**' : '`' + r.name + '`'} | ${r.media_res} | ${r.items} | ${r.solved} | **${r.blank}** | ${r.partial} | ${pc(r.blank, r.items)} |`);
}
const missing = rows.filter((r) => r.missing);
if (missing.length) {
  console.log(`\n⚠️ 없는 run ${missing.length}건: ${missing.map((r) => r.name).join(', ')} — 측정하지 않았다. 추정치를 넣지 않는다.`);
}
console.log('');
