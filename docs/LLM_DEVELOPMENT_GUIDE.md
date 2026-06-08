# LLM_DEVELOPMENT_GUIDE

本書は Codex / LLM / 第三者開発者が BLUE-TANUKI に downstream adapter や module を追加するときの作業境界を定義する。

## Hard Rules

```md
You may implement a new adapter only inside the adapter boundary.
You must not modify HDS-BRAIN, authority policy, approval gate, runtime invariants, audit hash-chain, or memory authority rules.
If the adapter requires new capabilities, declare them in its manifest.
If a required capability is unavailable, fail closed.
Never escalate authority from channel metadata.
Never use memory as authority.
Never call an LLM from the authority path.
All inbound events must normalize into the repository's canonical inbound message type.
All outbound sends must go through the repository's canonical outbound request type.
All errors must map to typed recoverable / non-recoverable errors.
```

## Recommended Workflow

1. `AGENTS.md` を読む。
2. `docs/DEVELOPMENT_PRACTICE.md` で path classification、evidence source、contract-to-runtime 接続を確認する。
3. `docs/ROADMAP.md` の Sacred Constraints を確認する。
4. `docs/ADAPTER_CONTRACT.md` で adapter boundary を確認する。
5. `docs/PLUGIN_REVIEW_GATE.md` / `docs/PLUGIN_HIG.md` / `docs/SKILL_LOADER_CONTRACT.md` で Layer B review boundary を確認する。
6. manifest に capability を宣言する。
7. adapter / plugin / skill を preview として実装する。
8. `docs/CONFORMANCE.md` に沿って tests を追加する。
9. main release gate を通るまで first-party main として扱わない。

## Evidence and Completion Discipline

LLM / Codex は、実装完了を主張する前に次を区別する。

- `CONFIG`: env、manifest、matrix、docs の整合。
- `INTERNAL_STATE`: snapshot、store、in-memory state。
- `LIVE_RUNTIME`: 起動中 gateway、HDS-BRAIN、channel、resident process の実動作。
- `EXTERNAL_EVIDENCE`: CI、extracted bundle、installed path、credentialed live smoke。
- `FIXTURE`: unit fixture、mock、negative sample。

`CONFIG`、`INTERNAL_STATE`、`FIXTURE` は production success や release readiness の代わりにならない。contract を追加した場合は、どの production / runtime / validator path が consume し、どの failure case が reject / audit / suspend されるかを報告する。

## Prohibited Shortcuts

- channel SDK の metadata を authority に変換する
- LLM に approval decision を委譲する
- memory 参照を permission escalation に使う
- manifest にない secret / fs / network / process access を使う
- preview code を support level 未記載で main release に入れる

## Third-Party Plugin / Skill Development

Third-party plugin and skill work belongs to Layer B.

Before implementation, read:

- [Plugin Review Gate](PLUGIN_REVIEW_GATE.md)
- [Plugin HIG](PLUGIN_HIG.md)
- [Skill Loader Contract](SKILL_LOADER_CONTRACT.md)
- [Capability Envelope](CAPABILITY_ENVELOPE.md)
- [Conformance](CONFORMANCE.md)

Layer B code must be downstream-only, manifest-declared, fail-closed, audit-compatible, and readable enough for review. It may extend Layer A first-party surfaces, but it may not replace them or create a parallel authority path.
