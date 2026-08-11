# VoiceDev OS operating rules

このリポジトリは VoiceDev OS（ボイスデブ）対応プロジェクトとして扱う。

## 基本方針

1. GitHub `main` をコードの正本とする。
2. 変更前に必ず最新コードと既存構成を確認する。
3. 既存機能を壊さないことを最優先とする。
4. 原則として `main` から作業ブランチを作り、変更、必要なテスト、PR、CI確認を行う。
5. CI成功後にのみ `main` へ反映する。
6. デプロイ対象の場合、`main` 反映と本番デプロイの成功を別々に確認する。
7. 「直しました」「完了」は、必要なテストと本番反映確認後にのみ使う。
8. Secret、OAuthトークン、APIキー、`.clasprc.json` 等をGitへコミットしない。
9. 軽微な変更でも現行コードを確認してから変更する。
10. ユーザーへの通常報告は成果物中心に簡潔にする。詳細ログは失敗時または要求時のみ提示する。

## Business Booking Template固有ルール

1. `TAMAFIT/-reserve` は本番参照元であり、Business Factory開発から変更してはならない。
2. 現行たまフィットのGAS URL、Calendar ID、LINE URL、メール、広告計測IDなどの本番値をこのテンプレートへコピーしない。
3. 店舗固有値は原則 `business.config.json` に集約し、アプリコードへ直書きしない。
4. 初期テンプレートは `development.mockMode: true` かつ外部integration無効で安全に単独検証できる状態を維持する。
5. GAS / Google Calendar / LINEを接続する場合は、テンプレート固有のテスト環境または新規生成されたリソースだけを使い、既存本番リソースを流用しない。
6. `.voicedev/config.json` の `deployment.type` が `pending` の間は公開しない。
7. クライアント向け生成物は最終的にクライアント所有のGitHub / Google / LINE資産だけで自立動作できること。

## Google Provisioner固有ルール

1. Apps Script APIは店舗オーナー本人のOAuthとして実行する。service accountへ置き換えない。
2. `GOOGLE_ACCESS_TOKEN` / refresh token / OAuth client secretをGit・Issue・config・ログへ保存しない。
3. 初回は必ず `npm run google:dry-run` でcreate/reuse/update計画を確認する。
4. 既存 `calendarId` / `scriptId` / `deploymentId` がconfigにある場合はそれを再利用し、重複リソースを無条件に新規作成しない。
5. Provisionerが生成した新規CalendarとApps Scriptだけをv0.2のE2E対象にする。
6. Web App URLが取得できない場合は `mockMode` を解除しない。
7. Apps Script自身のCalendar権限承認が未完了なら、本番接続完了と報告しない。
8. 実予約テストは専用テスト枠で行い、確認後に必要ならテストeventを削除する。

## LINE / LIFF Provisioner固有ルール

1. 現行たまフィット本番のLINE Official Account、Messaging API channel、LINE Login channel、LIFF appは変更しない。
2. v0.3のE2Eは新規テスト用LINE Login channelと新規公開テストendpointだけを使う。
3. `LINE_LOGIN_CHANNEL_SECRET` / channel access token等をGit・Issue・configへ保存しない。GitHub Actions Secretまたは実行時環境変数だけで扱う。
4. LIFF endpointはHTTPSで公開済みかつHealth Check成功後にだけcreate/updateする。
5. configに既存`liffId`がある場合は、接続したLINE Login channel上に同じLIFF appが存在することを確認してからupdateする。存在しない場合は重複作成せず停止する。
6. Provisioner成功後にLIFF Server APIで再取得し、LIFF IDとendpoint URLが一致した場合だけ`integrations.line.status: live`にする。
7. LIFF Runtimeでは必要以上のLINEプロフィール情報を保存しない。v0.3は表示名のフォーム補完と流入識別だけを既定用途とする。
8. 新規サービスでは将来のLINE MINI App移行を考慮し、`integrations.line.mode`を拡張可能な構造に保つ。v0.3は互換性検証として`liff`を実装する。

## VoiceDev成果物モード

正常終了時は原則として以下だけを返す。

- 実施内容
- テスト結果
- 本番反映結果
- 確認URL（存在する場合）
- 人間の確認が必要な事項（存在する場合）

## 納品独立性

VoiceDev Masterは製造・更新支援に使用してよいが、本番成果物がMaster repoや制作者個人のアカウントへ永続依存する設計は禁止する。
