# Business Booking Template

VoiceDev Business Factory用の汎用予約システムテンプレートです。

## Safety

- `TAMAFIT/-reserve` は参照専用。本repoから変更しない。
- 現行たまフィットのGAS URL、メール、LINE URL、広告ID等はコピーしない。
- 初期テンプレートは外部integration無効から開始する。
- `.voicedev/config.json` が `deployment.type: pending` の間は公開しない。
- Google OAuth token、LINE channel secret / access tokenをGit・Issue・configへ保存しない。
- Google / LINEとも、E2EはこのFactory用に新規生成したテスト資産だけを使う。

## 店舗ごとに変更する場所

原則 `business.config.json` だけです。

設定対象:

- 店名 / 業態表示 / 住所 / 連絡先
- タイムゾーン / 曜日別営業時間 / 予約枠
- メニュー / 所要時間 / スタッフ
- 予約API (GAS) URL
- Google Calendar / Apps Script Provisioning情報
- LINE / LIFF情報
- GA4 / Google Ads情報
- アクセントカラー / コピー

## v0.1: config-driven booking frontend

予約フロントと外部接続インターフェースを汎用化しています。

```bash
python -m http.server 8080
```

## v0.2 / v0.4.1: Google Provisioner + stable OAuth

`scripts/google-provision.mjs` が、認証済みGoogleユーザーの所有物として予約Calendar、Apps Script project、version、web app deploymentを作成・更新し、公開Health Check成功後だけBooking APIをlive化します。

v0.4.1からGitHub Actionsでは短命なAccess Tokenを手作業で差し替えず、次のstable OAuth secretsから`scripts/google-oauth.mjs`が実行時にAccess Tokenを自動更新します。

```text
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
```

移行用に`GOOGLE_ACCESS_TOKEN`もfallbackとして認識しますが、Refresh Token方式を優先します。Refresh Token、Client Secret、生成されたAccess TokenはいずれもGitへ保存しません。

Dry run:

```bash
npm run google:dry-run
```

必要scope:

- `https://www.googleapis.com/auth/calendar`
- `https://www.googleapis.com/auth/script.projects`
- `https://www.googleapis.com/auth/script.deployments`

Apps Script APIの初回Calendar認可が未完了なら`authorization-required`でfail closedします。

## v0.3: LINE / LIFF Provisioner

予約フロントにLIFF SDK v2を追加し、`scripts/line-provision.mjs`でLINE Login channel上のLIFF appを作成・更新できるようにします。

Provisionerの流れ:

1. `business.config.json`のLIFF endpointを検証
2. endpointがHTTPSで公開済みかHealth Check
3. LINE Login channel credentialsから短命channel access tokenを実行時だけ取得、または実行時tokenを利用
4. 既存`liffId`がなければLIFF appをcreate
5. 既存`liffId`があれば同一channel上に存在することを確認してupdate
6. LIFF Server APIで再取得してLIFF IDとendpointを検証
7. 成功した場合だけ`integrations.line.enabled: true` / `status: live` / `liffUrl`をconfigへ保存

Dry run:

```bash
npm run line:dry-run
```

実行時credentialsは次のどちらかです。

```text
LINE_LIFF_CHANNEL_ACCESS_TOKEN
```

または、Provisionerが実行時にchannel access tokenを発行するための:

```text
LINE_LOGIN_CHANNEL_ID
LINE_LOGIN_CHANNEL_SECRET
```

GitHub Actionsでは`[LineProvision]`で始まるIssueを作成すると`.github/workflows/line-provision.yml`が起動します。Secret値はIssue本文へ書きません。

### LIFF Runtime

LINE接続後は:

- `liff.init({ liffId })`
- LINE内ブラウザか外部ブラウザかを識別
- `profile` scopeがある場合だけ表示名を取得し、空欄のお名前欄へ補助入力
- LINE user IDはv0.3既定フローでは保存しない
- 予約payloadの`source`を`line-liff`等へ切り替えて流入だけ識別

新規サービスではLINE MINI Appが推奨方向ですが、v0.3は既存LIFF互換とFactory E2Eの実証のため`mode: "liff"`を実装し、将来`mini-app`を追加できるconfig構造にしています。

## Booking API contract

空き枠:

```text
GET {baseUrl}?date=YYYY-MM-DD
=> { "success": true, "availableSlots": ["10:00", "11:00"] }
```

Health check:

```text
GET {baseUrl}?action=health
=> { "ok": true, "service": "business-booking-gas" }
```

予約:

```text
POST {baseUrl}
Content-Type: text/plain;charset=utf-8
Body: JSON
```

## テスト

```bash
npm test
```

Google/LINE ProvisionerとOAuth helperの自動テストは外部本番へ書き込まず、モックHTTPでrefresh/create/update/verification/fail-closedを検証します。

## Business Factory handoff

通常のBusiness Factory製造ではGoogle OAuth secretsはVoiceDev Master側だけに置き、生成店舗repoへコピーしません。クライアントへMasterなしで完全移管する場合のみ、このrepo-local Refresh Token方式をfallbackとして利用できます。
