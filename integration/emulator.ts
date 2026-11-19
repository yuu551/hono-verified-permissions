import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DeleteUserPoolCommand,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import {
  CreatePolicyCommand,
  CreatePolicyStoreCommand,
  CreateIdentitySourceCommand,
  DeletePolicyStoreCommand,
  VerifiedPermissionsClient,
} from '@aws-sdk/client-verifiedpermissions'
import { AVPAuthorizationEngine } from '@verifiedpermissions/authorization-clients-js'
import { createDocumentApp } from '../examples/documents.ts'
import { createTokenDocumentApp } from '../examples/token-documents.ts'

const endpoint = process.env.AWS_ENDPOINT_URL
assert.match(endpoint ?? '', /^https:\/\/127\.0\.0\.1:\d+$/, 'Run npm run test:emulator')

async function createStore(t: TestContext) {
  const client = new VerifiedPermissionsClient({ endpoint })
  const { policyStoreId } = await client.send(new CreatePolicyStoreCommand({
    description: 'hono-verified-permissions integration test',
    validationSettings: { mode: 'OFF' },
  }))
  assert.ok(policyStoreId)
  t.after(async () => {
    try {
      await client.send(new DeletePolicyStoreCommand({ policyStoreId }))
    } finally {
      client.destroy()
    }
  })
  async function addPolicy(statement: string) {
    await client.send(new CreatePolicyCommand({ policyStoreId, definition: { static: { statement } } }))
  }
  return { policyStoreId, client, addPolicy }
}

test('Hono authorizes document reads through Amazon Verified Permissions on AWS Emulator', async (t) => {
  const { policyStoreId, addPolicy } = await createStore(t)
  const engine = new AVPAuthorizationEngine({ policyStoreId, callType: 'isAuthorized' })
  const sessions = new Map([['alice-session', 'alice'], ['bob-session', 'bob']])
  const app = createDocumentApp(engine, async (req) => sessions.get(req.headers.get('authorization') ?? '') ?? null)
  const read = (id: string, session: string) => app.request(`/documents/${id}`, {
    headers: { authorization: session },
  })

  await t.test('empty store denies Alice', async () => {
    assert.equal((await read('guide', 'alice-session')).status, 403)
  })
  await addPolicy('permit(principal == Demo::User::"alice", action == Demo::Action::"view", resource == Demo::Document::"guide");')
  await t.test('matching user and document reach the Hono handler', async () => {
    const response = await read('guide', 'alice-session')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { document: 'guide', reader: 'alice' })
  })
  await t.test('another user receives 403', async () => {
    assert.equal((await read('guide', 'bob-session')).status, 403)
  })
  await t.test('another document receives 403', async () => {
    assert.equal((await read('draft', 'alice-session')).status, 403)
  })
  await t.test('an anonymous request receives 401', async () => {
    assert.equal((await app.request('/documents/guide')).status, 401)
  })
  await addPolicy('forbid(principal, action, resource);')
  await t.test('a new forbid overrides the existing permit', async () => {
    assert.equal((await read('guide', 'alice-session')).status, 403)
  })
})

test('Hono authorizes bearer tokens issued by a local Cognito user pool', async (t) => {
  const { client, policyStoreId, addPolicy } = await createStore(t)
  const cognito = new CognitoIdentityProviderClient({ endpoint })
  const { UserPool } = await cognito.send(new CreateUserPoolCommand({ PoolName: `hono-${randomUUID()}` }))
  const UserPoolId = UserPool?.Id
  assert.ok(UserPoolId)
  t.after(async () => {
    try {
      await cognito.send(new DeleteUserPoolCommand({ UserPoolId }))
    } finally {
      cognito.destroy()
    }
  })
  const { UserPoolClient } = await cognito.send(new CreateUserPoolClientCommand({
    UserPoolId, ClientName: 'documents', ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
  }))
  const ClientId = UserPoolClient?.ClientId
  assert.ok(ClientId)
  await client.send(new CreateIdentitySourceCommand({
    policyStoreId,
    principalEntityType: 'Demo::User',
    configuration: { cognitoUserPoolConfiguration: { userPoolArn: UserPool.Arn, clientIds: [ClientId] } },
  }))
  const Username = 'alice'
  const Password = `Aa1!${randomUUID()}`
  const { User } = await cognito.send(new AdminCreateUserCommand({ UserPoolId, Username, MessageAction: 'SUPPRESS' }))
  const sub = User?.Attributes?.find((attr) => attr.Name === 'sub')?.Value
  assert.ok(sub)
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId, Username, Password, Permanent: true }))
  const { AuthenticationResult } = await cognito.send(new InitiateAuthCommand({
    ClientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: Username, PASSWORD: Password },
  }))
  const principalId = `${UserPoolId}|${sub}`
  await addPolicy(`permit(principal == Demo::User::"${principalId}", action == Demo::Action::"view", resource == Demo::Document::"guide");`)
  for (const [mode, token] of [
    ['accessToken', AuthenticationResult?.AccessToken],
    ['identityToken', AuthenticationResult?.IdToken],
  ] as const) {
    await t.test(`${mode} authorizes the signed-in user for the matching document only`, async () => {
      assert.ok(token)
      const app = createTokenDocumentApp(policyStoreId, mode)
      const headers = { authorization: `Bearer ${token}` }
      const response = await app.request('/documents/guide', { headers })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { document: 'guide', reader: principalId })
      assert.equal((await app.request('/documents/draft', { headers })).status, 403)
    })
  }
})
