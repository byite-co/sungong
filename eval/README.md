# Phase A — AI 숙제검사 판독 정확도 평가 하네스 (v3.1)

설계서 v3.1 §8의 크리티컬 패스. 사진이 모이는 대로 바로 측정할 수 있게 미리 짜 둔 도구입니다.
**Flutter와 무관하게 지금 돌 수 있습니다.**

Phase A의 질문은 하나입니다 — **"Flash-Lite로 90%가 나오는가"** (§8-4).
그래서 측정 순서는 Flash-Lite 를 가장 먼저, 가장 집요하게. 정확도가 임계치를
넘는 모델끼리만 단가를 비교합니다.

## 실측 기록

**1차 실측 — 2026-08-25 · 54장 · 193문항 · `gemini-3.1-flash-lite` · 통짜 입력**

| mark | % | | work | % |
|---|---|---|---|---|
| circle | 67.9 | | solved | 64.2 |
| slash | 15.5 | | blank | 35.8 |
| triangle | 7.8 | | partial | **0** |
| question | 1.0 | | | |
| check | 0.5 | | | |
| unmarked | 7.3 | | | |

- 분포가 정상 범위 — triangle(7.8%)·question·check 모두 잡힘. **partial 0건**은 지켜볼 것
  (라벨 채점에서 3분류가 사실상 2분류로 동작하는지 확인)
- **비용 실측: 입력 56,474 · 출력 2,734 토큰 / 54장 = 장당 0.47원.**
  구 세션 추정 0.6원과 같은 자릿수 — **인계본의 "원가 두 세트 상충" 문제는 이 실측값으로 정리합니다.**
  이후 원가 논의의 기준은 이 값입니다.

> 확인된 사실 (구 세션 실측):
> - **`gemini-2.5-flash-lite` 는 신규 사용자에게 404 로 막혀 있습니다.** 기본 모델은
>   `gemini-3.1-flash-lite` 입니다.
> - **사진 4분할은 필요 없습니다.** Haiku+4분할 13/16 · Gemini 무분할 13/16 — 동률.
>   Gemini 는 입력 해상도가 3072px(Haiku 1568px)라 분할 없이도 작은 기호를 읽습니다.
>   read.mjs 가 통짜 입력인 것은 의도된 구조입니다. 분할 로직을 추가하지 마세요.

## ⚠️ API 키 — 반드시 Gemini 유료 티어

무료 티어는 **제출한 사진을 Google 모델 학습에 씁니다.** 학생 숙제 사진이 학습 데이터로
들어가는 순간 프라이버시 약속(v3.1 §5)이 무너지고 국내법 문제가 생깁니다.
**평가셋 측정 단계부터 유료 키로 돌리세요.**

## 1. 평가셋 수집 (30~50장)

본인·주변 학생의 채점 완료 숙제를 촬영합니다. 다음이 골고루 섞이게 **의도적으로**:

- **과목** — 수학(식 위주)과 국어·영어(지문 위주)는 레이아웃이 완전히 다릅니다
- **마크** — **사선만 있는 문항**과 **사선 위에 △를 덧그린 문항**을 둘 다 충분히 ← 최대 난관.
  **☆와 ?를 둘 다**(같은 값이지만 형태가 다름) · **✓가 섞인 페이지**도
- **풀이** — 빈칸 · "답만 적힌" · **풀다 만** 문항을 반드시 포함 (work 3분류 검증용)
- **조건** — 밝은 곳 / 어두운 곳 / 그림자 / 비스듬한 각도 / 필기가 겹친 경우
- **문항 수** — 10문항 이하 / 20문항 / 50문항 이상

사진은 `eval/photos/` 에 넣으세요 (jpg·png·webp).

## 2. 정답 라벨 작성

사람이 직접 만듭니다. `labels.example.json` 을 복사해 `labels.json` 으로.
`measure.mjs` 가 파싱하는 형태는 **파일명 → 문항번호 → {mark, work}** 의 중첩 객체
정확히 하나입니다 (배열 아님):

```json
{
  "IMG_0001.jpg": {
    "1": { "mark": "circle",   "work": "solved" },
    "2": { "mark": "slash",    "work": "solved" },
    "3": { "mark": "triangle", "work": "solved" },
    "4": { "mark": "unmarked", "work": "blank" }
  },
  "IMG_0002.jpg": {
    "1": { "mark": "question", "work": "partial" }
  }
}
```

- 최상위 키는 `photos/` 안의 **파일명과 글자 하나까지 같아야** 합니다
  (다르면 measure.mjs 가 측정을 중단하고 경고합니다)
- 문항번호 키는 문자열이어도 됩니다 (`"1"`) — 내부에서 숫자로 비교합니다
- `mark` 6종 (v3.1 §4-4 — 실제 채점 관습):
  - `circle` ○ 정답 · `slash` 사선만(오답) · `triangle` **사선 위에 △ 덧그림(오답→해결)**
  - `question` ☆ 또는 ? (질문) · `check` ✓ (채점과 무관) · `unmarked` 표시 없음
- `work` 3종: `solved` 손글씨 있음 · `blank` 없음 · `partial` 풀다 맘

## 3. 판독 실행

```bash
cd eval && npm install
export GEMINI_API_KEY=...           # 유료 티어!
node read.mjs --photos photos       # 기본: gemini-3.1-flash-lite · media_res medium
node read.mjs --media-res high      # 해상도 비교 (비용 3배 — 정확도 이득과 같이 잴 것)
node read.mjs --provider anthropic --model claude-opus-5   # 교차 비교용
# → runs/<시각>-<모델>-<프롬프트버전>.json
```

- `temperature: 0` 고정 — 프롬프트 효과와 샘플링 노이즈를 분리하기 위해
- `media_resolution` 명시 고정 — 실행 간 토큰이 흔들리지 않게
- 429·529는 지수 백오프로 3회 재시도
- 출력은 압축 포맷(`1:c:s:95:90` 한 줄/문항) — 출력 단가가 입력의 4~8배라 JSON 대비 45~57% 절감
- 대량 재측정은 Gemini **Batch API**(반값)로 돌려도 됩니다 — 평가 실행은 지연을 감당할 수 있음

## 3-1. 정정 루프 — 파일럿 (2026-08-28 지시)

**CC/AI는 라벨을 만들지 않는다.** 판독 → 사람이 보고서를 종이와 대조해 **틀린 것만** 정정 →
정정을 얹어 라벨 확정. 사용자가 손대지 않은 항목 = 판독이 맞았다는 뜻이고,
확인하지 않은 항목은 정답으로 치지 않는다(집계 제외).

```bash
cd eval
export GEMINI_API_KEY=...                              # 파일럿 10장은 무료 티어 허용(스모크 전용)
node read.mjs --photos photos/test10 --prompt v2       # ① v2 판독
node read.mjs --photos photos/test10 --prompt v0       # ② v0 판독 (원본 프롬프트 — 아래 참조)
node compare_runs.mjs --a runs/<v0>.json --b runs/<v2>.json    # ③ v0/v2 비교표
node report_md.mjs --run runs/<v2>.json --tier free    # ④ 정정용 보고서 (results/report_pilot_<ts>.md)
# ⑤ 보고서 §5 형식으로 정정 작성 → corrections.txt (틀린 것만, 없으면 "없음")
node apply_corrections.mjs --run runs/<v2>.json --corrections corrections.txt
#    → dataset/labels/labels_<ts>.json (원 판독 보존 + confirmed 구분)
```

- `--tier free|paid` 는 필수 — 보고서 헤더에 찍힌다. **무료 티어 숫자는 게이트 판정에 쓰지 않는다.**
- 전량 120장은 **유료 전환 후에만.** 이어하기·측정 실패 분리·부트스트랩 신뢰구간은 그 단계에서 추가한다.
- `--confirm critical` (전량 1차 정정용): slash·triangle·unclear_st + 신뢰도 60 미만 + 정정 항목만
  확인됨 처리, 나머지는 미확인으로 남긴다.

**프롬프트 v0** — `byite-co/scheduler` `supabase/functions/ai-homework-check/observation.ts` 의
`OBSERVATION_SYSTEM_PROMPT`(obs-prompt-1) 원문. 개정 4종이 전부 회귀해 살아남은 기준이다
(정확 13/16, 개정판 9~11 — 해당 파일 주석 참조). **한 글자도 고치지 말 것.**
형식 차이: 표시가 있는 문항만 출력(unmarked 없음) · work·확신도 없음 ·
s/t 구분 불가를 `slash_family_unclear`(→`unclear_st`)로 표명 · 한 문항에 표시 두 행 가능.

## 4. 채점

```bash
node measure.mjs                    # 최신 run 자동 선택 (labels.json 기준)
node measure.mjs --run runs/<파일>.json --labels labels.json   # 명시 지정
```

**게이트 다섯 지표 (v3.1 §8-2 — 측정 전에 못 박은 값):**

| 지표 | 임계치 | 분모 |
|---|---|---|
| 문항–마크 결합 정확도 | **≥ 90%** | 라벨 전체 (누락은 오답) |
| 사선만 ↔ 사선+△ 구분 | **≥ 95%** | 라벨이 slash·triangle 이고 읽힌 문항. **방향별로 따로 보고** |
| 문항 번호 누락률 | **≤ 5%** | 라벨 전체 |
| work 3분류 정확도 | **≥ 90%** | 읽힌 문항 (partial 포함 — 라벨 경계가 흔들려 95%가 아니라 90%) |
| 환각 문항 수 | **= 0** | 라벨에 없는 번호를 지어낸 것 |

안전장치:
- 라벨에 있는 사진이 판독 결과에 없으면(파일명 오타) **측정을 중단하고 크게 경고**합니다
- ⚠️ 지표는 함께 읽으세요 — 구분·work의 분모는 "읽힌 문항"이라 **많이 누락하는 모델이
  그 둘에서 유리하게 보입니다.** missRate가 그걸 잡습니다.

## 5. 보고서 — 라벨 없이 (report.mjs)

라벨을 만들기 전에도 "이 모델이 망가졌는가"는 분포로 드러납니다:

```bash
node report.mjs                     # 최신 run 자동 선택
node report.mjs --run runs/<파일>.json   # 명시 지정
# → report.html (사진과 판독을 나란히) + 콘솔 요약 (복사해서 보내면 됨)
```

- 마크/work **분포**, mark × work **조합**(circle × blank 설계 핵심 칸 포함),
  **이상 신호**(triangle 0건 · circle 90%+ · 번호 중복/빈 곳 · 저신뢰 비율 등),
  **사진별 판독**을 한 장의 HTML로 뽑습니다
- 정답 라벨 없이 돌아가므로, 사진만 모이면 **measure 전에 먼저 이걸 돌려**
  모델·프롬프트가 정상 범위에서 동작하는지 확인하세요

## 6. 미달 시

축소하지 않고 보완합니다: 프롬프트 개선(`read.mjs`의 `PROMPTS`에 v3 추가) → 모델 교체 →
촬영 가이드 강화(문항 수 제한·프레임 가이드) → 재측정. **3차 시도 후에도 미달이면 숫자를
그대로 보고하고 결정을 받습니다.** "AI 판독을 빼고 수동 입력으로"라는 축소안은 쓰지 않습니다.

## 알려진 한계 (문서화된 정상 동작)

- **"답만 적힌" 문항은 `solved`로 읽힙니다.** work 판정은 풀이 과정이 아니라 필기 유무만
  봅니다. `circle + blank` 잡기는 빈칸일 때만 성립합니다. 학생 확인 화면에서 고칠 수 있게
  하는 것이 대응입니다 (v3.1 §11).

## 원가 사다리 — 토큰당 정확도로도 비교할 것 (2026-09-11)

파트별 mediaResolution 이 지원되면 선택지가 이렇게 늘어난다. 사진 1장당 입력 이미지 토큰
(문서값 기준. 우리 실측은 이미지 비율 때문에 다소 낮게 나온다 — medium 540 · high 1064):

| 구성 | 장당 이미지 토큰 |
|---|---:|
| HIGH 전체 페이지 | 1120 |
| ULTRA_HIGH 전체 페이지 | 2240 |
| 크롭 4조각 × HIGH (한 요청에 묶음) | ~4480 |
| 크롭 4조각 × ULTRA_HIGH | ~8960 |

**정확도만 보고 고르면 안 된다. 토큰당 정확도로도 비교한다** — 유료 판독의 원가가 여기서 갈린다.

문서 근거: https://ai.google.dev/gemini-api/docs/generate-content/media-resolution
토큰 예산 LOW 280 · MEDIUM 560 · HIGH 1120 · ULTRA_HIGH 2240.
`ULTRA_HIGH` 는 **파트별 전용**이라 `generationConfig` 전역에는 넣을 수 없다.
파트별 설정은 **Gemini 3 전용 · 실험적 기능**이고 Flash-Lite 지원 여부는 문서에 명시가 없다
— 그래서 1회 프로브로 확인한다 (`--part-media-res`).

### 라벨 정정이 프롬프트 순위를 바꾼 관측 (2026-09-11)

medium · 정정 전 라벨에서 v0 37.5% / v2 37.5% 로 같았는데, 라벨 3건 정정 후
**v0 39.5% / v2 44.7%** 로 갈라졌다. 정정이 두 프롬프트에 다르게 작용했다.
GPT 검토의 가설 7(프롬프트 순위가 해상도에 따라 바뀌는가)과 연결되는 지점이지만,
ULTRA_HIGH 프로브가 먼저다 — v0×HIGH 는 아직 돌리지 않는다.
