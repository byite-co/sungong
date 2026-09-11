/**
 * 크롭 재측정 — 입력 형식 하나만 바꾼다 (15차 §3)
 *
 *   가설: 모델이 기호를 못 읽는 게 아니라, 페이지 전체에서 세부를 못 보거나
 *         번호와 기호를 잘못 연결한다.
 *
 *   사진을 세로 N등분(기본 4)하고 위아래로 slice 높이의 15% 씩 겹치게 자른 뒤,
 *   ★ 한 사진의 조각 전부를 **한 요청에 묶어** 보낸다 — 10장이면 10회다.
 *   예산 증가는 이미지를 여러 장 보내는 데서 온다 — 전역 generationConfig.mediaResolution
 *   이 모든 이미지 파트에 적용되므로 조각 4개 = 페이지 1장의 약 4배다.
 *   (파트별 media_resolution 은 미지원이다. --part-media-res 차단 주석 참조.)
 *   생산은 사진당 1회 호출이다. 조각마다 따로 호출해 얻은 정확도는 생산으로
 *   이전되지 않는다(요청당 비용·지연·문맥이 전부 다르다). 그래서 번들이 기본이다.
 *   진단용으로 조각별 귀속이 필요하면 --per-crop (40회) 을 쓰되, 그 수치는
 *   생산 후보가 아니다.
 *
 *   해상도는 전역 --media-res 로만 제어. per-part 는 미지원(2026-09-11 측정).
 *
 *   바뀌는 변수는 입력 형식 하나뿐이다:
 *     - 프롬프트: read.mjs 의 PROMPTS.v2 를 import 해서 그대로 쓴다 (사본 금지 — 드리프트 방지)
 *     - 모델·temperature·media_resolution(high): read.mjs 와 동일 기본값
 *     - 비교 대상은 같은 high 의 전체 페이지 run 이다. medium 과 비교 금지
 *     - 사진당 정확히 1회 호출. 재시도는 429/5xx 전송 실패에만 (결과를 골라 담지 않는다)
 *
 *   사용:
 *     node tools/crop_eval.mjs --photos photos/test10
 *     node tools/crop_eval.mjs --photos photos/test10 --dry-run   # 자르기만, API 0회
 *     node tools/crop_eval.mjs --dump-request --dry-run           # 조각 전송 바이트 감사, API 0회
 *     node tools/crop_eval.mjs --slices 4 --overlap 0.15
 *     node tools/crop_eval.mjs --per-crop                         # 진단용 40회 (생산 후보 아님)
 *     node tools/crop_eval.mjs --crops crops/2026-09-11T11-57-45  # 잘라 둔 조각 재사용
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { PROMPTS, parseItems } from '../read.mjs';
import { makeDumper } from './dump_request.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const evalRoot = path.resolve(here, '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(`--${n}`);

const PROVIDER  = arg('provider', 'gemini');
const MODEL     = arg('model', PROVIDER === 'gemini' ? 'gemini-3.1-flash-lite' : 'claude-opus-5');
/* read.mjs 와 같은 기본값(high) — 크롭 실험은 전체 페이지 high run 과 비교한다.
   medium 과 비교하면 해상도와 입력 형식 두 변수가 섞여 무효다 (2026-09-11 결정). */
const MEDIA_RES = arg('media-res', 'high');
const SLICES    = Number(arg('slices', 4));
const OVERLAP   = Number(arg('overlap', 0.15));
const DRY       = has('dry-run');
const DUMP      = has('dump-request');   // 요청 바이트·응답 usage 원본 (가설 3)
const PER_CROP  = has('per-crop');       // 진단용: 조각마다 따로 호출(사진당 N회). 생산 후보 아님
/* --crops <dir>: 이미 잘라 둔 조각을 재사용한다. 실패한 실행 뒤 다시 돌릴 때
   같은 바이트로 보낸다는 보장이 생기고(덤프로 감사한 그 조각 그대로), 자르기 시간도 아낀다.
   파일명 규칙(<원본>__sIofN.<ext>)으로 원본에 되붙이므로 --slices 가 같아야 한다. */
const REUSE_CROPS = arg('crops', null);
/* per-part media_resolution — 2026-09-11 측정으로 미지원 확정.
   HIGH 도 ULTRA_HIGH 도 400 을 반환한다. 값 문제가 아니라 필드 자체가 미지원이다:
     Invalid value at 'contents[0].parts[0].media_resolution' ... "MEDIA_RESOLUTION_HIGH"
   "필드는 인식되고 값만 거부됨"이라는 앞선 판단은 HIGH 400 으로 반증됐다.
   플래그는 남기고 막는다 — 출시 경로인 Vertex 에서 되살아날 수 있다.
   근거와 미해결 항목: eval/notes/part_level_media_resolution.md
   요청 바디에는 per-part 필드를 넣지 않는다(죽은 코드 방지). */
const PART_MEDIA_RES = arg('part-media-res', null);
if (PART_MEDIA_RES !== null) {
  console.error('--part-media-res 는 현재 지원되지 않습니다. ' +
    'gemini-3.1-flash-lite / Developer API v1main 에서 per-part media_resolution 은 ' +
    'HIGH·ULTRA_HIGH 모두 400 을 반환합니다(2026-09-11 측정). ' +
    'Vertex AI 경로에서 재검증 전까지 사용 금지. ' +
    '전역 --media-res 를 사용하세요.');
  process.exit(2);
}
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

/* 요청 본문 — 이미지 파트 여러 개 + 텍스트 프롬프트 하나. 번들·단건 모두 이걸 쓴다. */
function buildBody(images) {
  /* 파트별 media_resolution 은 넣지 않는다 — 미지원(위 차단 주석 참조). */
  const parts = images.map(({ mediaType, data }) => ({ inline_data: { mime_type: mediaType, data } }));
  parts.push({ text: prompt });
  return {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0, maxOutputTokens: 8000,
      mediaResolution: `MEDIA_RESOLUTION_${MEDIA_RES.toUpperCase()}`,
    },
  };
}

async function callGemini(images, ctx = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 가 없습니다 (유료 티어 키만 — README §API 키)');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = buildBody(images);
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': key };
  if (ctx.dumper) await ctx.dumper.request(ctx.name, {
    url, headers, body, base64: images[0].data, mediaType: images[0].mediaType,
    sourcePath: ctx.sourcePath,
  }, sharp);
  const res = await withRetry(async () => {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) { const e = new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`); e.status = r.status; throw e; }
    return r.json();
  });
  if (ctx.dumper) ctx.dumper.response(ctx.name, res);
  const text = (res.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  const u = res.usageMetadata || {};
  return { text, usage: { input_tokens: u.promptTokenCount ?? 0, output_tokens: u.candidatesTokenCount ?? 0 }, usage_raw: u };
}

async function callAnthropic(images, ctx = {}) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  callAnthropic.client ??= new Anthropic();
  const res = await withRetry(() => callAnthropic.client.messages.create({
    model: MODEL, max_tokens: 8000, temperature: 0,
    messages: [{ role: 'user', content: [
      ...images.map(({ mediaType, data }) =>
        ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })),
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
  const reuseDir = REUSE_CROPS ? path.resolve(evalRoot, REUSE_CROPS) : null;
  if (reuseDir && !fs.existsSync(reuseDir)) {
    console.error(`--crops 폴더가 없습니다: ${reuseDir}`); process.exit(1);
  }
  const cropDir = reuseDir || path.join(evalRoot, 'crops', stamp);
  if (!reuseDir) fs.mkdirSync(cropDir, { recursive: true });
  else console.log(`--crops: 잘라 둔 조각을 재사용합니다 — ${path.relative(process.cwd(), cropDir)}`);
  const dumper = makeDumper({ enabled: DUMP, outRoot: evalRoot, stamp });

  const out = {
    provider: PROVIDER, model: MODEL, prompt_ver: PROMPT_VER,
    media_res: PROVIDER === 'gemini' ? MEDIA_RES : null,
    created_at: new Date().toISOString(),
    input_form: {
      kind: 'vertical-crop', slices: SLICES, overlap: OVERLAP,
      bundled: !PER_CROP,                       // true = 사진당 1회 (생산과 같은 호출 단위)
      calls_per_photo: PER_CROP ? SLICES : 1,
      crop_dir: path.relative(evalRoot, cropDir),
      ...(reuseDir ? { reused_crops: true } : {}),
    },
    ...(PART_MEDIA_RES ? { part_media_res: PART_MEDIA_RES } : {}),
    photos: {},
  };

  let calls = 0;
  for (const f of files) {
    const src = path.join(PHOTOS, f);
    const meta = await sharp(src).metadata();
    const boxes = sliceBoxes(meta.height);
    const ext = path.extname(f).toLowerCase();

    /* 자르기는 항상 먼저. 호출 방식과 무관하게 조각 파일은 남는다(육안 확인용).
       --crops 재사용이면 자르지 않고 기존 파일을 그대로 쓴다 — 같은 바이트가 보장된다. */
    const crops = [];
    for (const b of boxes) {
      const name = cropName(f, b.index, SLICES);
      const dst = path.join(cropDir, name);
      if (reuseDir) {
        if (!fs.existsSync(dst)) {
          console.error(`--crops 에 조각이 없습니다: ${dst}`);
          console.error('  --slices 가 자를 때와 같은지 확인하세요.');
          process.exit(1);
        }
      } else {
        await sharp(src).extract({ left: 0, top: b.top, width: meta.width, height: b.height }).toFile(dst);
      }
      crops.push({ crop: name, path: dst, box: b, source_size: { width: meta.width, height: meta.height } });
    }
    const imagesOf = (recs) => recs.map(r => ({ mediaType: MEDIA[ext], data: fs.readFileSync(r.path).toString('base64') }));

    const items = [];
    const raws = [];
    let inTok = 0, outTok = 0, err = null, dropped_lines = 0;

    /* 호출 단위: 기본은 사진 1회(번들), --per-crop 이면 조각마다 1회 */
    const groups = PER_CROP ? crops.map(c => [c]) : [crops];
    for (const g of groups) {
      const name = PER_CROP ? g[0].crop : f;
      const images = imagesOf(g);
      const t0 = Date.now();

      if (DRY) {
        if (DUMP) await dumper.request(name, {
          url: `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': '<unused>' },
          body: buildBody(images),
          base64: images[0].data, mediaType: MEDIA[ext], sourcePath: g[0].path,
        }, sharp);
        continue;
      }

      try {
        const { text, usage, usage_raw } = await CALL[PROVIDER](images, { name, sourcePath: g[0].path, dumper });
        calls++;
        /* ★ 모델 원본 응답 — 파서를 거치기 전. read.mjs 와 같은 이유(2026-09-11). */
        raws.push({ call: name, text });
        inTok += usage.input_tokens; outTok += usage.output_tokens;
        const { items: its, dropped } = parseItems(text);
        dropped_lines += dropped.length;
        for (const it of its) items.push(PER_CROP ? { ...it, from_crop: g[0].box.index } : { ...it });
        for (const c of g) { c.latency_ms = Date.now() - t0; c.usage = usage; if (usage_raw) c.usage_raw = usage_raw; }
        if (dropped.length) g[0].dropped = dropped;
        console.log(`  ✓ ${name} — 조각 ${g.length}장 한 요청, 문항 ${its.length}개` +
                    `${dropped.length ? `, ⚠️ 버린 줄 ${dropped.length}` : ''}, ${Date.now() - t0}ms`);
      } catch (e) {
        calls++;
        err = err || String(e.message || e);
        for (const c of g) { c.error = String(e.message || e); c.latency_ms = Date.now() - t0; }
        console.log(`  ✗ ${name} — ${e.message || e}`);
      }
    }

    /* 같은 번호가 두 번 나온 경우 — 지우지 않고 census 만 적는다.
       번들에서는 모델이 조각 4장을 한꺼번에 보므로 스스로 한 번만 낼 수도 있고,
       겹침 구간을 두 번 셀 수도 있다. 어느 쪽인지가 이 census 로 드러난다.
       ⚠️ 번들에서는 어느 조각에서 나온 값인지 귀속할 수 없다(출력에 조각 표시가 없다).
          귀속이 필요하면 --per-crop 으로 따로 봐야 한다. */
    const seen = new Map();
    for (const it of items) {
      if (!seen.has(it.item_no)) seen.set(it.item_no, []);
      seen.get(it.item_no).push(it);
    }
    const dupes = [...seen.entries()].filter(([, v]) => v.length > 1)
      .map(([no, v]) => ({
        item_no: no,
        occurrences: v.map(x => ({ ...(x.from_crop ? { from_crop: x.from_crop } : {}),
                                   mark: x.mark, work: x.work,
                                   mark_confidence: x.mark_confidence, work_confidence: x.work_confidence })),
        agree: new Set(v.map(x => x.mark)).size === 1 && new Set(v.map(x => x.work)).size === 1,
      }));

    out.photos[f] = {
      raw: raws,                               // ★ 모델 원본 응답 (호출 단위)
      items,                                   // 중복 포함. 정책은 채점기가 정한다
      crops: crops.map(({ path: _p, ...rest }) => rest),
      dropped_lines,
      crop_duplicates: dupes,
      usage: { input_tokens: inTok, output_tokens: outTok },
      ...(err && !items.length ? { error: err } : {}),
    };
    const d = dupes.length ? `, 겹침 중복 ${dupes.length}문항(불일치 ${dupes.filter(x => !x.agree).length})` : '';
    console.log(`${f} — 조각 ${boxes.length}, 호출 ${groups.length}, 문항 ${items.length}${d}`);
  }

  if (dumper) dumper.writeSummary();
  /* 사진이 전부 실패한 run 은 저장하지 않는다 — 빈 run 파일이 진짜 run 과 헷갈린다 */
  const anyItems = Object.values(out.photos).some(p => (p.items || []).length);
  if (!DRY && !anyItems) {
    console.log('\n⛔ 모든 사진이 실패했습니다 — run JSON 을 저장하지 않습니다.');
    console.log(`   조각 이미지는 남아 있습니다: ${path.relative(process.cwd(), cropDir)}`);
    if (dumper) console.log(`   요청·응답 원본: ${path.relative(process.cwd(), dumper.dir)}`);
    process.exit(1);
  }
  fs.mkdirSync(path.join(evalRoot, 'runs'), { recursive: true });
  /* 파일명에 설정을 전부 넣는다 — 실패한 프로브 run 이 진짜 run 과 헷갈린 전례가 있다 */
  const tags = [`crop${SLICES}`, MEDIA_RES, ...(PART_MEDIA_RES ? [`part_${PART_MEDIA_RES}`] : []),
                ...(PER_CROP ? ['percrop'] : [])];
  const outFile = path.join(evalRoot, 'runs', `${stamp}-${MODEL}-${PROMPT_VER}-${tags.join('-')}.json`);
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

/* 직접 실행일 때만 돈다 — import 시(sliceBoxes·cropName 재사용)는 아무것도 하지 않는다.
   read.mjs 와 같은 규율. 자르기 규칙을 사본이 아니라 import 로 공유하기 위해 필요하다. */
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  if (has('self-test')) selfTest();
  else main().catch(e => { console.error(e); process.exit(1); });
}
