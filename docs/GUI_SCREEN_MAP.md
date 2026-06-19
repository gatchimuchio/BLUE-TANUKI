# GUI Screen Map

## Screen Inventory

| Screen | Reads | Actions | Authority boundary |
|---|---|---|---|
| Home / Tanuki Dashboard | runtime snapshot, notifications, responsibility map, Operation Core projections | load read-only state | display only |
| Tasks | runtime schedules, pending schedule approvals, future task state | load state | schedule mutations remain L3 |
| Approvals | pending approvals | approve / reject / block through resume token and one-time approval token | existing Approval Gate only |
| Activity / Audit | audit dump, authority trace, complete history replay | load / verify read-only evidence | evidence only |
| Memory | complete history, F-reference summaries, memory policy status | future forget/delete through gated path | memory not authority |
| Skills | plugin review state, bundled surface state, Operation Core projections | future install/disable/quarantine through review path | plugin metadata and UI projections are not authority |
| Channels | readiness matrix, channel status, notifications | future connect/disable through gated path | channel metadata not authority |
| Doctor | setup and recovery checks | load diagnostics | diagnostics not authority |
| Settings | provider verification, approval mode, memory/channel policy | future save/reset through settings write path | settings write is sensitive |
| Developer / Evidence | repo health, conformance, GA gate, release verify | load evidence | evidence is not release GO |

## Route Mapping

Existing read/write surfaces:

- `GET /runtime/snapshot` with `WEBCHAT_TOKEN`
- `GET /operators/writing`, `GET /operators/daily`, and `GET /operators/developer` with `WEBCHAT_TOKEN`
- `GET /notifications` with `WEBCHAT_TOKEN`
- `GET /history/replay` with `WEBCHAT_TOKEN`
- `GET /audit/dump` with `WEBCHAT_TOKEN`
- `GET /authority/trace` with `WEBCHAT_TOKEN`
- `GET /approval` with `WEBCHAT_RESUME_TOKEN`
- `POST /approval/:id` with `WEBCHAT_RESUME_TOKEN` plus request-bound one-time token

No new backend route is required for the Operation Core Plan viewer. It reads the existing runtime snapshot and operator snapshot surfaces.
