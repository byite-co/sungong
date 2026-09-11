# per-part `media_resolution` — 미지원 (Developer API v1main)

## 측정

- **측정일:** 2026-09-11
- **모델:** `gemini-3.1-flash-lite`
- **엔드포인트:** Developer API, `v1beta` 경로 / 서버 응답은 `v1main` 스키마를 인용
  (`https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`)
- **시도한 값:** `MEDIA_RESOLUTION_HIGH`, `MEDIA_RESOLUTION_ULTRA_HIGH`
- **결과:** **둘 다 HTTP 400**

```
Invalid value at 'contents[0].parts[0].media_resolution'
  (type.googleapis.com/google.ai.generativelanguage.v1main.MediaResolution),
  "MEDIA_RESOLUTION_ULTRA_HIGH"

Invalid value at 'contents[0].parts[0].media_resolution' ... "MEDIA_RESOLUTION_HIGH"
Invalid value at 'contents[0].parts[1].media_resolution' ...
```

## 판단 경위 — 한 번 잘못 읽었다

ULTRA_HIGH 400 만 보았을 때 "필드는 인식되고 값만 거부됐다"고 읽었다.
그 판단에 따라 "HIGH 는 per-part 로 유효할 것이고, 조각 4개 × HIGH 가 크롭의 실제
메커니즘"이라고 결론지었다.

**HIGH 400 으로 반증됐다.** 값 문제가 아니라 **필드 자체가 미지원**이다.
`Invalid value` 라는 문구만으로 필드 경로의 지원 여부를 추론할 수 없다.

## 지금의 처리

- `--part-media-res` 는 `read.mjs` · `tools/crop_eval.mjs` 양쪽에서 **어떤 값이든 즉시 종료**
  (`exit 2`). 플래그는 지우지 않았다 — 아래 미해결 항목 때문이다.
- 요청 바디를 만드는 코드에서 per-part 필드를 넣는 경로는 **제거**했다(죽은 코드 방지).
- `tools/dump_request.mjs` 의 `part_level_media_resolution` 관측은 **그대로 둔다.**
  재측정할 때 요청에 실제로 무엇이 실려 나갔는지 확인하는 데 쓴다.

## 대체 수단 — 예산은 이미지 장수에서 온다

per-part 설정 없이도 예산은 늘어난다. 전역 `generationConfig.mediaResolution` 이
**모든 이미지 파트에 적용**되므로, 한 요청에 조각 4개를 보내면 페이지 1장의 약 4배다.
`tools/crop_eval.mjs` 가 이 방식(사진당 1회 호출, 조각 N장 묶음)을 쓴다.

## ⛔ 미해결 — Vertex 전환 시 반드시 재측정

위는 **Developer API 기준**이다. Vertex AI 경로의 enum 과 필드 지원은 다를 수 있고,
**출시 경로는 Vertex 다**(Developer API 약관의 18세 미만 조항).

재측정할 때:

1. `--part-media-res` 차단을 풀고 요청 바디에 per-part 필드를 다시 넣는다
   (`buildBody` / `callGemini` — 이 파일을 가리키는 주석이 달려 있다).
2. `--dump-request` 로 요청에 실제로 실려 나갔는지 먼저 확인한다
   (`_summary.json` 의 `part_level_media_resolution`).
3. 200 이 떠도 적용됐다고 단정하지 않는다 — **조용한 무시**가 가장 위험하다.
   이미지 토큰이 전역 HIGH 대비 몇 배인지로 판정한다.
