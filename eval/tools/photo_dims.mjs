/**
 * 원본 사진 해상도 실측 — API 0회.
 *
 *   결정기록 §5-B 의 밀도 계산이 "원본 4032×3024" 라는 추정에 얹혀 있었다.
 *   그 값은 조각 높이에서 역산한 것이고 아무도 실측한 적이 없다. 이 도구가 실측한다.
 *
 *   node tools/photo_dims.mjs --photos photos/test10 [--slices 4] [--overlap 0.15]
 *   node tools/photo_dims.mjs --photos photos/test10 --out notes/photo_dimensions.md
 *
 *   검증식: 조각높이 합 − 원본높이 = 겹침 픽셀
 *   (sliceBoxes 와 같은 규칙을 crop_eval.mjs 에서 import 해서 쓴다 — 사본 금지)
 *
 *   ⚠️ 10장이 서로 다른 해상도면 그대로 적는다. 장별로 토큰 배수가 달라진다는 뜻이라
 *   "장당 이미지 토큰"을 하나의 수로 말할 수 없게 된다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { sliceBoxes, cropName } from './crop_eval.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const evalRoot = path.resolve(here, '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };

const PHOTOS = path.resolve(evalRoot, arg('photos', 'photos/test10'));
const SLICES = Number(arg('slices', 4));
const OVERLAP = Number(arg('overlap', 0.15));
const OUT = arg('out', null);

const MEDIA = /\.(jpe?g|png|webp|heic|heif)$/i;

if (!fs.existsSync(PHOTOS)) { console.error(`사진 폴더가 없습니다: ${PHOTOS}`); process.exit(1); }
const files = fs.readdirSync(PHOTOS).filter(f => MEDIA.test(f)).sort();
if (!files.length) { console.error(`사진이 없습니다: ${PHOTOS}`); process.exit(1); }

const L = [];
const say = (s = '') => L.push(s);

say('# 원본 사진 해상도 실측');
say('');
say(`- 측정일: ${new Date().toISOString().slice(0, 10)}`);
say(`- 대상: \`${path.relative(evalRoot, PHOTOS)}\` · ${files.length}장`);
say(`- 분할 설정: ${SLICES}등분 · 겹침 ${OVERLAP} (조각 높이의 위아래 각 ${OVERLAP * 100}%)`);
say('- 측정 도구: `tools/photo_dims.mjs` (sharp metadata, API 0회)');
say('');
say('## 장별 실측');
say('');
say('| 사진 | 가로 | 세로 | 화소 | 조각 크기 (가로×세로) | 조각높이 합 | 겹침 픽셀 |');
say('|---|---:|---:|---:|---|---:|---:|');

const rows = [];
for (const f of files) {
  const m = await sharp(path.join(PHOTOS, f)).metadata();
  const boxes = sliceBoxes(m.height, SLICES, OVERLAP);
  const sumH = boxes.reduce((a, b) => a + b.height, 0);
  const sizes = [...new Set(boxes.map(b => `${m.width}×${b.height}`))];
  rows.push({ file: f, width: m.width, height: m.height, format: m.format, boxes, sumH, overlapPx: sumH - m.height });
  say(`| \`${f}\` | ${m.width} | ${m.height} | ${(m.width * m.height / 1e6).toFixed(1)}MP | ${sizes.join(', ')} | ${sumH} | ${sumH - m.height} |`);
}
say('');

say('## 검증식');
say('');
say('```');
say('조각높이 합 − 원본높이 = 겹침 픽셀');
say(`겹침 픽셀의 이론값 = (조각수 − 1) × 2 × ${OVERLAP} × (원본높이 / 조각수)`);
say('```');
say('');
say('| 사진 | 실측 겹침 | 이론값 | 일치 |');
say('|---|---:|---:|---|');
let allOk = true;
for (const r of rows) {
  const theory = Math.round((SLICES - 1) * 2 * OVERLAP * (r.height / SLICES));
  const ok = Math.abs(r.overlapPx - theory) <= SLICES;   // 반올림 오차 허용
  if (!ok) allOk = false;
  say(`| \`${r.file}\` | ${r.overlapPx} | ${theory} | ${ok ? '✅' : '❌'} |`);
}
say('');
say(allOk ? '검증식 전부 일치.' : '⚠️ 불일치가 있다 — sliceBoxes 규칙과 설정을 확인할 것.');
say('');

/* 해상도가 장마다 다르면 "장당 토큰"을 하나의 수로 말할 수 없다 */
const uniq = [...new Set(rows.map(r => `${r.width}×${r.height}`))];
say('## 해상도 동일성');
say('');
if (uniq.length === 1) {
  say(`10장 전부 동일: **${uniq[0]}**`);
} else {
  say(`⚠️ **서로 다른 해상도 ${uniq.length}종**: ${uniq.join(' · ')}`);
  say('');
  say('장별로 이미지 토큰 배수가 달라진다는 뜻이다.');
  say('"장당 이미지 토큰"을 하나의 수로 말할 수 없고, 크롭 배수도 장마다 다르다.');
  say('원가 사다리(README)의 수치는 대표값이지 모든 장에 적용되는 값이 아니다.');
}
say('');
say('## 예시 조각 파일명');
say('');
say('```');
for (const b of rows[0].boxes) say(cropName(rows[0].file, b.index, SLICES) + `   y ${b.top}–${b.bottom} (h=${b.height})`);
say('```');

const text = L.join('\n') + '\n';
console.log(text);
if (OUT) {
  const outPath = path.resolve(evalRoot, OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, 'utf8');
  console.error(`저장: ${path.relative(process.cwd(), outPath)}`);
}
