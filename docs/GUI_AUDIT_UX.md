# GUI Audit UX

## 1. Purpose

Audit UX lets the owner inspect evidence without turning evidence into authority.

The GUI may show:

- audit chain validity
- event kind
- actor/source
- request id
- command id
- payload digest
- entry hash
- replay metadata
- failure/recovery hints

## 2. Evidence Rules

Audit, authority trace, and complete history are evidence surfaces only.

They must not:

- approve commands
- mutate policy
- mutate history
- rewrite audit
- recover a failed invariant
- convert replay entries into authority

## 3. Content Exposure

The GUI defaults to digest/metadata projection. It must not serialize raw payloads, credentials, bearer tokens, approval tokens, command content, rendered output, or raw tool/LLM result values.

## 4. Verification

Audit verification is evidence. It can say the observed chain is valid or invalid for the current source. It cannot by itself prove GA readiness, installed-path release integrity, or external tamper resistance.
