# gemba-mqm-context-v1 authoring workspace

See also: `HANDOFF.md` for the full authoring guide with phenomenon definitions, field-by-field instructions, and examples.

- Edit only `fill` fields inside batch files.
- Never modify `locked` metadata.
- Keep `contextTurns` in oldest-to-newest order.
- Use only `speakerRole: self | other` and optional `relativeTimeLabel` values in turns.
- Keep `currentSource.speakerRole` as `self` for every v1 sample.
- Fill `secondaryPhenomena`, `intendedInterpretation`, `commonFailureModes`, and `validationNotes` for authored items.
- Run `npm run dataset:context:validate-scaffold` to validate the generated empty scaffold state.
- `npm run dataset:context:init` is overwrite-safe by default and refuses to replace modified authoring batches; pass `npm run dataset:context:init -- --force` only when you intentionally want to regenerate and discard existing batch edits.
- Run `npm run dataset:context:validate-authored` to validate filled authoring content.
- External authoring AI may leave `status: "todo"`; authored validation detects filled items from `fill` content rather than status.
- Reviewer/operator later promotes item statuses to `drafted`, `reviewed`, and `approved`.

## Authoring Quality Guidelines
**CRITICAL**: 한국어 '그거'를 영어로 'it'이나 'that'으로 번역하는 것은 문맥 보지 않는 바보 모델도 우연히(또는 기본값으로) 맞출 수 있기 때문에 변별력이 전혀 생기지 않습니다. 평가 벤치마크로서 기능을 하려면, **"문맥이 없으면 영어 문법상 필수적인 요소를 아예 틀리거나(성별/수일치 등), 전혀 엉뚱하고 황당한 단어를 선택하게 만드는 함정"**을 파야 합니다.
**DOMAIN RULE**: 대화의 배경은 회사/비즈니스 상황을 가급적 피하고, 철저히 **일상 생활이나 친구/지인/가족 간의 대화**로 구성해야 합니다. 단, `register_carryover` 같은 현상의 변별력을 위해 동갑내기 친구뿐만 아니라, **손윗사람-손아랫사람(가족, 동네 어르신, 학교 선후배 등)** 간의 대화도 적극적으로 포함시켜야 합니다. 나아가 **같은 친구 사이라도 존댓말을 쓰는 조심스러운 사이와 완전한 반말을 쓰는 절친 사이**처럼 미묘한 거리감(distance)과 어조(tone)의 차이도 다채롭게 반영해야 합니다.
