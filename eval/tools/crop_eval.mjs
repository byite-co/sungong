/**
 * 크롭 재측정 — 입력 형식 하나만 바꾼다 (15차 §3)
 *
 *   가설: 모델이 기호를 못 읽는 게 아니라, 페이지 전체에서 세부를 못 보거나
 *         번호와 기호를 잘못 연결한다.
 *
 *   사진을 세로 N등분(기본 4)하고 위아래로 slice 높이의 15% 씩 겹치게 잘라
 *   조각마다 1회씩 판독한다. 바뀌는 변수는 입력 형식 하나뿐이다:
 *     - 프롬프트: read.mjs 의 PROMPTS.v2 를 import 해서 그대로 쓴다 (사본 금지 — 드리프트 방지)
 *     - 모델·temperature·media_resolution: read.mjs 와 동일 기본값
 *     - 조각당 정확히 1회 호출. 재시도는 429/5xx 전송 실패에만 (결과를 골라 담지 않는다)
 *
 *   사용:
 *     node tools/crop_eval.mjs --photos photos/test10
 *     node tools/crop_eval.mjs --photos photos/test10 --dry-run   # 자르기만, API 0회
 *     node tools/crop_eval.mjs --slices 4 --overlap 0.15
 *
 *   출력:
 *     crops/<ts>/<원본>__sIofN.jpg     조각 이미지 (파일명에 라벨 정보 없음)
 *     runs/<ts>-<model>-v2-crop<N>.json  기존 run 과 같은 스키마
 *
 *   ⚠️ 겹침 때문에 같은 문항이 두 조각에서 나올 수 있다. 이 도구는 **중복을 지우지
 *   않는다** — 원본 문항 배열에 전부 남기고 photos[].crop_duplicates 에 census 를
 *   적는다. 어느 것을 남길지는 채점기의 정책이고, 그 정책이 지금 도구마다 다르다
 *   (compare_runs=둘 다 보존 / diff_runs=첫 줄 / measure=마지막 줄). 여기서
 *   임의로 정하면 측정하려는 것과 다른 것을 재게 된다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PROMPTS, parseItems } from '../read.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const evalRoot = path.resolve(here, '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(`--${n}`);

const PROVIDER  = arg('provider', 'gemini');
const MODEL     = arg('model', PROVIDER === 'gemini' ? 'gemini-3.1-flash-lite' : 'claude-opus-5');
const MEDIA_RES = arg('media-res', 'medium');
const SLICES    = Number(arg('slices', 4));
const OVERLAP   = Number(arg('overlap', 0.15));
const DRY       = has('dry-run');
const PHOTOS    = path.resolve(evalRoot, arg('photos', 'photos/test10'));

/* 프롬프트는 v2 고정. 이 도구는 프롬프트를 바꾸지 않는다 (15차 §4). */
const PROMPT_VER = 'v2';
const prompt = PROMPTS[PROMPT_VER];
if (typeof prompt !== 'string') {
  console.error('PROMPTS.v2 가 압축 라인 프롬프트(문자열)가 아닙니다. read.mjs 를 확인하세요.');
  process.exit(1);
}

const MEDIA = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/**
 * 세로 N등분 + 위아래 겹침.
 *   기본 조각 높이 h = H/N. i 번째 조각은 [i*h, (i+1)*h) 에
 *   위아래로 OVERLAP*h 씩 덧붙이고 이미지 경계에서 자른다.
 *   -> 이웃한 두 조각은 2*OVERLAP*h 만큼 겹친다 (기본 30% of h).
 * 순수 함수 — 아래 selfTest() 가 이것만 따로 검증한다.
 */
export function sliceBoxes(height, n = SLICES, ov = OVERLAP) {
  const h = height / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const top = Math.max(0, Math.round(i * h - ov * h));
    const bottom = Math.min(height, Math.round((i + 1) * h + ov * h));
    out.push({ index: i + 1, top, height: bottom - top, bottom });
  }
  return out;
}

/* 조각 파일명: 원본 basename + 조각 번호만. 라벨·정답 정보는 넣지 않는다. */
export const cropName = (orig, i, n) =>
  `${path.basename(orig, path.extname(orig))}__s${i}of${n}${path.extname(orig)}`;

async function withRetry(fn) {
  let last;
  for (let i = 0; i < 4; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const st = e.status ?? e.response?.status;
      if (![429, 500, 502, 503, 529].includes(st)) throw e;
      if (i < 3) await new Promise(r => setTimeout(r, 2000 * 2 ** i));
    }
  }
  throw last;
}

async function callGemini(mediaType, data) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 가 없습니다 (유료 티어 키만 — README §API 키)');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: mediaType, data } }, { text: prompt }] }],
    generationConfig: {
      temperature: 0, maxOutputTokens: 8000,
      mediaResolution: `MEDIA_RESOLUTION_${MEDIA_RES.toUpperCase()}`,
    },
  };
  const res = await withRetry(async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    if (!r.ok) { const e = new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`); e.status = r.status; throw e; }
    return r.json();
  });
  const text = (res.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  const u = res.usageMetadata || {};
  return { text, usage: { input_tokens: u.promptTokenCount ?? 0, output_tokens: u.candidatesTokenCount ?? 0 } };
}

async function callAnthropic(mediaType, data) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  callAnthropic.client ??= new Anthropic();
  const res = await withRetry(() => callAnthropic.client.messages.create({
    model: MODEL, max_tokens: 8000, temperature: 0,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
      { type: 'text', text: prompt },
    ] }],
  }));
  return {
    text: res.content.filter(b => b.type === 'text').map(b => b.text).join(''),
    usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
  };
}
const CALL = { gemini: callGemini, anthropic: callAnthropic };

async function main() {
  if (!CALL[PROVIDER]) { console.error(`알 수 없는 프로바이더: ${PROVIDER}`); process.exit(1); }
  if (!fs.existsSync(PHOTOS)) { console.error(`사진 폴더가 없습니다: ${PHOTOS}`); process.exit(1); }
  const files = fs.readdirSync(PHOTOS).filter(f => MEDIA[path.extname(f).toLowerCase()]).sort();
  if (!files.length) { console.error(`사진이 없습니다: ${PHOTOS}`); process.exit(1); }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const cropDir = path.join(evalRoot, 'crops', stamp);
  fs.mkdirSync(cropDir, { recursive: true });

  const out = {
    provider: PROVIDER, model: MODEL, prompt_ver: PROMPT_VER,
    media_res: PROVIDER === 'gemini' ? MEDIA_RES : null,
    created_at: new Date().toISOString(),
    input_form: { kind: 'vertical-crop', slices: SLICES, overlap: OVERLAP, crop_dir: path.relative(evalRoot, cropDir) },
    photos: {},
  };

  let calls = 0;
  for (const f of files) {
    const src = path.join(PHOTOS, f);
    const meta = await sharp(src).metadata();
    const boxes = sliceBoxes(meta.height);
    const ext = path.extname(f).toLowerCase();

    const items = [];
    const crops = [];
    let inTok = 0, outTok = 0, err = null;

    for (const b of boxes) {
      const name = cropName(f, b.index, SLICES);
      const dst = path.join(cropDir, name);
      await sharp(src).extract({ left: 0, top: b.top, width: meta.width, height: b.height }).toFile(dst);
      const rec = { crop: name, box: b, source_size: { width: meta.width, height: meta.height } };

      if (DRY) { crops.push(rec); continue; }
      const t0 = Date.now();
      try {
        const { text, usage } = await CALL[PROVIDER](MEDIA[ext], fs.readFileSync(dst).toString('base64'));
        calls++;
        inTok += usage.input_tokens; outTok += usage.output_tokens;
        rec.latency_ms = Date.now() - t0; rec.usage = usage;
        const { items: its, dropped } = parseItems(text);
        rec.dropped_lines = dropped.length;
        if (dropped.length) rec.dropped = dropped;
        for (const it of its) items.push({ ...it, from_crop: b.index });
        rec.items = its.length;
        console.log(`  ✓ ${name} — 문항 ${its.length}개${dropped.length ? `, ⚠️ 버린 줄 ${dropped.length}` : ''}, ${rec.latency_ms}ms`);
      } catch (e) {
        calls++;
        rec.error = String(e.message || e); rec.latency_ms = Date.now() - t0;
        err = err || rec.error;
        console.log(`  ✗ ${name} — ${rec.error}`);
      }
      crops.push(rec);
    }

    /* 겹침으로 같은 번호가 두 조각에서 나온 경우 — 지우지 않고 census 만 적는다 */
    const seen = new Map();
    for (const it of items) {
      if (!seen.has(it.item_no)) seen.set(it.item_no, []);
      seen.get(it.item_no).push(it);
    }
    const dupes = [...seen.entries()].filter(([, v]) => v.length > 1)
      .map(([no, v]) => ({
        item_no: no,
        occurrences: v.map(x => ({ from_crop: x.from_crop, mark: x.mark, work: x.work,
                                   mark_confidence: x.mark_confidence, work_confidence: x.work_confidence })),
        agree: new Set(v.map(x => x.mark)).size === 1 && new Set(v.map(x => x.work)).size === 1,
      }));

    out.photos[f] = {
      items,                                   // 중복 포함. 정책은 채점기가 정한다
      crops,
      dropped_lines: crops.reduce((a, c) => a + (c.dropped_lines || 0), 0),
      crop_duplicates: dupes,
      usage: { input_tokens: inTok, output_tokens: outTok },
      ...(err && !items.length ? { error: err } : {}),
    };
    const d = dupes.length ? `, 겹침 중복 ${dupes.length}문항(불일치 ${dupes.filter(x => !x.agree).length})` : '';
    console.log(`${f} — 조각 ${boxes.length}, 문항 ${items.length}${d}`);
  }

  fs.mkdirSync(path.join(evalRoot, 'runs'), { recursive: true });
  const outFile = path.join(evalRoot, 'runs', `${stamp}-${MODEL}-${PROMPT_VER}-crop${SLICES}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

  const allDupes = Object.values(out.photos).flatMap(p => p.crop_duplicates || []);
  console.log(`\n조각 이미지: ${path.relative(process.cwd(), cropDir)}`);
  console.log(`저장: ${path.relative(process.cwd(), outFile)}   (API 호출 ${calls}회)`);
  if (allDupes.length) {
    console.log(`\n⚠️ 겹침 구간에서 같은 문항이 두 번 나온 사례 ${allDupes.length}건 ` +
                `(값 불일치 ${allDupes.filter(d => !d.agree).length}건). 지우지 않고 남겼습니다 —`);
    console.log(`   채점 전에 중복 정책을 정하세요. 지금 도구마다 다릅니다:`);
    console.log(`   compare_runs=둘 다 보존 · tools/diff_runs=첫 줄 채택 · measure=마지막 줄 채택`);
  }
  console.log(`\n다음: node measure.mjs --run ${path.relative(evalRoot, outFile)} --labels labels.json`);
}

/* --self-test: 이미지도 API 도 없이 자르기 기하만 검증한다 */
function selfTest() {
  let fail = 0;
  const chk = (c, m) => { if (!c) { console.log(`  ✗ ${m}`); fail++; } else console.log(`  ✓ ${m}`); };
  const H = 4000, b = sliceBoxes(H, 4, 0.15);
  chk(b.length === 4, '조각 4개');
  chk(b[0].top === 0, '첫 조각은 위쪽 경계에서 시작');
  chk(b[3].bottom === H, '마지막 조각은 아래쪽 경계에서 끝');
  chk(b.every(x => x.height > 0 && x.top >= 0 && x.bottom <= H), '모든 조각이 이미지 안에 있다');
  for (let i = 1; i < b.length; i++) {
    const ovPx = b[i - 1].bottom - b[i].top;
    chk(Math.abs(ovPx - 2 * 0.15 * (H / 4)) <= 1, `조각 ${i}/${i + 1} 겹침 ${ovPx}px (기대 ${2 * 0.15 * H / 4}px)`);
  }
  const covered = new Array(H).fill(false);
  for (const x of b) for (let y = x.top; y < x.bottom; y++) covered[y] = true;
  chk(covered.every(Boolean), '세로 전 구간이 최소 한 조각에 덮인다 (빈틈 없음)');
  chk(cropName('188_13.jpg', 2, 4) === '188_13__s2of4.jpg', `조각 파일명 규칙 (${cropName('188_13.jpg', 2, 4)})`);
  chk(!/label|answer|circle|slash/i.test(cropName('188_13.jpg', 2, 4)), '조각 파일명에 라벨 정보 없음');
  console.log(fail ? `\n실패 ${fail}건` : '\n자르기 기하 self-test 통과');
  process.exit(fail ? 1 : 0);
}

if (has('self-test')) selfTest();
else main().catch(e => { console.error(e); process.exit(1); });
