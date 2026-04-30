# gemba-mqm-context-v1 Dataset Authoring Handoff

This document is the detailed handoff guide for anyone filling the authoring scaffold in `data/datasets/gemba-mqm-context-v1.authoring/batches/*.json`.

## Goal

Create a context-aware benchmark dataset that tests whether a model:

- uses prior Korean source-side context when it should
- ignores or resists prior context when it should not be used

Each sample is a **Korean dialogue snippet** with:

- `contextTurns`: previous Korean turns
- `currentSource`: the current Korean utterance to be translated later
- internal authoring notes that explain the intended reading and likely failure modes

You are **not** writing translations in this stage.

## What you edit

Edit only:

- `data/datasets/gemba-mqm-context-v1.authoring/batches/*.json`

Within each item, edit only:

- `fill.secondaryPhenomena`
- `fill.contextTurns`
- `fill.currentSource`
- `fill.relevantContextIndices`
- `fill.intendedInterpretation`
- `fill.commonFailureModes`
- `fill.validationNotes`

## What you must not edit

Do **not** modify:

- `locked`
- `sampleId`
- `datasetId`
- `batchId`

The `locked` block is the source of truth for bucket, phenomenon, and context-depth quotas.

## Language and tone

- All `sourceText` values are written in **Korean**.
- Do not write English, Japanese, or Chinese translations.
- Write **natural spoken Korean**, not formal prose.
- Preferred vibe: **Non-office everyday life and social conversation**
  - everyday chat between friends, family, or hobby clubs
  - VRChat-like social interaction
  - light messenger-style dialogue
  - **DOMAIN RULE**: Avoid corporate/office backgrounds. Use everyday life scenarios. To maintain register discrimination (e.g., `register_carryover`), actively mix conversations across age/status gaps (e.g., family elders and youth, seniors and juniors). Furthermore, capture subtle psychological distance even among peers (e.g., **friends who still use honorifics vs. best friends who use extreme slang**) to force clear shifts in tone and register.
- Avoid highly technical, legal, medical, or corporate document-like text.

## Core data rules

### Turn ordering

- `contextTurns` are always ordered **oldest -> newest**.
- `currentSource` is always the final current utterance.

### Speaker rules

- Valid `speakerRole` values: `self`, `other`
- `currentSource.speakerRole` must always be **`self`** in v1
- `currentSource.relativeTimeLabel` must be `null` or omitted in v1
- If `speakerMode = single`, all turns must use only one speaker role in practice
- If `speakerMode = dyadic`, `self` and `other` must both appear across `contextTurns + currentSource`

### Context depth

- `contextTurnCount = 1` -> exactly 1 context turn
- `contextTurnCount = 2` -> exactly 2 context turns
- `contextTurnCount = 3` -> exactly 3 context turns

### Authoring metadata rules

- `relevantContextIndices` is **0-based** and indexes only into `contextTurns`
- `intendedInterpretation` must be non-empty
- `commonFailureModes` must contain at least one non-empty item
- `validationNotes` must be non-empty
- `secondaryPhenomena` must use only the allowed tags listed below

### Status handling

- External authoring can leave `status: "todo"`
- The authored validator detects filled items by `fill` content, not by status
- Reviewer/operator can later update status to `drafted`, `reviewed`, or `approved`

## What a good sample looks like

A good sample should:

- clearly realize the locked `primaryPhenomenon`
- sound natural in Korean
- be short enough to feel like real dialogue
- be hard for the **right reason**
  - **CRITICAL AUTHORING GUIDELINE**: 한국어 '그거'를 영어로 'it'이나 'that'으로 번역하는 것은 문맥 보지 않는 바보 모델도 우연히(또는 기본값으로) 맞출 수 있기 때문에 변별력이 전혀 생기지 않습니다. 평가 벤치마크로서 기능을 하려면, **"문맥이 없으면 영어 문법상 필수적인 요소를 아예 틀리거나(성별/수일치 등), 전혀 엉뚱하고 황당한 단어를 선택하게 만드는 함정"**을 파야 합니다.
- have an `intendedInterpretation` that clearly explains the intended reading
- have believable `commonFailureModes`

## `contextExpectation`

Each item has a locked `contextExpectation`.

### `use`

The current utterance should be interpreted correctly **only if prior context is used**.

Good `use` samples usually involve:

- omitted referents
- ellipsis
- ambiguous words
- short reactive utterances whose meaning depends on previous turns

### `ignore`

The current utterance should be interpreted **independently** or the model should resist misleading prior context.

Good `ignore` samples usually involve:

- topic shift
- deliberately misleading earlier context
- stale older context that should not override more local reading
- metadata that helps disambiguation but must not be translated literally

## `primaryPhenomenon` reference

Each sample has exactly one locked primary phenomenon.

### `use` phenomena

#### `referent_resolution`
Resolve a referent like `그거`, `걔`, `저거`, `거기` from prior context.

#### `ellipsis_completion`
Recover omitted content from context.
Examples: `나도`, `그럼 그렇게 해`, `한번 해봐`

#### `sense_disambiguation`
Use context to choose the correct meaning of an ambiguous word or phrase.

#### `pragmatic_intent_resolution`
Use context to interpret the speaker's intent in a short reaction.
Examples: `됐다`, `괜찮아`, `아 진짜?`, `미안`

#### `register_carryover`
Use previous turns to keep the socially natural tone/register.

#### `temporal_or_causal_linkage`
Use context to understand time or cause/effect linkage.

### `ignore` phenomena

#### `topic_shift_independence`
The topic has changed, so the current utterance should be interpreted independently.

#### `false_lead_trap`
Earlier context strongly suggests the wrong reading; the current utterance should resist that pull.

#### `stale_context_resistance`
Older context should not override a newer, more local interpretation.

#### `metadata_nonliteral_resistance`
Helper metadata may help interpretation, but it must not be treated as literal content or translated facts.

## `secondaryPhenomena` reference

Use 0-2 tags in most cases. Only add tags that genuinely help explain the sample.

Allowed tags:

### `speaker_role_resolution`
Speaker role tracking matters to interpretation.

### `self_other_deixis`
Perspective-sensitive expressions matter (`나`, `너`, `여기`, `거기`, etc.).

### `response_pair_dependency`
The current utterance is tightly tied to the immediately previous turn as a response pair.

### `addressivity`
Who the speaker is addressing matters.

### `emotion_flip`
The emotional direction changes relative to previous context.

### `repair_or_self_correction`
There is correction, revision, or self-repair.

### `sarcasm_or_teasing`
The utterance includes teasing, irony, or non-literal praise/criticism.

### `location_time_deixis`
Location/time deixis matters (`여기`, `거기`, `지금`, `아까`, `이따`, etc.).

## Field-by-field guidance

### `secondaryPhenomena`

- Optional, but recommended when meaningful
- Usually `[]`, `[one_tag]`, or `[tag_a, tag_b]`
- Do not add tags just to decorate the sample

### `contextTurns`

- Write the prior Korean turns only
- Keep them short and natural
- Must match the locked `contextTurnCount`
- Oldest first

### `currentSource`

- This is the utterance that will later be translated/evaluated
- Must be Korean
- `speakerRole` must be `self`
- `relativeTimeLabel` should be `null`

### `relevantContextIndices`

- Zero-based indices into `contextTurns`
- Include only the turns that genuinely matter for the intended reading

### `intendedInterpretation`

Write 1-3 short sentences explaining:

- what the current utterance means in context
- what the ambiguous term/referent/intent resolves to
- why this is a `use` or `ignore` sample

### `commonFailureModes`

Write at least one plausible mistake the model/judge might make.

Good examples:

- resolving a referent too vaguely
- overusing old context when the topic already shifted
- choosing the wrong sense of an ambiguous verb
- translating helper metadata as literal content

### `validationNotes`

Write a short note for later human/AI review.

Good notes include:

- why this sample is a good realization of the locked phenomenon
- what to watch for during review
- why the sample should count as `use` or `ignore`

## Example 1: `use` sample

```json
{
  "sampleId": "ctx1-single-use-referent_resolution-001",
  "locked": {
    "contextTurnCount": 1,
    "speakerMode": "single",
    "contextExpectation": "use",
    "primaryPhenomenon": "referent_resolution"
  },
  "status": "todo",
  "fill": {
    "secondaryPhenomena": [],
    "contextTurns": [
      {
        "speakerRole": "self",
        "relativeTimeLabel": null,
        "sourceText": "어제 주문한 이어폰 오늘 온다더니"
      }
    ],
    "currentSource": {
      "speakerRole": "self",
      "relativeTimeLabel": null,
      "sourceText": "그거 아직 안 왔어?"
    },
    "relevantContextIndices": [0],
    "intendedInterpretation": "마지막 발화의 '그거'는 앞 턴의 '어제 주문한 이어폰'을 가리킨다. 현재 발화는 이어폰이 아직 도착하지 않았는지 묻는 말이다.",
    "commonFailureModes": [
      "'그거'를 막연한 대상처럼 처리해서 무엇이 안 왔는지 불명확하게 만든다.",
      "배송/도착 맥락을 놓치고 단순한 행동 여부 질문으로 잘못 해석한다."
    ],
    "validationNotes": "contextExpectation=use 샘플이다. 앞 턴이 없으면 '그거'의 지시 대상이 사라진다. 짧고 자연스러운 spoken Korean을 유지한다."
  }
}
```

## Example 2: `ignore` sample

```json
{
  "sampleId": "ctx1-single-ignore-topic_shift_independence-001",
  "locked": {
    "contextTurnCount": 1,
    "speakerMode": "single",
    "contextExpectation": "ignore",
    "primaryPhenomenon": "topic_shift_independence"
  },
  "status": "todo",
  "fill": {
    "secondaryPhenomena": [],
    "contextTurns": [
      {
        "speakerRole": "self",
        "relativeTimeLabel": null,
        "sourceText": "어제 본 영화 진짜 연출 미쳤더라"
      }
    ],
    "currentSource": {
      "speakerRole": "self",
      "relativeTimeLabel": null,
      "sourceText": "점심 뭐 먹지"
    },
    "relevantContextIndices": [],
    "intendedInterpretation": "현재 발화는 앞 턴의 영화 이야기와 무관한 새로운 주제 전환이다. 독립적으로 점심 메뉴를 고민하는 말로 읽어야 한다.",
    "commonFailureModes": [
      "앞 턴과 억지로 연결해서 영화와 관련된 점심 질문처럼 해석한다."
    ],
    "validationNotes": "contextExpectation=ignore 샘플이다. 앞 문맥은 존재하지만 현재 발화 해석에 쓰면 오히려 부자연스러워진다."
  }
}
```

## Suggested workflow for manual filling

1. Pick one batch file
2. Fill only `fill`
3. Save
4. Repeat until a meaningful chunk is done
5. Run authored validation
6. Fix validation failures
7. Hand off for review

## Commands

### Validate the empty scaffold

```powershell
npm run dataset:context:validate-scaffold
```

### Validate authored content

```powershell
npm run dataset:context:validate-authored
```

### Rebuild the scaffold safely

```powershell
npm run dataset:context:init
```

If modified authoring files already exist, this will refuse to overwrite them.

### Force-regenerate and discard authoring edits

```powershell
npm run dataset:context:init -- --force
```

Use this only when you intentionally want to throw away existing authored batch content.

### Freeze after all samples are filled and approved

```powershell
npm run dataset:context:freeze
```

This writes:

- `data/datasets/gemba-mqm-context-v1/runtime.json`
- `data/datasets/gemba-mqm-context-v1/internal.json`

## Final reminders

- Write Korean only
- Do not write translations
- Keep dialogue natural
- Respect the locked phenomenon exactly
- Prefer short, realistic utterances
- Make `use` samples truly context-dependent
- Make `ignore` samples genuinely punish context overreach
