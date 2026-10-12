# BLUE-TANUKI 非対象と禁止方式の区別

この文書は「危険なので禁止する実装方式」と「旧v1.0 RCが搭載しない機能」を分ける。新AGI/QEの対象にはOpenClaw・Museで観測された能力を残し、安全な実装形態が未完成ならBUILD_GAPとする。安全な代替実装の可能性まで一律にnon-goalとして消さない。

## 禁止する方式

- LLM、agent、memory、history、UI、metadata等が独自のauthority、Owner同意、Approvalを生成・拡大する方式。
- HDS、L3 final review、環境Permission、hash-chain監査、回復、秘密保護の迂回。
- ClawHub等からの無審査コード直接実行、unsafe third-party skill、隠れた権限昇格、ブラックボックスの外部作用。
- Agent-driven authority core、感情機能の無根拠な追加、CLI-onlyの最終UX、未支援previewの公開製品化。
- 未承認の外部実業務、credential、別repo書込み、商用SaaS拡張、Owner GO前のGA・AGI完成・完全優位主張。

## 旧v1.0 RCに含まれないが、AGI全体の要求削除ではない項目

- WhatsApp first-party core、Baileys、WAHA、WhatsApp Web automation、Business API／Twilioのfirst-party導入は旧RCでは非対象。compatibility matrixのreserved-third-partyとcore_supported=falseを維持する。
- ClawHub marketplaceの無審査直接実行は禁止。ただし認証、隔離、権限、監査を満たす安全な互換Adapterや相当機能まで永久に排除しない。
- Voice/mobile、signed native installer、公開第三者Skill registry等、旧RCに非搭載の能力は現状非搭載として記録する。新AGIの全体能力検討からは消さない。

## QE工程と公開

QE_BUILDは全体設計を実装し、BUILD_COVERED後にQE_QCで実物を検査・改善し、QE_QAで対象別にQA_SCOPED／QA_NOT_ESTABLISHEDを判断する。危険な未接続作用を有効化せず、最低限の安全拒否・停止確認をBUILD中に保つ。

旧v1.0 RCは1.0.0-rc.1、P13=PENDING_OWNER_GO、public_claim_allowed=false。SUPPORT_BOUNDARYとKNOWN_LIMITATIONSはその出荷版に限る証拠・制限であり、新AGI全体の実装要求を縮小する正本ではない。
