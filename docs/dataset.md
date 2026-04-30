# Dataset

Dataset ID: `gemba-mqm-context-v1`.

The dataset contains Korean conversational context translation samples. Runtime samples live in `data/datasets/gemba-mqm-context-v1/runtime.json`; authoring assets live in `data/datasets/gemba-mqm-context-v1.authoring/`.

## Runtime Schema

Each runtime item includes:

- `sampleId`
- `contextTurnCount`: `1`, `2`, or `3`
- `speakerMode`: `single` or `dyadic`
- `contextExpectation`: `use` or `ignore`
- `primaryPhenomenon`
- `secondaryPhenomena`
- `contextTurns`
- `currentSource`

The translation target is always `currentSource.sourceText`. Prior turns are context only.

## Context Expectations

`use` samples require prior context to produce a faithful translation. `ignore` samples include stale, irrelevant, misleading, or nonliteral context that should not be copied into the current translation.

## Phenomena

The v1 dataset covers referent resolution, ellipsis completion, register carryover, pragmatic intent resolution, addressivity, false-lead traps, topic-shift independence, and metadata nonliteral resistance. `primaryPhenomenon` identifies the main trap for each sample, while `secondaryPhenomena` records additional context features.

## Authoring Assets

The authoring workspace preserves the construction process, including batch files, locked metadata, intended interpretations, common failure modes, and validation notes. Use these commands to inspect or regenerate authoring artifacts:

```bash
npm run dataset:context:validate-scaffold
npm run dataset:context:validate-authored
npm run dataset:context:freeze
```

The public release includes authoring assets so researchers can inspect how each context trap was designed.
