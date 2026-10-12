# BLUE-TANUKI Strategy Frame

## 1. Purpose and Current Engineering Target

The current AGI/QE engineering target is BLUE-TANUKI as an integrated C/J/M system with an external action boundary and planned D4Pocket shell. The older v1.0 RC release remains a separately governed historical baseline, not the scope limit or active implementation scheduler for the new AGI architecture.

QE organizes design, continuous end-to-end implementation, system-wide QC on the resulting real product, scoped QA, and independent owner release approval. Existing safety and release restrictions remain effective.

This document governs Layer A/B, the OpenClaw/Muse capability inventory, unsafe-mechanism rejection, D4Pocket integration responsibility, and historic v1.0 release separation.

## 2. Authority Layer Mapping

Layer A is the pre-installed responsibility surface:

- HDS-BRAIN
- containment and process policy
- Approval Gate
- hash-chain audit
- selected first-party channels
- Writing Operator, Daily Operator, and Developer Operator
- installer, Control Center, resident application
- LLM API configuration UX

Layer B is the third-party extension surface:

- Plugin API
- Skill loader
- third-party channel adapters through plugin boundaries
- Plugin Review Gate

Layer B must not reduce the completion quality of Layer A. Layer B must not bypass or weaken Layer A authority boundaries.

## 3. Product Experience Direction

Comfort of use is iPhone-like in image. Robustness and safety are BlackBerry-like in image.

These are target experience images, not references to Apple or BlackBerry business models.

In BLUE-TANUKI, ease of use means:

- stable selected channels rather than channel sprawl
- vertical integration inside the selected first-party scope
- immediate LLM API setup with a SIM-like configuration feel
- resident app integration with the operating system
- visible recovery and next action when something fails

## 4. OpenClaw/Muse: Capability Inclusion and Mechanism Rejection

Dimension 1 is the engineering posture. BLUE-TANUKI rejects hidden authority, unsafe skill execution, approval bypass, audit evasion, and uncontrolled external actions. The underlying implementation mechanism must be rejected or adapted where unsafe.

Dimension 2 is the capability inventory. The target includes all observed OpenClaw and Muse user-facing functions and operational capabilities. Each item remains implemented and connected, an explicit BUILD_GAP, or a precisely justified owner-scoped deferral; the former selected-scope v1.0 RC strategy does not delete targets from the AGI engineering inventory.

A reviewed Layer B adapter can safely implement a capability without making it Layer A. An unsafe marketplace runtime or unreviewed ClawHub code path stays disallowed, while an independently verified equivalent adapter is a candidate. WhatsApp first-party core remains outside the current v1.0 RC but the user-facing capability cannot silently disappear from the later AGI inventory.

The number of channels, schemas, or test cases does not prove parity. QE_BUILD wires the actual capability, QE_QC measures it under comparable conditions, QE_QA states any warranted range, and owner GO is separate.

## 5. Platform Strategy

Plugin API, skill loader, and channel-base contracts must be publishable-quality from the start of GA.

The rule is: if the platform boundary is opened later, it breaks later. Therefore Layer B boundaries must be declared before v1.0 GA, and implemented before public GA claims are activated.

This document declares that strategy. Detailed Layer B specification is handled by the Phase 11-S5 platform extension surface documents.

## 6. D4Pocket Runtime Shell and Responsibility Substrate

D4Pocket (the renamed GUI-Shell) is both a design/reference substrate and the planned external GUI/runtime/OS broker shell for the new AGI system. No production D4Pocket integration is claimed for the existing v1.0 RC.

HDS-BRAIN/J retains BLUE-TANUKI purpose and decision authority. D4Pocket keeps independent current OS/workspace Permission, actor and target identity, credential containment, bounded approval, single-use grants, action supervision and audit, behind authenticated adapters. J's decision cannot substitute for D4Pocket's Permission, nor does a D4Pocket UI request or broker record replace J's adoption decision.

D4Pocket is a generic shell and must not acquire BLUE-specific HDS policy. Do not create a direct Flutter/HTTP authority shortcut or a second approval path. Any modification to the D4Pocket repository requires a separately authorized bounded instruction, exact HEAD reconciliation, tests and a rollback point.

This paragraph describes the target design only. Implementation, live/installed evidence, capability promotion and release are open until demonstrated by real producer/consumer paths.

Related references: [External tool boundary](EXTERNAL_TOOL_AUTHORITY_BOUNDARY.md), [D4 connection proposal](外殻接続変更案.md), [Authority Model](BLUE_TANUKI_AUTHORITY_MODEL.md), [Responsibility Mapping](RESPONSIBILITY_SUBSTRATE_MAPPING.md).

## 7. Strategic Sequence and v1.0 Release Separation

The current engineering sequence is QE_DESIGN → QE_BUILD → SYSTEM_SHAPED → BUILD_COVERED → QE_QC → QE_QA → QE_RELEASE_REVIEW. The system is implemented end-to-end before broad quality control. A test count, local contract PASS, or isolated feature is not a completed system.

The historic Stage 1 v1.0 RC, Stage 2 full-feature plan, and Stage 3 model replacement narrative remains a record of older scope and release choices, not the current AGI implementation scheduler.

Current RC publication remains gated: 1.0.0-rc.1, P13 PENDING_OWNER_GO, public_claim_allowed=false. The new AGI build, MiniDora exchange, competitive superiority and legacy RC release are separate claims. None is inferred from the existence of the design or the QE methodology.

## 8. Non-Goals of This Document

This document does not define:

- implementation schedule
- individual phase specifications
- version numbers
- external launch copy
- implementation details for operator surfaces or plugin review

## 9. Cross-References

- [AGENTS.md](../AGENTS.md)
- [Roadmap](ROADMAP.md)
- [OpenClaw Rejection Audit](OPENCLAW_REJECTION_AUDIT.md)
- [GA Bar Definition](GA_BAR_DEFINITION.md)
- [Non-Goals](NON_GOALS.md)
- [Capability Envelope](CAPABILITY_ENVELOPE.md)
- [Conformance](CONFORMANCE.md)
- [LLM Extension Surface](LLM_EXTENSION_SURFACE.md)
- [Responsibility Substrate Mapping](RESPONSIBILITY_SUBSTRATE_MAPPING.md)
- [GUI Product Spec](GUI_PRODUCT_SPEC.md)
- [v1.0 Release Candidate](v1.0-release-candidate.md)
