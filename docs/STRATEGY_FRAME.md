# BLUE-TANUKI Strategy Frame

## 1. Purpose

This document binds the repository-level strategy that is otherwise spread across `AGENTS.md`, `docs/ROADMAP.md`, and `docs/OPENCLAW_REJECTION_AUDIT.md`.

It defines the Layer A / Layer B split, product experience direction, OpenClaw two-dimensional position, platform strategy, and strategic sequence for the v1.0 GA path.

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

## 4. OpenClaw Position (Two-Dimensional)

BLUE-TANUKI keeps two independent OpenClaw dimensions separate.

Dimension 1 is design posture. BLUE-TANUKI rejects OpenClaw-style breadth-first, agent-autonomy-first design. This posture does not change.

Dimension 2 is feature coverage. Inside the selected and safety-preserving scope, BLUE-TANUKI targets complete superiority over OpenClaw. This does not mean set-theoretic inclusion of every OpenClaw feature. It means complete superiority inside the deliberately selected scope.

Selection criteria:

- If a feature breaks safety, exclude it.
- If a feature blurs containment, exclude it.
- If a feature bypasses HDS authority, exclude it.
- If a feature is a first-party killer experience, implement it in Layer A.
- If a feature can safely remain replaceable, expose it through Layer B.

Feature-set complete inclusion means implementing every visible feature. Selected-scope complete superiority means selecting only the features that fit BLUE-TANUKI's authority model and completing them to a higher reliability and usability bar.

## 5. Platform Strategy

Plugin API, skill loader, and channel-base contracts must be publishable-quality from the start of GA.

The rule is: if the platform boundary is opened later, it breaks later. Therefore Layer B boundaries must be declared before v1.0 GA, and implemented before public GA claims are activated.

This document declares that strategy. Detailed Layer B specification is handled by the Phase 11-S5 platform extension surface documents.

## 6. GUI Shell Responsibility Substrate Strategy

GUI Shell is a reference implementation and LLM-readable responsibility substrate. BLUE-TANUKI does not modify GUI Shell, depend on GUI Shell at runtime, or outsource authority to GUI Shell.

The BLUE-TANUKI development strategy is:

```txt
GUI Shell responsibility structure
  -> LLM implementation agent reads it
  -> maps authority / approval / audit / recovery / evidence boundaries
  -> implements bounded BLUE-TANUKI changes under HDS-BRAIN authority
```

This turns BLUE-TANUKI into the target product that demonstrates LLM-assisted extension under an explicit responsibility substrate. LLM agents may implement and validate bounded changes, but they remain non-authority. HDS-BRAIN owns BLUE-TANUKI internal authority, and the human owner retains final approval, recovery, release, and responsibility authority.

Primary mapping documents:

- [LLM Extension Surface](LLM_EXTENSION_SURFACE.md)
- [Responsibility Substrate Mapping](RESPONSIBILITY_SUBSTRATE_MAPPING.md)
- [BLUE-TANUKI Authority Model](BLUE_TANUKI_AUTHORITY_MODEL.md)
- [Conformance Targets](CONFORMANCE_TARGETS.md)
- [GUI Product Spec](GUI_PRODUCT_SPEC.md)

## 7. Strategic Sequence

Stage 1 - BLUE-TANUKI: proof that the owner can use LLMs completely as tools under HDS authority.

Stage 2 - full-feature version: show the reachable requirements for an AGI-class system.

Stage 3 - self-contained AI without LLM dependency.

BLUE-TANUKI v1.0 GA is the Stage 1 artifact. OSS release is how Stage 1 is shown. Publishing GA before the bar is met damages the trust base needed for Stage 2 and Stage 3.

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
