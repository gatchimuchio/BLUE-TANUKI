# BLUE-TANUKI P13 Owner GO 準備状態

P13 は product release の最終判断境界である。現在は **`PENDING_OWNER_GO`** であり、GA ではない。

この文書は証拠と operator 案内であり `used_for_authority=false` である。command approval、risk classification、preview promotion、HDS-BRAIN の代替、consent 推定、public claim 有効化、final review 迂回を行わない。

## 現在の機械状態

```text
status=pre_go_ready
owner_go=pending
public_claim_allowed=false
package_version=1.0.0-rc.1
japanese_base=規定成立・移行中
japanese_base_strict=false
```

`1.0.0` への actual promotion は、owner GO evidence と全 gate が揃い、意図的な promotion block が実行されるまで閉じる。

## P13 条件

| 条件 | 現在状態 | 証拠 |
|---|---|---|
| Linux local validation | GO 前に full PASS が必要 | owner / Codex local report |
| `validate:product` | Linux local。Windows-only は実機別証拠 | `pnpm validate:product -- --phase P13` |
| Windows実機E2E | 未充足。GO 前に PASS と evidence pack が必要 | owner-run Windows evidence |
| D1-D8 decision | 記録あり | `docs/product-owner-decisions.md` |
| first-party / preview exclusion | 維持 | support / limitations / compatibility matrix |
| release bundle / sha256 / manifest | 最終変更後に再生成・検証が必要 | `pnpm release:bundle`, `pnpm release:verify` |
| owner decision | 不在 | `docs/ga-owner-decision.json` |
| version | RC 維持 | `package.json`, D2 |
| 日本語基底通常 gate | J0 で成立対象 | `pnpm validate:japanese-base` |
| 日本語基底 strict gate | 移行負債が残るため未成立 | `pnpm validate:japanese-base -- --strict` |

## GO blocker

次のすべてが真になるまで P13 を GA complete と報告しない。

- owner が明示 GO を記録する
- `docs/ga-owner-decision.json` が存在し schema validation を通る
- D2 に従い version を意図的に昇格する
- `pnpm validate:ga -- --require-owner-go` が通る
- `pnpm validate:japanese-base -- --strict` が通り、移行負債が空である
- Windows実機E2E evidence pack を owner が確認する
- 公開対象の external surface に必要な credentialed live smoke / redaction evidence を確認する
- 最終 claim / version 変更後に release bundle を再生成・検証する
- README / QUICKSTART / CLAIM の公開文言は GO 後の独立 block だけで変更する

## Fail-closed

owner GO evidence が不在、不明、malformed、version と不整合、または日本語基底 strict gate 未成立なら、状態を次に保つ。

```text
PENDING_OWNER_GO
public_claim_allowed=false
```

tests、bundle、docs、remote runner、operator convenience、LLM output から GO を推定しない。J0 の日本語基底「規定成立」を「全資産移行完了」または GA readiness に読み替えない。
