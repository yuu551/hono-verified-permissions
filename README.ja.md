# hono-verified-permissions

[English](./README.md) · 日本語 · [FastAPI 版（Python）](https://github.com/yuu551/fastapi-verified-permissions/blob/main/README.ja.md)

Amazon Verified Permissions を使って Hono のルートを保護する TypeScript ミドルウェアです。ルートごとに Cedar のアクションとリソースを指定します。認可の判定には Express 版と同じ公式クライアントの `AVPAuthorizationEngine` を使えます。[公式クライアント](https://github.com/verifiedpermissions/authorization-clients-js) · [Express 版](https://github.com/cedar-policy/authorization-for-expressjs)

[ブラウザーで認可を試す](https://yuu551.github.io/verified-permissions-playground/) · [画面付き AWS CDK サンプル](https://github.com/yuu551/verified-permissions-playground/blob/main/README.ja.md)

## インストール

Hono プロジェクトで次のコマンドを実行すると、GitHub Releases の v0.1.0 と認可に使う AWS クライアントがインストールされます。

```sh
npm install hono@4 @verifiedpermissions/authorization-clients-js \
  https://github.com/yuu551/hono-verified-permissions/releases/download/v0.1.0/hono-verified-permissions-0.1.0.tgz
```

Node.js 24 の TypeScript プロジェクトで AWS SDK の型もチェックする場合は、開発依存に `@types/node@24` を追加してください。TypeScript 6 では `compilerOptions.types` に `"node"` を含めます。

## Hono で使う

次の例では、認証ミドルウェアがセッションを検証して `c.var.userId` にユーザー ID を設定する想定です。AWS SDK のリージョンと認証情報はアプリケーション側で設定します。実行ロールには使用するストアへの `verifiedpermissions:IsAuthorized` 権限が必要です。[動作するルートの例](./examples/documents.ts) · [IsAuthorized API](https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_IsAuthorized.html)

```ts
import { AVPAuthorizationEngine } from '@verifiedpermissions/authorization-clients-js'
import { Hono } from 'hono'
import { createAuthorizer } from 'hono-verified-permissions'

type AppEnv = { Variables: { userId: string | null } }
const app = new Hono<AppEnv>()
// ここでセッション認証用のミドルウェアを登録する
const authorize = createAuthorizer<AppEnv>({
  engine: new AVPAuthorizationEngine({
    policyStoreId: process.env.POLICY_STORE_ID!,
    callType: 'isAuthorized',
  }),
  principal: (c) => c.var.userId ? { type: 'Demo::User', id: c.var.userId } : null,
})

const path = '/documents/:id'
app.get(path, authorize<typeof path>({
  action: { type: 'Demo::Action', id: 'view' },
  resource: (c) => ({ type: 'Demo::Document', id: c.req.param('id') }),
}), (c) => c.json({ document: c.req.param('id'), reader: c.var.authorizerInfo.principalUid.id }))
```

対応する Cedar ポリシーは次のように書けます。

```cedar
permit(
    principal == Demo::User::"alice",
    action == Demo::Action::"view",
    resource == Demo::Document::"guide"
);
```

`principal`、`resource`、`context`、`entities` には同期関数も非同期関数も指定できます。このうち `context` と `entities` の指定は任意です。各関数からは `c.req`、`c.var`、`c.env` を参照できます。所属するテナントや文書の所有者などの属性は、アプリケーションが検証したセッションやデータベースから取得してください。

### Cognito のトークンを使う

ポリシーストアにユーザープールを ID ソースとして登録し、実行ロールに `verifiedpermissions:IsAuthorizedWithToken` を許可します。アクセストークンを受け取る API では、次の設定で `Authorization: Bearer <token>` ヘッダーから取り出したトークンを Verified Permissions に渡せます。ID トークンを使う場合は `callType` に `'identityToken'` を指定します。[トークン方式のサンプル](./examples/token-documents.ts) · [ID ソースの登録](https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_CreateIdentitySource.html)

```ts
import { bearerTokenPrincipal, createAuthorizer } from 'hono-verified-permissions'
import { AVPAuthorizationEngine } from '@verifiedpermissions/authorization-clients-js'

const authorize = createAuthorizer({
  engine: new AVPAuthorizationEngine({
    policyStoreId: process.env.POLICY_STORE_ID!,
    callType: 'accessToken',
  }),
  principal: bearerTokenPrincipal,
})
```

`bearerTokenPrincipal` はトークン方式専用です。Verified Permissions がトークンを検証し、principal を特定します。Cognito を使う場合、ポリシーで指定する principal の ID は `<user-pool-id>|<sub>` の形式です。リクエストが許可されると、後続のハンドラーでは `c.var.authorizerInfo` を通じて、エンジンが返した `principalUid` と `determiningPolicies` を参照できます。

| 判定 | Hono の動作 |
| --- | --- |
| principal を取得できない、または Bearer ヘッダーの形式が不正 | `401 Unauthorized` |
| エンジンが `deny` を返す | `403 Forbidden` |
| エンジンが `allow` を返す | 後続のハンドラーを実行 |
| エンジンが `error` を返す、または例外を投げる | `503 Authorization unavailable` |

公式エンジンはトークンの検証エラーも `error` として返すため、その場合の応答は `503` です。アプリケーション側のリゾルバーが投げた例外は Hono の `onError` に渡ります。

## AWS での構成例

![クライアントは Cognito でサインインし、API Gateway にトークンを送ります。API Gateway が JWT を検証し、Lambda 上の Hono が Verified Permissions に認可を問い合わせます。](./docs/aws-architecture.png)

この構成では、API Gateway の JWT オーソライザーが Cognito のトークンを検証してから Lambda を呼び出します。Hono はパスに含まれる文書 ID を Cedar のリソースに対応づけます。トークン方式ではミドルウェアが `IsAuthorizedWithToken` にトークンを渡します。エンティティ方式では、API Gateway が検証したクレームから principal を組み立てて `IsAuthorized` を呼び出します。Lambda の実行ロールには、対象のポリシーストアで該当する API を呼び出す権限が必要です。[編集用の構成図](./docs/aws-architecture.drawio)

`us-east-1` にデプロイし、エンティティ、アクセストークン、ID トークンの3方式を HTTPS 経由で検証しました。いずれも Alice が `guide` を読むと `200`、`draft` を読むと `403` が返り、Bob が `guide` を読むと `403` になりました。Cedar の `forbid` を追加すると、3方式とも Alice の `guide` 閲覧は `403` になりました。トークンを付けずに送ったリクエストには API Gateway が `401` を返しました。

## 開発とテスト

開発環境には Node.js 24 と npm を使います。

```sh
npm ci
npm test
npm run check
```

統合テストを実行する前に、AWS Emulator をポート 9297 で起動します。Linux のパッケージ版は `aws-emulator` で起動できます。macOS と Windows での起動手順は AWS の Docker ガイドにあります。[AWS 公式の Docker ガイド](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html)

起動したら、次のコマンドで統合テストを実行します。

```sh
npm run test:emulator
```

このテストはローカルにポリシーストアを作り、Hono の `GET /documents/:id` にリクエストを送ります。Alice に `guide` の閲覧を許可すると、同じ文書へのリクエストに対して Alice には `200`、Bob には `403`、未認証の場合は `401` が返ります。

トークンを使うテストでは、ローカルの Cognito ユーザープールにサインインし、発行されたアクセストークンと ID トークンのそれぞれで、文書の閲覧が許可される場合と拒否される場合を確認します。テストが終わると、テスト用のストアとユーザープールを削除します。

テストの接続先は `https://127.0.0.1:<port>` です。テストプロセスは `~/.aws/emulator/<port>/` の認証情報と CA 証明書を使います。別のポートで起動した場合は `AWS_EMULATOR_PORT=9300 npm run test:emulator` のようにポート番号を指定します。GitHub Actions で使う AWS Emulator のバージョンは 1.0.385 です。

## ライセンス

[Apache License 2.0](./LICENSE)
