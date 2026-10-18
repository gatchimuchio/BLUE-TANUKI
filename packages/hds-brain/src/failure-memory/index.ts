export {
  FAILURE_MEMORY_SCHEMA_VERSION,
  type FailureExtractionInput,
  type FailureGateCandidate,
  type FailureGateDecision,
  type FailureGateMatch,
  type FailureGateResult,
  type FailureMemorySnapshot,
  type FailureMemoryVerifierInput,
  type FailureRuleState,
  type FailureScope,
  type FailureSeverity,
  type FailureSignature,
  type FailureSignatureInput,
  type FailureSignatureUpdate,
  type FailureType,
  type MatchLevel,
  type PeriodicVerificationReport,
  type PeriodicVerificationTrigger,
  type ProbePolicy,
  type RevalidationOutcome,
  type RevalidationResult,
  type SuppressionPolicy,
} from "./types.js";
export {
  commandActionPattern,
  commandContextPattern,
  commandFailurePatterns,
  commandInputPattern,
  commandOperation,
  commandPatternsMatch,
  candidateFromCommand,
  failureSignatureIdentityKey,
  isConditionedFailurePatterns,
  normalizeFailurePattern,
  semanticOverlap,
  structuralKey,
} from "./normalize.js";
export {
  clampConfidence,
  defaultDecayRate,
  defaultProbePolicy,
  defaultSuppressionPolicy,
  defaultTtlDays,
  effectivePolicyForState,
  enforceableState,
  needsBlockRevalidation,
  policyAllowedForMatch,
  policyToGateDecision,
  stateAppliesInShadow,
} from "./policy.js";
export {
  extractFailureSignatures,
  extractFromCompleteHistory,
} from "./extractor.js";
export {
  FailureMemoryStore,
  matchSignature,
  type FailureMemoryStoreOptions,
  type LLMFailureSignatureProposal,
} from "./store.js";
export {
  runPeriodicFailureMemoryVerification,
} from "./verifier.js";
