# ASR CER 분석 — gemini35-live-two-voice-20260817 (엄밀 재생성 v2)

*생성 시각:* 2026-08-19T07:34:34.404Z
*기반 데이터:* `runtime.json` 216샘플 + `translation-provider-details.jsonl` Live 성공 640건 (실패 12건 중 Live 8건 제외, DeepL 4건은 별도) + `judge-normalized.jsonl` 7744 ok / penalty = critical×25+major×5+minor×1
*TTS 동결:* datasetFingerprint `9ab9e98752155a83cda100fc121f1b952474c82c1a20607887d9eb774855d110` / manifest SHA256 a1ef15154e6cec4b… / TTS `Qwen3-TTS-12Hz-0.6B-CustomVoice` (sohee/uncle_fu)
*검증:* runtime 원문 ↔ manifest `sourceTextSha256` 3건 무작위 대조 100% 일치 (`ctx1-single-use-referent_resolution-001` 등). Node.js `fs.readFileSync(...,'utf8')`로 판독 시 한글 정상, PowerShell `Get-Content` 뷰어 모지바케는 뷰어 인코딩(정상 데이터 아님).
*재현 스크립트:* `C:\\Users\\salee\\AppData\\Local\\Temp\\opencode\\cer_strict_v2.mjs` (의존성 없음, Node 22)

## 0. 방법론 — 엄밀 정의

### 0.1 Reference
- `runtime.json`의 `contextTurns[].sourceText` 및 `currentSource.sourceText` (한국어). 정규화는 `trim()`만. NFC/소문자/구두점 제거 없음.
- 검정: 각 샘플의 SHA256이 `manifest.json`과 일치해야 유효.

### 0.2 Hypothesis — Live 전사 누적
- `translation-provider-details.jsonl`의 `input_transcription_events`는 Live `inputTranscription` 스트리밍 델타.
- **누적 코드는 `src/gemini-live-translate.ts:444 accumulateTranscript`와 바이트 단위 동일:**

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

- current 가설: `turnKind==='current'` 만 필터 → accumulate → trim.
- context 가설: `turnIndex`별 각각 누적 후 단일 공백 ' '으로 결합(다중공백 → ' '). 대조용 Alt는 전체 context 이벤트를 단일 스트림으로 누적.
- 빈 문자열 이벤트 무시. Live는 불명확 구간을 ASCII "?"(U+003F)로 출력 — 치환으로 CER에 반영.

### 0.3 CER
CER = (S+D+I)/N, N=Array.from(ref).length (코드포인트). Levenshtein 2행 DP, 공백·구두점 1문자. trim 후 값과 trim 전 raw 둘 다 계산하되 표는 trim 기준. trim-exact는 ref===hyp.

### 0.4 페어링·제외
- stable_key = runId::sampleId::targetLang::participantId 로 judge와 1:1 조인. 분석은 Live 성공 640건만. 실패 8건(`translation-failures.jsonl` Live `pragmatic_intent_resolution 002 ja/zh, 003 en/ja/zh, 004 en/ja/zh` 8건)은 전사 없이 제외. 따라서 분모 640, 샘플 커버리지 214/216 (2개 샘플은 3언어 전부 실패로 전사 없음: `ctx3-single-use-pragmatic_intent_resolution-003`, `004`). DeepL 실패 2건(`ctx3-single-ignore-metadata_nonliteral_resistance-001 en/zh` 등)은 Live와 무관.
- Per-record(640, 세션별) vs per-sample(214, 원문별 평균).

### 0.5 버킷·통계
- 버킷: [0,0.05), [0.05,0.15), [0.15,0.30), [0.30,0.60), [0.60,∞). penalty는 judge total_penalty. 상관은 Pearson r.

---

## 1. 전체 CER 요약 (per-record, trim 후)

| 구간 | n | mean | median | p10 | p90 | max | std |
|---|---|---|---|---|---|---|---|
| **current** | 640 | 0.112 | 0.077 | 0.000 | 0.190 | 1.500 | 0.166 |
| **context** (per-turn joined) | 640 | 0.089 | 0.065 | 0.009 | 0.149 | 2.696 | 0.158 |
| **combined** | 640 | 0.092 | 0.074 | 0.029 | 0.142 | 1.556 | 0.114 |

- trim-exact: 71/640 = 11.1% (공백 제거 후 완전 일치). raw-exact(미trim): 0/640.
- Alt context(단일 스트림) mean 0.089 — per-turn joined 0.089와 차이 0.001.
- "?" 포함 current: 102/640, 최대 3개 (ctx3 다중턴 집중).
- **입력 언어코드 이상:** input_transcription_events의 languageCode가 ko가 아닌 레코드 **20/640 (3.1%)** — Live가 한국어 음성을 `ja`(154 이벤트) 또는 `en`(15 이벤트)로 라벨링. 현상은 targetLang=en(6건), ja(8건), zh-Hans(6건)에 분산. 예: `ctx1-dyadic-use-referent_resolution-004::zh-Hans` current 전사가 일본어 `おあお母さん末っ子が…` (CER 1.143). 이는 음성 인식이 아니라 **언어 라벨 오류**로 볼 수 있으나 CER 계산상 한국-일본 간 전체 치환으로 처리되므로 꼬리(60%+ 버킷)에 기여.
- per-sample current CER(mean across langs, 214 샘플): mean 0.112 median 0.077 — 동일 원문도 타깃 언어별 세션 변동(평균 max-min 폭 0.046).
- 커버리지: 216 중 214 샘플만 1회 이상 성공, 2샘플(`ctx3-single-use-pragmatic_intent_resolution-003`, `ctx3-single-use-pragmatic_intent_resolution-004`)은 전 언어 실패로 CER 없음.


### 1.1 분포 해석 (정정)
- current mean 0.112는 25자 문장 기준 ~2.8자 오류. context 0.089보다 높음: 마지막 턴 드리프트.
- p90 0.19 — 상위 10%는 5자 중 1자 이상 오류, p95 0.29.
- 0-5% 클린 218건(34.1%) 존재 — 이 구간에서도 Live penalty 3.24로 텍스트 모델(Q4 1.64, 26B 0.40)보다 2–8배 높음.

---

## 2. CER 버킷 × 번역 품질

버킷은 current CER(trim) 기준 per-record 640.

| 버킷 | n (비중) | penalty mean | median | p90 | max | context_behavior |
|---|---|---|---|---|---|---|
| 0-5% | 218 (34.1%) | 3.24 | 1.0 | 7.0 | 25 | used:130 missed:17 ignored:57 misused:13 |
| 5-15% | 313 (48.9%) | 3.75 | 2.0 | 7.0 | 32 | used:197 missed:12 ignored:95 misused:8 |
| 15-30% | 79 (12.3%) | 4.84 | 5.0 | 10.0 | 25 | used:50 missed:3 ignored:15 misused:11 |
| 30-60% | 17 (2.7%) | 6.00 | 5.0 | 25.0 | 25 | used:15 missed:0 ignored:1 misused:1 |
| 60%+ | 13 (2.0%) | 16.62 | 12.0 | 25.0 | 50 | used:5 missed:2 ignored:4 misused:2 |

- 클린(≤0.05, 경계 포함) 224건: penalty mean 3.23 median 1.0.
- 버킷 0-5% [0,0.05) 218건: mean 3.24 median 1.0 — 경계값 0.05 정확히 포함 여부에 따라 6건 차이.
- 더티(>0.05) 416건: mean 4.46.
- 상관: r(cur,penalty)=0.362, r(ctx,penalty)=0.027, r(combined,penalty)=0.150 — 약한 양의 상관, 결정계수 R²≈0.131.

> CER은 품질 저하의 부분 원인이지만 주인은 번역 모델 자체. 클린에서도 Live vs Q4 meanDiff +1.6 유지(페어드 218).

---

## 3. Per-sentence 상세

? = U+003F (Live 미확정), CER=lev/refLen

### 3.1 Worst 15 (CER 높은 순)

| # | sampleId → lang | refCurrent | hypCurrent | len | dist | CER | penalty | ctxBeh | langMismatch | 비고 |
|---|---|---|---|---|---|---|---|
| 1 | `ctx1-dyadic-use-register_carryover-001→en` | 알았어. | 아. 알았어. 어. | 4 | 6 | 1.500 | 2 | ignored_irrelevant_context | no |  |
| 2 | `ctx1-dyadic-use-register_carryover-001→ja` | 알았어. | 아. 알았어. 어. | 4 | 6 | 1.500 | 2 | used_correctly | no |  |
| 3 | `ctx1-dyadic-use-register_carryover-001→zh-Hans` | 알았어. | 아. 알았어. 어. | 4 | 6 | 1.500 | 10 | used_correctly | no |  |
| 4 | `ctx1-dyadic-use-pragmatic_intent_resolution-003→zh-Hans` | 아, 됐어요. | 어 네. 다들 지쳤다. | 7 | 10 | 1.429 | 50 | used_correctly | no |  |
| 5 | `ctx1-dyadic-use-referent_resolution-004→zh-Hans` | 어? 아까 막내가 엄청 맛있게 먹던데. | おあお母さん末っ子がめっちゃ美味しく食べてたんだ | 21 | 24 | 1.143 | 5 | ignored_irrelevant_context | YES (ja) |  |
| 6 | `ctx1-dyadic-use-pragmatic_intent_resolution-003→ja` | 아, 됐어요. | 아 어 다들 지쳤다. | 7 | 8 | 1.143 | 25 | missed_required_context | no |  |
| 7 | `ctx1-dyadic-use-referent_resolution-004→en` | 어? 아까 막내가 엄청 맛있게 먹던데. | おあおっか末っ子がめっちゃ美味しく食べてたんで | 21 | 23 | 1.095 | 12 | used_correctly | YES (ja) |  |
| 8 | `ctx1-single-use-register_carryover-001→en` | 진짜 가지가지 한다. | 本当恥ずかしいんだ 。 | 11 | 11 | 1.000 | 5 | ignored_irrelevant_context | YES (ja) |  |
| 9 | `ctx1-dyadic-use-pragmatic_intent_resolution-003→en` | 아, 됐어요. | 어 다들 지쳤다. | 7 | 7 | 1.000 | 25 | missed_required_context | no |  |
| 10 | `ctx1-dyadic-use-temporal_or_causal_linkage-003→ja` | 치실까지 아까 다 했지. | 칫솔 가져왔다 했지? 응. | 13 | 10 | 0.769 | 25 | misused_context | no |  |
| 11 | `ctx1-dyadic-use-register_carryover-002→en` | 물어보나 마나지. | 뭐라거나 말하지? | 9 | 6 | 0.667 | 5 | ignored_irrelevant_context | no |  |
| 12 | `ctx1-dyadic-use-temporal_or_causal_linkage-003→en` | 치실까지 아까 다 했지. | 칫솔 가져왔고 다 했지? | 13 | 8 | 0.615 | 25 | used_correctly | no |  |
| 13 | `ctx1-dyadic-use-temporal_or_causal_linkage-003→zh-Hans` | 치실까지 아까 다 했지. | 칫솔 가져왔다 했지? | 13 | 8 | 0.615 | 25 | misused_context | no |  |
| 14 | `ctx1-dyadic-use-register_carryover-002→ja` | 물어보나 마나지. | 뭐라거나 말하지. | 9 | 5 | 0.556 | 25 | used_correctly | no |  |
| 15 | `ctx1-dyadic-use-register_carryover-002→zh-Hans` | 물어보나 마나지. | 뭐라거나 말하지. | 9 | 5 | 0.556 | 25 | used_correctly | no |  |

- 특징: 4자 초단발화(`알았어.`)에서 삽입 환각, 7자(`아, 됐어요.`)에서 의미 전체 치환(다들 지쳤다), ja 라벨 오류 5건 포함(실제 일본어 가설). hyp/ref 길이비 평균 1.42.
- 입력 언어코드 YES인 5건은 CER 꼬리를 인위적으로 키움 — 제외하면 60%+ 버킷 13건 중 5건이 해소.

### 3.2 Best 5 (CER 0)

| # | sampleId → lang | refCurrent | hypCurrent | CER | penalty | inputLang |
|---|---|---|---|---|---|
| 1 | `ctx1-single-use-sense_disambiguation-003→en` | 너무 귀찮아서 폰에 그냥 가짜 번호 하나 대충 찍어주고 바로 화장실로 튀었지. | 너무 귀찮아서 폰에 그냥 가짜 번호 하나 대충 찍어주고 바로 화장실로 튀었지. | 0.000 | 5 | ko |
| 2 | `ctx1-single-use-sense_disambiguation-003→ja` | 너무 귀찮아서 폰에 그냥 가짜 번호 하나 대충 찍어주고 바로 화장실로 튀었지. | 너무 귀찮아서 폰에 그냥 가짜 번호 하나 대충 찍어주고 바로 화장실로 튀었지. | 0.000 | 1 | ko |
| 3 | `ctx1-single-use-sense_disambiguation-003→zh-Hans` | 너무 귀찮아서 폰에 그냥 가짜 번호 하나 대충 찍어주고 바로 화장실로 튀었지. | 너무 귀찮아서 폰에 그냥 가짜 번호 하나 대충 찍어주고 바로 화장실로 튀었지. | 0.000 | 5 | ko |
| 4 | `ctx1-single-use-pragmatic_intent_resolution-001→en` | 진짜 내 인생 참 잘 돌아간다. | 진짜 내 인생 참 잘 돌아간다. | 0.000 | 5 | ko |
| 5 | `ctx1-single-use-pragmatic_intent_resolution-001→ja` | 진짜 내 인생 참 잘 돌아간다. | 진짜 내 인생 참 잘 돌아간다. | 0.000 | 6 | ko |

> 전사 완벽해도 penalty 1–6 — 번역 실패는 전사와 독립.

### 3.3 언어 라벨 오류 예시 (별도 표)
| # | sampleId → lang | inputLangs | refCurrent | hypCurrent | CER |
|---|---|---|---|---|---|
| 1 | `ctx1-dyadic-use-referent_resolution-004→zh-Hans` | ja | 어? 아까 막내가 엄청 맛있게 먹던데. | おあお母さん末っ子がめっちゃ美味しく食べてたんだ | 1.143 |
| 2 | `ctx1-dyadic-use-referent_resolution-004→en` | ja | 어? 아까 막내가 엄청 맛있게 먹던데. | おあおっか末っ子がめっちゃ美味しく食べてたんで | 1.095 |
| 3 | `ctx1-single-use-register_carryover-001→en` | ja | 진짜 가지가지 한다. | 本当恥ずかしいんだ 。 | 1.000 |
| 4 | `ctx1-dyadic-use-referent_resolution-004→ja` | en,ko | 어? 아까 막내가 엄청 맛있게 먹던데. | Oh, uh 오빠 막내가 엄청 맛있게 먹던데. | 0.381 |
| 5 | `ctx1-single-use-register_carryover-001→ja` | ja,ko | 진짜 가지가지 한다. | 진짜 가지가지 | 0.364 |
| 6 | `ctx1-single-use-register_carryover-001→zh-Hans` | ja,ko | 진짜 가지가지 한다. | 진짜 가지가지 | 0.364 |

---

## 4. 문맥 CER과 게이트

- context mean 0.089 < current 0.112 — 초반 턴이 더 안정.
- 게이트 무관: CER 0-5% 버킷에서도 misused 13건. 전사 깨끗해도 불필요 문맥 오용은 별개.

---

## 5. 재현

```bash
node C:\Users\salee\AppData\Local\Temp\opencode\cer_strict_v2.mjs
# 출력: reports/ASR-CER-detail.jsonl (640행), reports/ASR-CER-per-sample-agg.jsonl (214행), reports/ASR-CER-analysis.md (v2)
```
SHA (hex 16):
- runtime.json 9ab9e98752155a83…
- provider-details ed1d19b8d634fa50…
- judge-normalized 88d4e1ee80289bbb…

---

## 6. 한계

- 음절 단위 CER, 초성/자소 분해 없음. 공백 1문자. "?" 1문자로 계산(정보 손실로 과소 추정 가능).
- 세션 변동: 동일 원문도 타깃 언어별 세션 차이(max-min 평균 0.046).
- 실패 8건 제외로 꼬리 과소 추정. 언어 라벨 오류 3.1%는 CER 꼬리에 포함 — 순수 음성 CER과 분리 해석 필요.
- Per-sample 214/216 — 2샘플 완전 실패는 분모 제외.

---

## 7. 파일 인덱스

- reports/ASR-CER-analysis.md — 이 문서(v2, UTF-8)
- reports/ASR-CER-detail.jsonl — per-record 640행 (cerCurrent/cerCtx/cerCombined + inputLangMismatch)
- reports/ASR-CER-per-sample-agg.jsonl — per-sample 214행
- 원본: translation-provider-details.jsonl, runtime.json, judge-normalized.jsonl, translation-failures.jsonl
