import { Hono } from 'hono'
import { createAuthorizer, type AuthorizationEngine } from 'hono-verified-permissions'

type AppEnv = { Variables: { userId: string | null } }

export function createDocumentApp(
  engine: AuthorizationEngine,
  authenticate: (request: Request) => Promise<string | null>,
) {
  const app = new Hono<AppEnv>()
  app.use(async (c, next) => {
    c.set('userId', await authenticate(c.req.raw))
    await next()
  })

  const authorize = createAuthorizer<AppEnv>({
    engine,
    principal: (c) => c.var.userId ? { type: 'Demo::User', id: c.var.userId } : null,
  })
  const path = '/documents/:id'
  app.get(
    path,
    authorize<typeof path>({
      action: { type: 'Demo::Action', id: 'view' },
      resource: (c) => ({ type: 'Demo::Document', id: c.req.param('id') }),
    }),
    (c) => c.json({ document: c.req.param('id'), reader: c.var.authorizerInfo.principalUid.id }),
  )
  return app
}
