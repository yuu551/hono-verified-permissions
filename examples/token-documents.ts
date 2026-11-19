import { AVPAuthorizationEngine } from '@verifiedpermissions/authorization-clients-js'
import { Hono } from 'hono'
import { bearerTokenPrincipal, createAuthorizer } from 'hono-verified-permissions'

export function createTokenDocumentApp(policyStoreId: string, callType: 'accessToken' | 'identityToken') {
  const app = new Hono()
  const authorize = createAuthorizer({
    engine: new AVPAuthorizationEngine({ policyStoreId, callType }),
    principal: bearerTokenPrincipal,
  })
  const path = '/documents/:id'
  app.get(path, authorize<typeof path>({
    action: { type: 'Demo::Action', id: 'view' },
    resource: (c) => ({ type: 'Demo::Document', id: c.req.param('id') }),
  }), (c) => c.json({ document: c.req.param('id'), reader: c.var.authorizerInfo.principalUid.id }))
  return app
}
