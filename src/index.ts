import type {
  AuthorizationEngine,
  AuthorizationRequest,
  AuthorizationResultInformation,
  Entity,
  EntityUid,
} from '@cedar-policy/cedar-authorization'
import type { Context, Env, MiddlewareHandler } from 'hono'

export type { AuthorizationEngine, Entity, EntityUid }

export type AuthorizationVariables = {
  authorizerInfo: AuthorizationResultInformation
}

type MaybePromise<T> = T | Promise<T>
type AuthorizedEnv<E extends Env> = E & { Variables: AuthorizationVariables }
type Resolver<E extends Env, P extends string, T> = (
  c: Pick<Context<E, P>, 'req' | 'env' | 'var'>,
) => MaybePromise<T>

export interface AuthorizerOptions<E extends Env> {
  engine: AuthorizationEngine
  principal: Resolver<NoInfer<E>, string, EntityUid | null | undefined>
}

export interface RouteAuthorization<E extends Env, P extends string> {
  action: EntityUid
  resource: Resolver<E, P, EntityUid>
  context?: Resolver<E, P, AuthorizationRequest['context']>
  entities?: Resolver<E, P, Entity[]>
}

/** Pass a bearer credential to an AVP accessToken or identityToken engine. */
export function bearerTokenPrincipal(c: Pick<Context, 'req'>): EntityUid | undefined {
  const match = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(c.req.header('Authorization') ?? '')
  if (match) return { type: 'Token', id: match[1] }
}

export function createAuthorizer<E extends Env = Env>({ engine, principal }: AuthorizerOptions<E>) {
  return function authorize<P extends string = string>(
    route: RouteAuthorization<E, P>,
  ): MiddlewareHandler<AuthorizedEnv<E>, P> {
    return async (c, next) => {
      const identity = await principal(c)
      if (!identity) return c.json({ error: 'Unauthorized' }, 401)

      const request: AuthorizationRequest = {
        principal: identity,
        action: route.action,
        resource: await route.resource(c),
        context: route.context ? await route.context(c) : {},
      }
      const entities = route.entities ? await route.entities(c) : []

      let result
      try {
        result = await engine.isAuthorized(request, entities)
      } catch {
        return c.json({ error: 'Authorization unavailable' }, 503)
      }
      if (result.type === 'deny') return c.json({ error: 'Forbidden' }, 403)
      if (result.type !== 'allow') return c.json({ error: 'Authorization unavailable' }, 503)

      c.set('authorizerInfo', result.authorizerInfo)
      await next()
    }
  }
}
