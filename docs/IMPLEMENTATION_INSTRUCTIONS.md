# BLUE-TANUKI 現行QE_BUILD指示

2026-10-18。今回の単位開始時にowner指定の最新版QE三点全文（rev2.3）、適用AGENTS.md、作業標準、QE再同期規約、active指示、最新HEAD／remote／dirty state、D09.02要求、承認・Gmail実装と現行WebChat経路を読み直した。Windows上のBLUE-TANUKIだけを対象とし、D4Pocket／ミニドラには変更を加えない。

## 今回の施工単位

backup ref移行状態=`MIGRATION_COMPLETE`。QE_STAGE=QE_BUILD。BUILD_BATCH=QEB-03-D09.02-BLUE-APPROVAL-CONTENT-REVIEW。関連単位=D09.02（BLUE側の部分施工）。開始HEAD／origin/main=`24c550ed2d73a42f8502edd38d7ca6c3252ca69a`、clean。編集前local recovery branchは`af905ab`／`41bea5f`、remote backup tagはlease付きatomic pushで`24c550e`／`af905ab`へ回転した。競合したlocal tagsは変更していない。

### 今回の目的と境界

既存WebChat承認画面で、pending中のGmail `message.send`についてownerが明示的に内容を確認し、その時点の完全なcommand digestに結び付けて承認する経路をBLUE側で成立させる。宛先（to/cc/bcc/from）、実際に送られる件名・本文、effective request payload digestを、resume認証済みの明示操作に限って表示する。通常の承認一覧、runtime snapshot、監査履歴には本文・宛先を追加しない。previewだけでは承認・実行・権限を発生させない。approve時も既存HDS承認と一回券を通し、現在のpending command digestを再検証する。

対象=D09.02 BLUE-side WebChat content review、合成・fixtureによる検証。対象外=D4Pocket変更（別途限定委任が必要）、credential／実Gmail／外部送信／C08.03、全体QE_QC／QE_QA、公開・出荷判断。D09.02はBLUE部分のみで完了扱いせず、D4 consumerを含む全体状態は`BUILD_GAP`のままとする。

### 必須境界

- 対象は`tool_call`／`gmail.write`／`message.send`だけ。content previewは現在のGateway pending commandから取り、再parse・再計算LLM呼出しをしない。
- explicit `POST /approval/:id/content` とresume tokenを必須にし、レスポンスは`no-store`。内容をsession/local storage、history、audit、通常snapshot、ログへ保存しない。
- previewは有効なpending command、現在のplan binding、command digestを照合し、digest-onlyの開示記録をpending中だけメモリに保持する。実送信に使われない入力や未対応項目を安全に解釈できない場合はpreview／approveをfail-closedする。
- WebChatはpreviewで返ったdigestをapprove要求へ添え、Gatewayが「preview開示が実施されたこと」と同じpending digestを再検査する。digest文字列だけの直接approveは通さない。reject／blockは内容を見ずに可能とする。
- 実provider、実credential、実外部作用、D4Pocket／ミニドラrepo変更は禁止。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。

## 今回の検証・閉包

- `pnpm typecheck`: PASS。`pnpm build`: PASS、15 workspace projects。
- 対象Vitest 3 files／84 tests: PASS。explicit reveal、resume認証、no-store、preview未開示digest拒否、一回券温存、history digest-only projectionを確認。
- `pnpm docs:check`: PASS。CHANGELOG更新後の初回は登録済みhash不一致でFAILし、実ファイルhashを移行台帳へ同期して再実行した。通常日本語gateとlicenseはPASS、移行負債77件を維持。`git diff --check`: PASS。
- 確認範囲は純関数payload投影、実HTTP WebChat API route、history projection、build/typecheck。build済みGateway processとControl Centerを実際に起動するE2E、Gmail credential／実送信、D4 consumer、全体QE_QC／QE_QAは未実施。
- 実装commit `00a1d57`を`origin/main`へpushし、fetch後のlocal／remote main同一性を確認した。QEB-03開始時のlocal recovery branch／remote tagは`24c550e`／`af905ab`の二世代を保持する。

実装経路はBLUE WebChatで明示previewした合成Gmail `message.send`内容の表示と、同一pending command digestを条件とする既存HDS一回券approveに結合した。D4側consumerが未接続のため、D09.02全体は`BUILD_GAP`。P13=`PENDING_OWNER_GO`、`public_claim_allowed=false`を維持する。
