/**
 * 전송 바이트 감사기 — 가설 3(전송 이미지 열화) 용. API 0회로 돌릴 수 있다.
 *
 *   "4032×3024 파일을 보냈다"와 "모델이 그 세부를 봤다"는 다른 명제다.
 *   이 모듈은 그 사이를 실제 바이트로 메운다:
 *     ① 요청 본문을 그대로 저장 (API 키는 가린다)
 *     ② inline_data 의 base64 를 디코드해 이미지로 되돌린다 → 육안 비교용
 *     ③ 원본 파일과 sha256·바이트·해상도를 대조한다
 *     ④ 응답의 usageMetadata 를 통째로 남긴다 (promptTokensDetails 포함)
 *
 *   ⚠️ usage.promptTokenCount 는 텍스트 프롬프트를 포함한다. "장당 몇 토큰이
 *   이미지에 배정됐나"는 그 숫자에서 바로 읽을 수 없다. 모달리티별 내역
 *   (promptTokensDetails) 이 있으면 그걸 쓰고, 없으면 텍스트 전용 기준선을
 *   따로 재야 한다 — summary 에 둘 다 적는다.
 *
 *   산출물은 eval/requests/<ts>/ 에 떨어진다. 지면 사진 바이트가 들어 있으므로
 *   .gitignore 에 있어야 한다 (eval/requests/).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** inline_data/base64 를 자리표시자로 바꾼 사본 — 본문 JSON 을 사람이 읽을 수 있게 */
function redactBody(body) {
  const clone = structuredClone(body);
  for (const c of clone.contents || []) {
    for (const p of c.parts || []) {
      const d = p.inline_data || p.inlineData;
      if (d?.data) d.data = `<base64 ${d.data.length} chars — 같은 이름의 .sent.* 파일 참조>`;
    }
  }
  for (const m of clone.messages || []) {           // anthropic 모양
    for (const p of m.content || []) {
      if (p.source?.data) p.source.data = `<base64 ${p.source.data.length} chars — .sent.* 참조>`;
    }
  }
  return clone;
}

export function makeDumper({ enabled, outRoot, stamp }) {
  if (!enabled) return null;
  const dir = path.join(outRoot, 'requests', stamp);
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];

  return {
    dir,
    /**
     * @param name    산출물 접두어 (보통 사진/조각 파일명)
     * @param ctx     { url, headers, body, base64, mediaType, sourcePath }
     * @param sharp   sharp 모듈 (해상도 비교용, 없으면 생략)
     */
    async request(name, ctx, sharp) {
      const base = path.join(dir, name);
      fs.mkdirSync(path.dirname(base), { recursive: true });

      const headers = { ...(ctx.headers || {}) };
      for (const k of Object.keys(headers)) {
        if (/key|authorization|token/i.test(k)) headers[k] = '<redacted>';
      }
      fs.writeFileSync(`${base}.request.json`,
        JSON.stringify({ url: ctx.url, headers, body: redactBody(ctx.body) }, null, 2));

      const sentBuf = Buffer.from(ctx.base64, 'base64');
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[ctx.mediaType] || '.bin';
      const sentPath = `${base}.sent${ext}`;
      fs.writeFileSync(sentPath, sentBuf);

      const srcBuf = ctx.sourcePath && fs.existsSync(ctx.sourcePath) ? fs.readFileSync(ctx.sourcePath) : null;
      const dim = async (p) => {
        if (!sharp) return null;
        try { const m = await sharp(p).metadata(); return `${m.width}x${m.height}`; } catch { return null; }
      };
      const row = {
        name,
        source: srcBuf ? { bytes: srcBuf.length, sha256: sha256(srcBuf), size: await dim(ctx.sourcePath) } : null,
        sent: { bytes: sentBuf.length, sha256: sha256(sentBuf), size: await dim(sentPath) },
        base64_chars: ctx.base64.length,
        media_resolution: ctx.body?.generationConfig?.mediaResolution ?? null,
        // 파트별 설정이 따로 붙어 있는지 — global 만인지 확인하기 위해 그대로 본다
        part_level_media_resolution: (ctx.body?.contents || [])
          .flatMap(c => c.parts || [])
          .map(p => p.mediaResolution ?? p.media_resolution ?? null)
          .filter(v => v !== null),
        identical_to_source: srcBuf ? sha256(srcBuf) === sha256(sentBuf) : null,
        sent_file: path.relative(dir, sentPath),
      };
      rows.push(row);
      return row;
    },

    /** 응답 원본 — usageMetadata 를 통째로 남긴다 */
    response(name, res) {
      const base = path.join(dir, name);
      fs.writeFileSync(`${base}.response.json`, JSON.stringify(res, null, 2));
      const row = rows.find(r => r.name === name);
      if (row) {
        const u = res?.usageMetadata || {};
        row.usage = {
          promptTokenCount: u.promptTokenCount ?? null,
          candidatesTokenCount: u.candidatesTokenCount ?? null,
          totalTokenCount: u.totalTokenCount ?? null,
          promptTokensDetails: u.promptTokensDetails ?? null,   // ← 모달리티별 내역
        };
        const img = (u.promptTokensDetails || []).find(d => String(d.modality).toUpperCase() === 'IMAGE');
        row.image_tokens = img?.tokenCount ?? null;
      }
    },

    writeSummary() {
      const file = path.join(dir, '_summary.json');
      fs.writeFileSync(file, JSON.stringify({ created_at: new Date().toISOString(), rows }, null, 2));

      const w = (s, n) => String(s ?? '-').padEnd(n);
      console.log(`\n전송 바이트 감사 — ${path.relative(process.cwd(), dir)}`);
      console.log(`${w('파일', 26)}${w('원본bytes', 11)}${w('전송bytes', 11)}${w('동일', 6)}${w('원본px', 12)}${w('전송px', 12)}${w('img토큰', 9)}${w('prompt토큰', 11)}`);
      for (const r of rows) {
        console.log(
          w(r.name.slice(0, 25), 26) +
          w(r.source?.bytes, 11) + w(r.sent.bytes, 11) +
          w(r.identical_to_source === null ? '-' : (r.identical_to_source ? 'yes' : 'NO'), 6) +
          w(r.source?.size, 12) + w(r.sent.size, 12) +
          w(r.image_tokens, 9) + w(r.usage?.promptTokenCount, 11));
      }
      const noDetail = rows.some(r => r.usage && r.image_tokens === null);
      if (noDetail) {
        console.log('\n⚠️ 응답에 promptTokensDetails(모달리티별 내역)가 없어 이미지 토큰을 분리하지 못한 행이 있습니다.');
        console.log('   promptTokenCount 는 텍스트 프롬프트를 포함합니다 — 그대로 "장당 이미지 토큰"으로 읽지 마세요.');
        console.log('   분리하려면 같은 프롬프트를 이미지 없이 1회 호출해 텍스트 기준선을 빼야 합니다.');
      }
      const mr = [...new Set(rows.map(r => r.media_resolution))];
      const pl = rows.flatMap(r => r.part_level_media_resolution);
      console.log(`\nmediaResolution: generationConfig=${JSON.stringify(mr)} · 파트별 설정 ${pl.length ? JSON.stringify(pl) : '없음(global 만)'}`);
      console.log(`요약: ${path.relative(process.cwd(), file)}`);
      return file;
    },
  };
}
