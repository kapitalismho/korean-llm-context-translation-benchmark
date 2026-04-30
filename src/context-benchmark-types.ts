export const CONTEXT_TURN_COUNTS = [1, 2, 3] as const;
export const SPEAKER_MODES = ['single', 'dyadic'] as const;
export const SPEAKER_ROLES = ['self', 'other'] as const;
export const CONTEXT_EXPECTATIONS = ['use', 'ignore'] as const;

export const PRIMARY_PHENOMENA = [
  'referent_resolution',
  'ellipsis_completion',
  'sense_disambiguation',
  'pragmatic_intent_resolution',
  'register_carryover',
  'temporal_or_causal_linkage',
  'topic_shift_independence',
  'false_lead_trap',
  'stale_context_resistance',
  'metadata_nonliteral_resistance',
] as const;

export const SECONDARY_PHENOMENA = [
  'speaker_role_resolution',
  'self_other_deixis',
  'response_pair_dependency',
  'addressivity',
  'emotion_flip',
  'repair_or_self_correction',
  'sarcasm_or_teasing',
  'location_time_deixis',
] as const;

export type ContextTurnCount = (typeof CONTEXT_TURN_COUNTS)[number];
export type SpeakerMode = (typeof SPEAKER_MODES)[number];
export type SpeakerRole = (typeof SPEAKER_ROLES)[number];
export type ContextExpectation = (typeof CONTEXT_EXPECTATIONS)[number];
export type PrimaryPhenomenon = (typeof PRIMARY_PHENOMENA)[number];
export type SecondaryPhenomenon = (typeof SECONDARY_PHENOMENA)[number];

export interface ContextTurn {
  speakerRole: SpeakerRole;
  relativeTimeLabel?: string | null;
  sourceText: string;
}

export interface ContextRuntimeSample {
  sampleId: string;
  contextTurnCount: ContextTurnCount;
  speakerMode: SpeakerMode;
  contextExpectation: ContextExpectation;
  primaryPhenomenon: PrimaryPhenomenon;
  secondaryPhenomena: SecondaryPhenomenon[];
  contextTurns: ContextTurn[];
  currentSource: ContextTurn;
}

export interface ContextInternalSample extends ContextRuntimeSample {
  relevantContextIndices: number[];
  intendedInterpretation: string;
  commonFailureModes: string[];
  validationNotes: string;
}

export interface ContextAuthoringItem {
  sampleId: string;
  locked: {
    contextTurnCount: ContextTurnCount;
    speakerMode: SpeakerMode;
    contextExpectation: ContextExpectation;
    primaryPhenomenon: PrimaryPhenomenon;
  };
  status: 'todo' | 'drafted' | 'reviewed' | 'approved';
  fill: {
    secondaryPhenomena: SecondaryPhenomenon[];
    contextTurns: ContextTurn[];
    currentSource: ContextTurn;
    relevantContextIndices: number[];
    intendedInterpretation: string;
    commonFailureModes: string[];
    validationNotes: string;
  };
}
