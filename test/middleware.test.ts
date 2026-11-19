import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import {
  bearerTokenPrincipal,
  createAuthorizer,
  type AuthorizationEngine,
  type Entity,
} from 'hono-verified-permissions'

const action = { type: 'Demo::Action', id: 'view' }
const principal = { type: 'Demo::User', id: 'alice' }
const resource = { type: 'Demo::Document', id: 'guide' }
const authorizerInfo = { principalUid: principal, determiningPolicies: ['policy-1'] }

test('passes resolved request data and exposes the engine result to the handler', async () => {
  const entities: Entity[] = [{ uid: resource, attrs: { published: true }, parents: [] }]
  const context = { channel: 'web' }
  const engine: AuthorizationEngine = {
    async isAuthorized(request, suppliedEntities) {
      assert.deepEqual(request, { principal, action, resource, context })
      assert.deepEqual(suppliedEntities, entities)
      return { type: 'allow', authorizerInfo }
    },
  }
  const authorize = createAuthorizer({ engine, principal: async () => principal })
  const app = new Hono()
  const path = '/documents/:id'
  app.get(path, authorize<typeof path>({
    action,
    resource: async (c) => ({ ...resource, id: c.req.param('id') }),
    context: async () => context,
    entities: async () => entities,
  }), (c) => c.json(c.var.authorizerInfo))

  const res = await app.request('/documents/guide')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), authorizerInfo)
})

for (const [name, isAuthorized, status] of [
  ['deny', async () => ({ type: 'deny' }), 403],
  ['engine error', async () => ({ type: 'error', message: 'internal details' }), 503],
  ['engine exception', async () => { throw new Error('internal details') }, 503],
] satisfies [string, AuthorizationEngine['isAuthorized'], number][]) {
  test(`${name} stops the handler and returns ${status}`, async () => {
    let called = false
    const authorize = createAuthorizer({ engine: { isAuthorized }, principal: () => principal })
    const app = new Hono()
    app.get('/', authorize({ action, resource: () => resource }), (c) => {
      called = true
      return c.text('protected')
    })
    const res = await app.request('/')
    assert.equal(called, false)
    assert.equal(res.status, status)
    assert.deepEqual(await res.json(), { error: status === 403 ? 'Forbidden' : 'Authorization unavailable' })
  })
}

test('only forwards a well-formed bearer credential to the token engine', async () => {
  const received: string[] = []
  const engine: AuthorizationEngine = {
    async isAuthorized(request, entities) {
      assert.equal(request.principal.type, 'Token')
      assert.deepEqual(request.context, {})
      assert.deepEqual(entities, [])
      received.push(request.principal.id)
      return { type: 'allow', authorizerInfo }
    },
  }
  const authorize = createAuthorizer({ engine, principal: bearerTokenPrincipal })
  const app = new Hono()
  app.get('/', authorize({ action, resource: () => resource }), (c) => c.json(c.var.authorizerInfo.principalUid))
  for (const authorization of ['', 'Basic abc', 'Bearer', 'Bearer a b', 'Bearer a, Bearer b']) {
    const res = await app.request('/', { headers: { authorization } })
    assert.equal(res.status, 401)
  }
  assert.deepEqual(received, [])
  const res = await app.request('/', { headers: { authorization: 'bEaReR a.b.c' } })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), principal)
  assert.deepEqual(received, ['a.b.c'])
})

test('a failed application resolver follows Hono error handling', async () => {
  let calls = 0
  const engine: AuthorizationEngine = {
    async isAuthorized() {
      calls++
      return { type: 'allow', authorizerInfo }
    },
  }
  const authorize = createAuthorizer({ engine, principal: () => principal })
  const app = new Hono()
  app.onError((_, c) => c.text('Application error', 500))
  app.get('/', authorize({
    action,
    resource: () => { throw new Error('lookup failed') },
  }), (c) => c.text('protected'))
  const res = await app.request('/')
  assert.equal(res.status, 500)
  assert.equal(await res.text(), 'Application error')
  assert.equal(calls, 0)
})
