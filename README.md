# hono-verified-permissions

English · [日本語](./README.ja.md) · [FastAPI version for Python](https://github.com/yuu551/fastapi-verified-permissions)

Protect Hono routes with Amazon Verified Permissions. Each route maps an HTTP request to a Cedar action and resource. The middleware passes them to the same `AVPAuthorizationEngine` used by the Express integration and runs the route handler when the engine allows the request. [Authorization client](https://github.com/verifiedpermissions/authorization-clients-js) · [Express integration](https://github.com/cedar-policy/authorization-for-expressjs)

[Try the playground](https://yuu551.github.io/verified-permissions-playground/) · [Deploy the AWS CDK sample](https://github.com/yuu551/verified-permissions-playground)

## Install

Install the middleware and the Amazon Verified Permissions authorization client in your Hono project.

```sh
npm install hono@4 hono-verified-permissions @verifiedpermissions/authorization-clients-js
```

For a Node.js 24 TypeScript project that type-checks the AWS SDK declarations, install `@types/node@24` as a dev dependency. With TypeScript 6, include `"node"` in `compilerOptions.types`.

## Protect a Hono route

The example below assumes an authentication middleware validates a session and sets `c.var.userId` before the protected route. Configure the AWS SDK region and credentials in the application. Its execution role needs `verifiedpermissions:IsAuthorized` on the policy store. [Document route example](./examples/documents.ts) · [IsAuthorized API](https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_IsAuthorized.html)

```ts
import { AVPAuthorizationEngine } from '@verifiedpermissions/authorization-clients-js'
import { Hono } from 'hono'
import { createAuthorizer } from 'hono-verified-permissions'

type AppEnv = { Variables: { userId: string | null } }
const app = new Hono<AppEnv>()
// Register middleware here that verifies the session and sets c.var.userId.
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

For this session-based example, the following Cedar policy lets Alice read the guide.

```cedar
permit(
    principal == Demo::User::"alice",
    action == Demo::Action::"view",
    resource == Demo::Document::"guide"
);
```

The `principal`, `resource`, `context` and `entities` callbacks can be synchronous or asynchronous and can read `c.req`, `c.var` and `c.env`. The last two callbacks are optional. Resolve attributes such as tenant membership and document ownership from a verified session or trusted application data.

### Use Cognito tokens

Register the user pool as an identity source and grant the application role `verifiedpermissions:IsAuthorizedWithToken` on the store. The following setup passes the token from the `Authorization: Bearer <token>` header to Verified Permissions. For ID tokens, set `callType` to `'identityToken'`. [Token example](./examples/token-documents.ts) · [CreateIdentitySource API](https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_CreateIdentitySource.html)

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

Use `bearerTokenPrincipal` with a token-based engine. Verified Permissions verifies the token and identifies the principal. For a Cognito principal, the entity ID in the policy takes the form `<user-pool-id>|<sub>`. After an allow decision, the handler can read the engine's `principalUid` and `determiningPolicies` from `c.var.authorizerInfo`.

| Outcome | Hono behavior |
| --- | --- |
| Missing principal or malformed bearer header | Returns `401 Unauthorized` |
| Engine returns `deny` | Returns `403 Forbidden` |
| Engine returns `allow` | Runs the next handler |
| Engine returns `error` or throws | Returns `503 Authorization unavailable` |

The upstream engine reports token verification failures as `error`, which the middleware maps to `503`. Exceptions thrown by application resolvers go to Hono's `onError` handler.

## AWS reference architecture

![A client signs in with Amazon Cognito and sends a bearer token to API Gateway. API Gateway validates the JWT and invokes Hono on Lambda. The middleware asks Verified Permissions to evaluate Cedar policies.](./docs/aws-architecture.png)

In this deployment, the API Gateway JWT authorizer validates the Cognito token before invoking Lambda. Hono maps the document ID from the path to a Cedar resource. The middleware can pass the token to `IsAuthorizedWithToken`, or call `IsAuthorized` with a principal derived from the claims API Gateway verified. The Lambda execution role needs permission for the corresponding operation on the policy store. [Editable diagram](./docs/aws-architecture.drawio)

We exercised all three modes (entity, access token and ID token) over HTTPS in `us-east-1`. Alice received `200` for `guide` and `403` for `draft`. Bob received `403` for `guide`. After we added an explicit Cedar `forbid`, the same request from Alice returned `403` in all three modes. API Gateway returned `401` for a request without a token.

## Development and testing

Use Node.js 24 and npm for development.

```sh
npm ci
npm test
npm run check
```

Start AWS Emulator on port 9297. On Linux, run `aws-emulator` after installing the package. On macOS and Windows, follow the [AWS Emulator Docker guide](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html).

```sh
npm run test:emulator
```

The integration tests create a policy store and exercise `GET /documents/:id` through Hono. They also sign in against a local Cognito user pool and check both allowed and denied reads with each token type. The tests delete the store and user pool afterward.

The test runner connects to `https://127.0.0.1:<port>` using the credentials and CA certificate in `~/.aws/emulator/<port>/`. For a different port, use a command such as `AWS_EMULATOR_PORT=9300 npm run test:emulator`. GitHub Actions runs these tests with AWS Emulator 1.0.385.

## License

[Apache License 2.0](./LICENSE)
