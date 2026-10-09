export * from "./types.js";
export { frame, type FrameConfig } from "./frame.js";
export {
  createUnidentifiedGoalProjection,
  type DeepReadonly,
  type GoalProjectionSourceKind,
  type ReadonlyGoalProjection,
} from "./goal_projection.js";
export { resolveActor, resolveProcess } from "./process.js";
export { buildMemoryTrace, type MemoryReaderPort } from "./memory_trace.js";
export {
  fReferenceForId,
  idFromFReference,
  referenceIdFromInput,
  fReferencesFromText,
} from "./f_reference.js";
export { model } from "./model.js";
export { commit } from "./commit.js";
export {
  AuditLog,
  type AuditEntry,
  type AuditOptions,
} from "./audit.js";
export {
  buildOutputAuditLog,
  classifyOutputKind,
  type OutputAuditInput,
  type OutputAuditKind,
  type OutputAuditLog,
  type OutputTargetSurface,
} from "./output_audit.js";

export {
  EXPECTED_RUNTIME_INVARIANTS,
  RUNTIME_INVARIANTS_SCHEMA_VERSION,
  buildRuntimeInvariantEvidence,
  runtimeInvariantReportDigest,
  runtimeInvariantReportOk,
  runtimeInvariantValuesOk,
  type RuntimeInvariantEvidenceItem,
  type RuntimeInvariantEvidenceOptions,
  type RuntimeInvariantEvidenceReport,
  type RuntimeInvariantGuarantee,
  type RuntimeInvariantKey,
  type RuntimeInvariantValues,
} from "./runtime_invariants.js";

export {
  HDS_BOUNDARY_POLICY_VERSION,
  TRINITY_M_POLICY_MODEL,
  classifyBoundaryUpdate,
  evaluateFailSafeBoundary,
  evaluateReferenceBoundary,
  evaluateTrinityMClosure,
  evaluateUnknownEscalation,
  type BoundaryEvaluation,
  type BoundaryReferenceSource,
  type BoundaryRequestedUse,
  type BoundaryUpdateTarget,
  type FailSafeInput,
  type TrinityMClosureInput,
  type UnknownEscalationReason,
} from "./boundary_policy.js";

export {
  evaluateHDSBrainHealth,
  type HDSBrainHealth,
  type HDSBrainHealthOptions,
  type HDSBrainHealthPrecondition,
  type HDSBrainHealthStatus,
  type HDSRuntimeHealthCheck,
  type HealthCheckStatus,
  type RuntimeDependencyCheck,
  type RuntimePathCheck,
} from "./health.js";
export {
  runStandaloneHDSBrain,
  type StandaloneHDSBrainInput,
  type StandaloneHDSBrainResult,
} from "./standalone_harness.js";
export {
  type HDSAuditPort,
  type HDSClockPort,
  type HDSHistoryEvent,
  type HDSHistoryPort,
  type HDSLLMPort,
  type HDSMemoryPort,
  type HDSPolicyPort,
} from "./ports.js";
export {
  HDSUpperController,
  type ControllerOptions,
  type ControllerSelfHealthOptions,
  type LLMCommandRoute,
  type ResumeAuditOptions,
  type HDSRuntimeSnapshot,
} from "./controller.js";
export {
  routeAction,
  type ActionRoute,
  type NoopActionRoute,
  type ToolActionRoute,
} from "./action_router.js";
export {
  normalizeForDetection,
  type DetectedControlChar,
  type DetectionNormalization,
} from "./normalization.js";
export {
  runScoring,
  evaluateDecision,
  loadPolicyFromFile,
  validatePolicy,
  DEFAULT_POLICY,
} from "./policy.js";
export {
  DetectorRegistry,
  createDefaultDetectorRegistry,
  detectorLifecycleEscalation,
  detectorLifecycleOk,
  lengthDetector,
  riskKeywordDetector,
  keywordMatchDetector,
  type Detector,
  type DetectorContext,
  type DetectorLifecycleStatus,
  type DetectorLifecycleTrace,
  type DetectorOutput,
} from "./detectors/index.js";

export {
  approvalContextFromCommand,
  operationFromCommand,
  riskForOperation,
  finalReviewRequired,
  approvalLevelFromContext,
  evaluateApproval,
  buildAuthorityTransparencyTrace,
  buildApprovalGrant,
  approvalGrantFromEvaluation,
  grantMatches,
  FINAL_REVIEW_OPERATION_LIST,
  FINAL_REVIEW_OPERATIONS,
  finalReviewOperationList,
  type ApprovalMode,
  type ApprovalDecision,
  type ApprovalRisk,
  type ApprovalLevel,
  type ApprovalOperation,
  type ApprovalScopeKind,
  type ApprovalContext,
  type ApprovalGrant,
  type ApprovalEvaluation,
  type AuthorityTransparencyTrace,
} from "./approval_policy.js";
export { MemoryApprovalGrantStore, JsonFileApprovalGrantStore, type ApprovalGrantStore } from "./approval_store.js";

export {
  LongTermMemoryStore,
  shouldPersist,
  decodeMemoryEntry,
  encodeMemoryEntry,
  canonicalizeMemoryEntry,
  type MemoryActorSnapshot,
  type MemoryEntry,
  type MemoryClosure,
  type MemoryCommitSnapshot,
  type MemoryProcessSnapshot,
  type MemoryStoreOptions,
} from "./long-term-memory/index.js";

export {
  CompleteHistoryStore,
  type CompleteHistoryRecordProjection,
  COMPLETE_HISTORY_SCHEMA_VERSION,
  completeHistoryEntryHash,
  decodeCompleteHistoryEntry,
  encodeCompleteHistoryEntry,
  type CompleteHistoryAppendInput,
  type CompleteHistoryEntry,
  type CompleteHistoryExport,
  type CompleteHistoryKind,
  type CompleteHistoryReplayFilter,
  type CompleteHistoryStoreOptions,
} from "./complete-history/index.js";

export {
  FailureMemoryStore,
  FAILURE_MEMORY_SCHEMA_VERSION,
  candidateFromCommand,
  commandActionPattern,
  commandOperation,
  defaultProbePolicy,
  defaultSuppressionPolicy,
  extractFailureSignatures,
  extractFromCompleteHistory,
  matchSignature,
  needsBlockRevalidation,
  normalizeFailurePattern,
  runPeriodicFailureMemoryVerification,
  type FailureExtractionInput,
  type FailureGateCandidate,
  type FailureGateDecision,
  type FailureGateMatch,
  type FailureGateResult,
  type FailureMemorySnapshot,
  type FailureMemoryStoreOptions,
  type FailureMemoryVerifierInput,
  type FailureRuleState,
  type FailureScope,
  type FailureSeverity,
  type FailureSignature,
  type FailureSignatureInput,
  type FailureSignatureUpdate,
  type FailureType,
  type LLMFailureSignatureProposal,
  type MatchLevel,
  type PeriodicVerificationReport,
  type PeriodicVerificationTrigger,
  type ProbePolicy,
  type RevalidationOutcome,
  type RevalidationResult,
  type SuppressionPolicy,
} from "./failure-memory/index.js";
