# ASR CER 분석 — gemini35-live-10p-highjudge-20260820 (high judge 재산정)

*생성 시각:* 2026-08-20T00:00:00Z (high reasoning 재산정)
*기반 데이터:* `runtime.json` 216샘플 (fingerprint `9ab9e98752155a83cda100fc121f1b952474c82c1a20607887d9eb774855d110`) + `translation-provider-details.jsonl` Live 성공 640건 + `judge-normalized.jsonl` high judge (reasoning effort `high`) 6463 ok / penalty = critical×25+major×5+minor×1
*번역문 동일성:* 번역문은 `gemini35-live-two-voice-20260817` (medium judge) 와 100% 동일 — 640 Live 셀 전사/번역 재사용, judge만 `openrouter-batch` `google/gemini-3.7-flash:batch` `reasoning={enabled:true, effort:"high"}` 로 재심사. 2건 judge 실패는 양쪽 런 동일 (`ctx2-single-use-pragmatic_intent_resolution-003::en`, `ctx3-single-ignore-stale_context_resistance-001::en`).
*TTS 동결:* `Qwen3-TTS-12Hz-0.6B-CustomVoice` (sohee/uncle_fu) / TTS manifest `output/tts-assets/gemba-mqm-context-v1-two-voice/manifest.json` SHA256 `98779efb78936b92…` / datasetFingerprint `9ab9e987…5110` (런 manifest 기준). TTS manifest 파일 내부 `datasetFingerprintSha256` 필드는 `765b89dc…` 로 기록되어 있으나 런 검증은 `9ab9e987` 로 통과 (fork 직전 `9432633` 복원 상태) — 음성-원문 대조 SHA256은 양쪽 모두 일치.
*검증:* runtime 원문 ↔ provider-details 전사 누적 동치 (`src/gemini-live-translate.ts:444 accumulateTranscript` 동일 로직) — source run (`gemini35-live-two-voice-20260817`, repo에서 삭제됨) 의 ASR-CER-detail 640행 CER을 그대로 재사용; CER+penalty 결합은 `ASR-CER-highjudge-join.jsonl`. 재현 스크립트 `cer_highjudge_recalc.mjs` (Node 22, 무의존성).
*대조 기준:* source run 의 `ASR-CER-analysis.md` (v2-strict, medium judge; repo에서 삭제됨) 와 동일 CER 정의, penalty만 high로 교체.

## 0. 방법론 — 원본과 동일

### 0.1 Reference
- `runtime.json` 의 `contextTurns[].sourceText` 및 `currentSource.sourceText` (한국어). 정규화 `trim()` 만.

### 0.2 Hypothesis — Live 전사 누적
- `translation-provider-details.jsonl` 의 `input_transcription_events` (Live `inputTranscription` 스트리밍 델타) 를 `accumulateTranscript` 로 누적:
```ts
let acc='';
for(const f of fragments){
  if(f.length===0) continue;
  if(f.startsWith(acc)) acc=f;
  else if(acc.endsWith(f)) continue;
  else acc+=f;
}
return acc;
```
- current 가설: `turnKind==='current'` 만 필터 → accumulate → trim
- context 가설: `turnIndex` 별 각각 누적 후 공백 1칸으로 결합
- Live 불명확 구간 `?`(U+003F)는 1문자로 CER에 반영

### 0.3 CER
`CER = (S+D+I)/N`, `N=Array.from(ref).length` (코드포인트), Levenshtein 2행 DP. trim 후 값 기준.

### 0.4 페어링·제외
- `sampleId::targetLang` 으로 CER detail 640행과 high judge 640행 1:1 조인. Live 성공 640 중 judge 실패 2건 제외 → 분모 638 (샘플 커버리지 214/216 — 2샘플은 번역 자체가 3언어 전부 타임아웃으로 전사 없음).

### 0.5 버킷·통계
- 버킷: [0,0.05), [0.05,0.15), [0.15,0.30), [0.30,0.60), [0.60,∞). penalty는 `summary.total_penalty`. 상관은 Pearson r.

---

## 1. 전체 CER 요약 (per-record, trim 후) — CER은 동일, penalty만 변경

| 구간 | n | mean | median | p10 | p90 | max | std |
|---|---|---|---|---|---|---|---|
| **current** | 640 | 0.112 | 0.077 | 0.000 | 0.190 | 1.500 | 0.166 |
| **context** (per-turn joined) | 640 | 0.089 | 0.065 | 0.009 | 0.149 | 2.696 | 0.158 |
| **combined** | 640 | 0.092 | 0.074 | 0.029 | 0.142 | 1.556 | 0.114 |

- trim-exact: 71/640 = 11.1% (동일)
- `?` 포함 current: 102/640 (동일)
- 입력 언어코드 이상: 20/640 (3.1%) — Live가 한국어 음성을 `ja`(154 이벤트) 또는 `en`(15 이벤트)로 라벨링 (동일)
- per-sample current CER(mean across langs, 214 샘플): mean 0.112 median 0.077 — 동일 원문도 타깃 언어별 세션 변동 평균 max-min 폭 0.046

---

## 2. CER 버킷 × 번역 품질 (high judge)

버킷은 current CER(trim) 기준 per-record 640. `judged` 는 high judge에서 `status==='ok'` 인 것만 (2건 실패 제외).

| 버킷 | n (비중) | judged | penalty mean (high) | median | p90 | max | context_behavior (high) | old mean (동일 slice) | Δ(high−old) |
|---|---|---|---|---|---|---|---|---|---|
| 0-5% [0,0.05) | 218 (34.1%) | 217 | 3.00 | 1.0 | 6.0 | 25 | used:117 missed:16 ignored:71 misused:13 | 3.24 | −0.23 |
| 5-15% [0.05,0.15) | 313 (48.9%) | 312 | 3.63 | 2.0 | 7.0 | 26 | used:183 missed:21 ignored:100 misused:8 | 3.75 | −0.12 |
| 15-30% [0.15,0.30) | 79 (12.3%) | 79 | 4.23 | 5.0 | 7.0 | 25 | used:43 missed:6 ignored:19 misused:11 | 4.84 | −0.61 |
| 30-60% [0.30,0.60) | 17 (2.7%) | 17 | 5.24 | 5.0 | 11.0 | 25 | used:12 missed:1 ignored:2 misused:1 (+unclear 1) | 6.00 | −0.76 |
| 60%+ [0.60,∞) | 13 (2.0%) | 13 | 12.85 | 5.0 | 30.0 | 30 | used:6 missed:3 ignored:1 misused:1 (+unclear 2) | 16.62 | −3.77 |

- 클린(≤0.05, 경계 포함) 224건 → judged 223건: **penalty mean 2.99 median 1.0 p90 6 max 25** (old 3.23 median 1.0 p90 7)
- 더티(>0.05) 416건 → judged 415건: mean 4.12 median 3.0 (old 4.46) — **클린−더티 격차 high 1.13, old 1.23**
- 전체 Live judged 638건: **mean 3.72 median 2.0** (old 4.03 median 2.0) — high가 평균 −0.31 관대
- 상관: **r(cur,penalty)=0.29** (old 0.36), r(ctx,penalty)=0.03 (old 0.03), r(combined,penalty)=0.13 (old 0.15) — 약한 양의 상관 유지, high에서 더 약함 (R²≈0.084)

> **해석:** high reasoning judge는 전반적으로 관대하며, 특히 CER 꼬리(60%+)에서 −3.77 완화. 그러나 클린 구간에서도 penalty 2.99는 텍스트 LLM보다 여전히 5~10배 높음 — 전사 오류가 주원인이 아니라는 결론은 유지.

---

## 3. 5% 이내 headline 재산정 (번역문 동일, judge만 교체)

| 정의 | n | high mean (judged) | old mean (judged) | Δ |
|---|---|---|---|---|
| **≤5% [0,0.05] 종래 headline** | 224 → 223 judged (1건 judge 실패 제외) | **2.991** | 3.233 | **−0.242** |
| **0-5% [0,0.05) 엄밀** | 218 → 217 judged | **3.005** | 3.235 | **−0.230** |

- 동일 224 샘플에서 타 참가자의 high vs full 평균 차이: Live −0.73이 가장 큼 (샘플 자체가 쉬운 편 + high의 꼬리 관대함). 타 모델: gemma4-31b −0.04, 26B −0.12, deepseek −0.09, E4B fp16 −0.25, Q4 +0.00, papago −0.11, MiLMMT −0.30, deepl −0.16, google −0.51.

### 동일 224 샘플에서 타 참가자 성적 (high judge, 동일 샘플 집합)

| System | 전체 mean (n) | CER≤5% 224샘플 mean (동일 샘플) | Δ |
|---|---|---|---|
| Gemma 4 31B | 0.353 (648) | 0.313 (224) | −0.041 |
| Gemma 4 26B | 0.387 (648) | 0.272 (224) | −0.115 |
| DeepSeek V4 Flash 0731 | 0.571 (648) | 0.482 (224) | −0.089 |
| Gemma 4 E4B fp16 | 1.353 (648) | 1.103 (224) | −0.251 |
| Gemma 4 E4B QAT Q4 | 1.577 (648) | 1.580 (224) | +0.003 |
| Papago Web | 2.699 (648) | 2.589 (224) | −0.110 |
| MiLMMT 46-4B X0 | 3.087 (647) | 2.790 (224) | −0.296 |
| **Gemini 3.5 Live Translate** | **3.723 (638)** | **2.991 (223)** | **−0.732** |
| DeepL API | 3.914 (642) | 3.754 (224) | −0.160 |
| Google Basic | 5.731 (648) | 5.223 (224) | −0.508 |

> **결론:** CER≤5% 클린 subset에서도 Live 2.99는 **Papago 2.59 / MiLMMT 2.79보다 높고**, 텍스트 LLM(0.27~1.58)보다 2~10배 높음. 원본 README의 "Even on the CER ≤5% subset (224 cells) its penalty is 3.219 — still far above" 는 high에서 **2.991 — still far above** 로 완화되나 서술 유지.

---

## 4. Per-sentence 상세 (high judge penalty)

`?` = U+003F (Live 미확정), CER=lev/refLen. 전사(hyp)는 원본과 100% 동일, penalty만 high.

### 4.1 Worst 15 (CER 높은 순) — high penalty

| # | sampleId → lang | refCurrent | hypCurrent | len | CER | penalty (high) | penalty (old) | ctxBeh (high) | langMismatch |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `ctx1-dyadic-use-register_carryover-001→en` | 알았어. | 아. 알았어. 어. | 4 | 1.500 | 2 | 2 | used_correctly | no |
| 2 | `ctx1-dyadic-use-register_carryover-001→ja` | 알았어. | 아. 알았어. 어. | 4 | 1.500 | 2 | 2 | used_correctly | no |
| 3 | `ctx1-dyadic-use-register_carryover-001→zh-Hans` | 알았어. | 아. 알았어. 어. | 4 | 1.500 | 2 | 10 | used_correctly | no |
| 4 | `ctx1-dyadic-use-pragmatic_intent_resolution-003→zh-Hans` | 아, 됐어요. | 어 네. 다들 지쳤다. | 7 | 1.429 | 30 | 50 | missed_required_context | no |
| 5 | `ctx1-dyadic-use-referent_resolution-004→zh-Hans` | 어? 아까 막내가 엄청 맛있게 먹던데. | おあお母さん末っ子がめっちゃ美味しく食べてたんだ | 21 | 1.143 | 5 | 5 | used_correctly | YES (ja) |
| 6 | `ctx1-dyadic-use-pragmatic_intent_resolution-003→ja` | 아, 됐어요. | 아 어 다들 지쳤다. | 7 | 1.143 | 30 | 25 | missed_required_context | no |
| 7 | `ctx1-dyadic-use-referent_resolution-004→en` | 어? 아까 막내가 엄청 맛있게 먹던데. | おあおっか末っ子がめっちゃ美味しく食べてたんで | 21 | 1.095 | 6 | 12 | used_correctly | YES (ja) |
| 8 | `ctx1-single-use-register_carryover-001→en` | 진짜 가지가지 한다. | 本当恥ずかしいんだ 。 | 11 | 1.000 | 5 | 5 | used_correctly | YES (ja) |
| 9 | `ctx1-dyadic-use-pragmatic_intent_resolution-003→en` | 아, 됐어요. | 어 다들 지쳤다. | 7 | 1.000 | 25 | 25 | unclear | no |
| 10 | `ctx1-dyadic-use-temporal_or_causal_linkage-003→ja` | 치실까지 아까 다 했지. | 칫솔 가져왔다 했지? 응. | 13 | 0.769 | 25 | 25 | unclear | no |
| 11 | `ctx1-dyadic-use-register_carryover-002→en` | 물어보나 마나지. | 뭐라거나 말하지? | 9 | 0.667 | 5 | 5 | ignored_irrelevant_context | no |
| 12 | `ctx1-dyadic-use-temporal_or_causal_linkage-003→en` | 치실까지 아까 다 했지. | 칫솔 가져왔고 다 했지? | 13 | 0.615 | 5 | 25 | missed_required_context | no |
| 13 | `ctx1-dyadic-use-temporal_or_causal_linkage-003→zh-Hans` | 치실까지 아까 다 했지. | 칫솔 가져왔다 했지? | 13 | 0.615 | 25 | 25 | misused_context | no |
| 14 | `ctx1-dyadic-use-register_carryover-002→ja` | 물어보나 마나지. | 뭐라거나 말하지. | 9 | 0.556 | 25 | 25 | unclear | no |
| 15 | `ctx1-dyadic-use-register_carryover-002→zh-Hans` | 물어보나 마나지. | 뭐라거나 말하지. | 9 | 0.556 | 5 | 25 | ignored_irrelevant_context | no |

- high는 꼬리에서 종종 50→30, 25→5 로 완화되나 일부는 25→30 으로 상향 — 일관된 완화 아님.

### 4.2 Best 5 (CER 0) — high penalty

| # | sampleId → lang | refCurrent | hypCurrent | CER | penalty (high) | penalty (old) | inputLang |
|---|---|---|---|---|---|---|---|
| 1 | `ctx1-single-use-sense_disambiguation-003→en` | 너무 귀찮아서 폰에 그냥 가짜 번호 하나 대충 찍어주고 바로 화장실로 튀었지. | (동일) | 0.000 | 1 | 5 | ko |
| 2 | `ctx1-single-use-sense_disambiguation-003→ja` | (동일) | (동일) | 0.000 | 0 | 1 | ko |
| 3 | `ctx1-single-use-sense_disambiguation-003→zh-Hans` | (동일) | (동일) | 0.000 | 2 | 5 | ko |
| 4 | `ctx1-single-use-pragmatic_intent_resolution-001→en` | 진짜 내 인생 참 잘 돌아간다. | (동일) | 0.000 | 5 | 5 | ko |
| 5 | `ctx1-single-use-pragmatic_intent_resolution-001→ja` | (동일) | (동일) | 0.000 | 5 | 6 | ko |

> 전사 완벽해도 penalty 0–5 — high는 일부를 5→0~2 로 낮추나, 번역 실패는 전사와 독립이라는 결론 유지.

---

## 5. 문맥 CER과 게이트 — 동일

- context mean 0.089 < current 0.112 — 초반 턴이 더 안정 (동일).
- 게이트 무관: CER 0-5% 버킷에서도 misused 13건 (high) — 전사 깨끗해도 불필요 문맥 오용은 별개.

---

## 6. 재현

- CER+penalty 결합: standalone 스크립트 `cer_highjudge_recalc.mjs` (Node 22, 무의존성) — 이 런의 `translation-provider-details.jsonl` 전사 누적과 `judge-normalized.jsonl` penalty를 결합해 `reports/ASR-CER-highjudge-join.jsonl` (640행) 생성.
- per-bucket 통계 / Pearson r: standalone 스크립트 `cer_high_md.mjs` — join 파일과 bucket 정의를 입력받아 이 문서의 통계를 출력.
- 스크립트 원본은 분석 작업 환경의 임시 디렉터리에 있으며 공개 릴리스에는 포함되지 않는다; 결합 결과와 요약은 `reports/` 에 그대로 보존된다.
SHA (hex 16):
- runtime.json (high run) `9ab9e98752155a83…` (이 분석의 reference)
- TTS manifest `98779efb78936b92…` (파일 전체)
- provider-details `9b77610cdbe9445b…`
- judge-normalized (high) `13fdb586288a11f8…`
- CER detail (v2) `ed1d19b8d634fa50…` 와 동일 (CER 재계산 없음)

---

## 7. 한계 — 원본 4개 + high 추가 1개

- 음절 단위 CER, 초성/자소 분해 없음. 공백 1문자. `?` 1문자로 계산(정보 손실로 과소 추정 가능).
- 세션 변동: 동일 원문도 타깃 언어별 세션 차이(max-min 평균 0.046).
- 실패 8건 제외로 꼬리 과소 추정. 언어 라벨 오류 3.1%는 CER 꼬리에 포함 — 순수 음성 CER과 분리 해석 필요.
- Per-sample 214/216 — 2샘플 완전 실패는 분모 제외.
- **high judge 한계:** reasoning effort `high` 는 토큰 비용↑·지연↑이며, 꼬리에서 과도하게 관대할 수 있음 (60%+ −3.77). headline 완화(−0.24)는 judge 성향 차이일 수 있어 텍스트 LLM 대비 격차 축소로 해석 시 주의.

---

## 8. 파일 인덱스

- `reports/ASR-CER-analysis-high.md` — 이 문서 (high judge 재산정, UTF-8)
- `reports/ASR-CER-highjudge-join.jsonl` — per-record 640행 (cerCurrent/cerCtx/cerCombined + penaltyHigh/penaltyOld + behHigh/behOld)
- `reports/ASR-CER-summary-high.json` — 요약 통계 (아래)
- 원본 CER: source run (`gemini35-live-two-voice-20260817`) 의 `ASR-CER-detail.jsonl` (640행) / `ASR-CER-analysis.md` (v2-strict, medium judge) — repo에서 삭제되어 `ASR-CER-highjudge-join.jsonl` (CER+penalty 결합) 이 영구 기록
- 원본: `translation-provider-details.jsonl` (640), `runtime.json` (216), `judge-normalized.jsonl` (high, 6468행, 5 fail), `translation-failures.jsonl` (12)

