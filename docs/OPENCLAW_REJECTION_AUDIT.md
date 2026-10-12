# OpenClaw Rejection Audit

**Current scope (2026-10-12):** This historical audit rejects unsafe *implementation mechanisms*. The new BLUE-TANUKI AGI/QE capability inventory includes all observed OpenClaw/Muse capabilities. Rejection of a dangerous design must lead to a safer bounded equivalent, an explicit BUILD_GAP, or an independently authorized deferral, not silent removal of a user-facing capability. Detailed QC follows an integrated QE_BUILD; scoped QA and owner GO are separate.

## 1. Scope and Intent

This document is an internal engineering audit for BLUE-TANUKI.

It is not marketing copy, public legal commentary, or a claim about the intent of the OpenClaw maintainers. OpenClaw is used here only as a comparison target observation: a visible pattern of broad channel coverage, quick onboarding, agent autonomy, and plugin expansion.

The purpose is to prevent future implementation drift. BLUE-TANUKI rejects OpenClaw-style breadth-first design as the basis for this repository because BLUE-TANUKI must preserve:

- HDS-BRAIN authority ownership
- Approval Gate non-bypass
- Runtime Invariants visibility
- hash-chain audit compatibility
- capability envelope enforcement
- permanent-use UX over first-contact demos

## 2. What OpenClaw Appears To Optimize

As a comparison target observation, the OpenClaw-style pattern appears to optimize for:

- quick first contact
- broad channel count
- agent-facing convenience
- skills/plugin ecosystem growth
- DM pairing and allowlist-based operation
- daemon/service installation
- dashboard/control UI
- doctor/update/rollback support
- companion nodes, voice, and canvas-like expansion

These are not all bad ideas. Several are useful, but BLUE-TANUKI must classify them before adoption because local convenience can create hidden authority, unclear ownership state, or long-term operational burden.

## 3. Why BLUE-TANUKI Rejects These Optimizations As A Starting Point

BLUE-TANUKI does not treat feature reach as proof of product quality.

The rejection criteria are engineering criteria:

- If a feature moves authority into LLM output, channel metadata, memory, plugin metadata, tool output, or external service state, it is rejected.
- If a feature makes first-run success easier while making update, rollback, doctor, credential state, or service state harder to understand, it is redesigned.
- If a feature requires unsigned or unbounded third-party execution in the authority-adjacent path, it is excluded from first-party core.
- If a feature hides side effects from hash-chain audit, it is rejected.
- If a feature cannot explain failure and recovery to the owner without source-code knowledge, it is incomplete.

The BLUE-TANUKI answer is not "copy every unsafe OpenClaw mechanism." The current engineering inventory still includes all observed user-facing capabilities; unsafe designs must be replaced or recorded as gaps. The safety rule is:

```md
Preserve HDS authority safety first.
Then make the safe path understandable, recoverable, and comfortable enough for permanent owner operation.
```

## 4. 5-Minute Setup Claim

BLUE-TANUKI rejects marketing parity around "5-minute setup" as a completion claim.

A fast first run is useful only if it does not conceal permanent-use complexity. BLUE-TANUKI may only claim a beginner-fast path when the repository has a tested supported-OS flow covering:

- prerequisite checks
- setup command
- start command
- Control Center access
- first WebChat message
- doctor output with actionable remediation
- no unexplained daemon, credential, or config state
- documented rollback or cleanup path

Until then, BLUE-TANUKI uses the phrase "guided first-run path" instead of a verified time-based beginner guarantee.

## 5. Permanent-Use UX

BLUE-TANUKI treats permanent-use UX as a release gate.

Permanent use requires more than a successful demo. A release-quality path must cover:

- startup and restart
- config preservation
- credential rotation and safe missing-credential behavior
- approval queue visibility
- runtime schedule visibility
- audit verification
- doctor output that says what failed, why, whether it is safe, and what to do next
- update, rollback, uninstall, and purge
- no hidden background mutation

This is why operator usability documentation, doctor remediation fields, Control Center status, and release-bundle validation are core engineering work rather than polish.

## 6. Channel Breadth

BLUE-TANUKI rejects channel count as a product-quality metric.

A channel is first-party only when it has:

- documented setup
- explicit credential expectations
- live smoke or safe skip path
- inbound and outbound tests
- typed recoverable/non-recoverable failures
- rate-limit/backoff behavior where relevant
- audit-compatible traces
- conformance tests
- proof that channel metadata cannot escalate authority

Long-tail channels belong behind the adapter contract, capability envelope, compatibility matrix, and preview quarantine until they satisfy those gates.

## 7. Safety Boundary

BLUE-TANUKI requires a stronger safety boundary than an agent-first integration pattern.

The permanent boundary is:

```md
HDS-BRAIN owns authority.
LLMs, tools, channels, plugins, skills, memory, cron, browser automation, UI, onboarding, update flows, companion apps, and external services are downstream devices.
```

Therefore:

- HDS-BRAIN must not call an LLM.
- Memory is context, preference, continuity, and audit reference only; it is not authority.
- Channel metadata cannot create authority.
- Tool output cannot create authority.
- External service metadata cannot create authority.
- Cron and webhook actors are not humans.
- Full access cannot bypass final-review.
- Reusable approval grants cannot bypass final-review.
- Dashboard and Control Center actions cannot become a second authority path.

Any OpenClaw-like feature that cannot be rebuilt under this boundary is rejected or reserved.

## 8. Update / Rollback

BLUE-TANUKI requires update and rollback to be inspectable owner operations.

The update path must preserve:

- env/config files unless reset is explicit
- audit, session, and memory state unless purge is explicit
- release-bundle integrity checks
- doctor-after-update checks
- rollback instructions that do not require internal code knowledge
- clear distinction between app replacement and local data deletion

No automatic update, daemon install, or service metadata change may silently alter authority behavior.

## 9. Skills / Plugin Supply Chain

BLUE-TANUKI rejects unsigned third-party skill execution in first-party core.

The rejected pattern is an open marketplace-style skill surface where third-party code can gain practical authority through convenience, metadata, or hidden side effects.

BLUE-TANUKI accepts extension only through:

- stable adapter contracts
- manifest-driven capability declarations
- deny-by-default permission enforcement
- conformance tests
- audit trace compatibility
- preview quarantine
- signed-third-party review in a later phase if needed

Unreviewed direct ClawHub code execution is a non-goal. A reviewed and capability-bounded equivalent adapter remains an engineering candidate; marketplace metadata never grants authority.

## 10. WhatsApp Ecosystem

WhatsApp is intentionally excluded from first-party core.

This is not a "too hard, defer later" decision. It is a safety and liability boundary. The WhatsApp ecosystem creates operational and responsibility surfaces that do not fit BLUE-TANUKI first-party guarantees.

Policy:

- Do not implement Baileys.
- Do not implement WAHA.
- Do not implement WhatsApp Web automation.
- Do not implement first-party WhatsApp Business API.
- Do not implement Twilio WhatsApp as first-party core.
- Do not add WhatsApp-specific hidden hooks.
- Keep WhatsApp as `reserved-third-party` in the compatibility matrix.
- Only the generic adapter interface may exist.
- BLUE-TANUKI does not warrant third-party WhatsApp adapters.

## 11. Adopt / Adapt / Reject / Reserve

| OpenClaw-style pattern | Assessment | BLUE-TANUKI action |
|---|---|---|
| Guided onboarding | Useful but can hide complexity | Adapt under HDS, doctor, and actionable setup |
| Daemon/service install | Useful for permanence but failure-prone | Adapt after safety kernel and recovery docs |
| Dashboard / Control UI | Useful if it closes the next-action loop | Adapt as Control Center |
| Many channels | Feature breadth and high operational burden | Reject as core strategy |
| Telegram as fastest channel | Valid practical starter | Adopt |
| WhatsApp ecosystem | Third-party extension surface where audit/authority boundaries cannot be guaranteed first-party | Reject as first-party; reserve third-party only |
| DM pairing / allowlist | Strong inbound safety idea | Adapt into owner access model |
| Device/node pairing | Useful later, not v0.1 core | Reserve for v0.3+ |
| Update / rollback docs | Necessary for permanence | Adopt |
| Doctor diagnostics | Necessary only if actionable | Adapt with concrete next actions |
| Skills/plugin marketplace | Supply-chain and hidden-authority risk | Reject for first-party core |
| Companion apps / voice / canvas | UX-expanding but support-heavy | Reserve for later phases |

## 12. Resulting BLUE-TANUKI Roadmap Effects

This audit fixes the roadmap consequences:

- v0.1 remains a Safety Demonstration Release focused on WebChat, Telegram, Approval Gate, Runtime Invariants, hash-chain audit, and guided local operation.
- Slack and Discord are release-polished preview channels after Phase 8-S5; first-party promotion still waits on owner-run credentialed live smoke.
- GitHub write, browser automation, Google integrations, Teams, and LINE are downstream features that must enter through ApprovalLevel, capability envelope, audit, and conformance gates.
- WhatsApp remains `reserved-third-party` and is not a v0.1, v1.0, or first-party completion requirement.
- Browser automation is preview-only until sandbox, credential, network, resource-limit, ApprovalLevel, and audit requirements are closed.
- Memory and F-reference work must preserve `memory_used_for_authority=false`.
- Operator usability documentation, doctor remediation, update/rollback runbooks, and Control Center status are release gates, not optional polish.
- v1.0 requires security and permanent-use review closure before release-candidate claims.

The controlling rule remains:

```md
OpenClaw gives an agent hands.
BLUE-TANUKI gives authority a body.
```

## Two-Dimensional Position

This document governs the design-posture rejection dimension.

The feature-coverage target dimension is governed by [STRATEGY_FRAME.md](STRATEGY_FRAME.md), especially its OpenClaw Position section.

These dimensions coexist independently:

- design posture rejection remains unchanged;
- selected-scope superiority is an older v1.0 RC claim boundary, not the current AGI-wide capability inventory;
- the current inventory includes every observed capability as wired, explicit BUILD_GAP, or individually justified owner deferral;
- the coverage target never weakens HDS authority, Approval Gate, audit, Runtime Invariants, or preview quarantine.

Unsafe OpenClaw implementation postures remain rejected; the current AGI capability inclusion target must not weaken HDS authority, Approval Gate, audit, Runtime Invariants or preview quarantine. No superiority claim is established without system QC, scoped QA and owner GO.
