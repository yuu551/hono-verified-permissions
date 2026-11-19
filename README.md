# hono-verified-permissions

Hono のルートに Amazon Verified Permissions の認可を追加する TypeScript ミドルウェアです。ルートごとに Cedar のアクションとリソースを指定します。認可判定には Express 版でも使われている公式の `AVPAuthorizationEngine` を利用できます。[公式クライアント](https://github.com/verifiedpermissions/authorization-clients-js) · [Express 版](https://github.com/cedar-policy/authorization-for-expressjs)

## ローカルで試す

開発環境には Node.js 24 と npm を使います。

```sh
npm ci
npm test
npm run check
```

AWS Emulator をポート 9297 で起動し、次のコマンドを実行します。Linux のパッケージ版は `aws-emulator` で起動できます。macOS と Windows の起動手順は [AWS 公式の Docker ガイド](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html) にあります。

```sh
npm run test:emulator
```

このテストはローカルのポリシーストアを作り、Hono の `GET /documents/:id` にリクエストを送ります。Alice に `guide` の閲覧を許可すると、Alice は `200`、Bob は `403`、未認証のリクエストは `401` になります。さらにローカルの Cognito ユーザープールでサインインし、発行されたアクセス・ID トークンそれぞれで閲覧の許可と拒否を確認します。テスト終了時にストアとユーザープールを削除します。

接続先は `https://127.0.0.1:<port>` です。テストプロセスは `~/.aws/emulator/<port>/` の認証情報と CA 証明書を使います。別ポートで起動した場合は `AWS_EMULATOR_PORT=9300 npm run test:emulator` のように指定します。GitHub Actions のワークフローは AWS Emulator 1.0.385 を使用します。

## Hono で使う

手元の別プロジェクトから試すには、このリポジトリで `npm pack` を実行します。利用側で次のようにインストールしてください。

```sh
npm install hono@4 @verifiedpermissions/authorization-clients-js /path/to/hono-verified-permissions-0.1.0.tgz
```

Node.js 24 の TypeScript プロジェクトで AWS SDK の型もチェックする場合は、開発依存に `@types/node@24` を追加してください。TypeScript 6 では `compilerOptions.types` に `"node"` を含めます。

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

`principal`、`resource` と、任意の `context`、`entities` は同期・非同期の関数を受け付けます。関数から `c.req`、`c.var`、`c.env` を参照できます。テナント所属や文書の所有者などの属性は、アプリケーションが検証したセッションやデータベースから取得してください。

### Cognito のトークンを使う

ポリシーストアにユーザープールを ID ソースとして登録し、実行ロールに `verifiedpermissions:IsAuthorizedWithToken` を許可します。アクセストークンを受け取る API では、次の設定で `Authorization: Bearer <token>` を Verified Permissions に渡せます。ID トークンを使う場合は `callType` に `'identityToken'` を指定します。[トークン方式のサンプル](./examples/token-documents.ts) · [ID ソースの登録](https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_CreateIdentitySource.html)

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

`bearerTokenPrincipal` はトークン方式専用です。トークンの検証と principal の特定は Verified Permissions が行います。許可時にはエンジンが返した `principalUid` と `determiningPolicies` を後続のハンドラーから `c.var.authorizerInfo` で参照できます。

| 判定 | Hono の動作 |
| --- | --- |
| principal を取得できない、または Bearer ヘッダーの形式が不正 | `401 Unauthorized` |
| エンジンが `deny` を返す | `403 Forbidden` |
| エンジンが `allow` を返す | 後続のハンドラーを実行 |
| エンジンが `error` を返す、または例外を投げる | `503 Authorization unavailable` |

公式エンジンはトークンの検証エラーも `error` として返すため、その場合の応答は `503` です。アプリケーション側のリゾルバーが投げた例外は Hono の `onError` に渡ります。

## ライセンス

[Apache License 2.0](./LICENSE)
