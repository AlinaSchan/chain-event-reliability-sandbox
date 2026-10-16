import swagger from '@fastify/swagger';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { isLoopback } from '../app/config.js';
import type { ApiContext } from './context.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerEventRoutes } from './routes/events.js';
import { registerScenarioRoutes } from './routes/scenarios.js';
import { registerSystemRoutes } from './routes/system.js';

export const API_VERSION = '0.1.0';

/**
 * The local HTTP API. Read-only by default and unauthenticated, so it listens on loopback unless told
 * otherwise (and says so in the log when it is). Admin and fault-injection routes exist only when
 * explicitly enabled, require a bearer token, and are refused outright on a non-loopback address.
 */
export async function buildServer(ctx: ApiContext): Promise<FastifyInstance> {
  if (ctx.admin.enabled) {
    if (!isLoopback(ctx.host)) throw new Error(`admin routes are loopback-only; refusing to enable them on ${ctx.host}`);
    if (!ctx.admin.token || ctx.admin.token.length < 16) throw new Error('admin routes need an ADMIN_TOKEN of at least 16 characters');
    if (!ctx.admin.controls) throw new Error('admin routes control the in-process fixture chain, which this runtime does not have');
  }

  const loggerInstance: FastifyBaseLogger = ctx.logger;
  const app = Fastify({
    loggerInstance,
    bodyLimit: 16 * 1024,
    // Event ids (chain:blockHash:txHash:logIndex) are ~145 characters; the default limit of 100 would make /events/:id unreachable.
    routerOptions: { maxParamLength: 256 },
    // Unknown query parameters and body fields are errors, not silently dropped.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', allErrors: false } },
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Chain Event Reliability Sandbox API',
        version: API_VERSION,
        description:
          'Local, read-mostly API over the sandbox\'s durable state. All data is synthetic. ' +
          'Admin and fault-injection routes (tag "admin") exist only when ADMIN_ENABLED=true and are refused on non-loopback addresses.',
      },
      tags: [
        { name: 'system', description: 'Health, status and metrics' },
        { name: 'events', description: 'Events and alerts' },
        { name: 'scenarios', description: 'Failure scenarios S01-S09 and their last recorded runs' },
        { name: 'admin', description: 'Fixture control and operator actions (disabled by default)' },
      ],
      components: { securitySchemes: { adminBearer: { type: 'http', scheme: 'bearer' } } },
    },
  });

  registerSystemRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerScenarioRoutes(app, ctx);
  if (ctx.admin.enabled) registerAdminRoutes(app, ctx);

  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  await app.ready();
  if (!isLoopback(ctx.host)) {
    ctx.logger.warn(
      { event: 'api.exposed', host: ctx.host },
      'the read-only API has no authentication and is listening beyond loopback',
    );
  }
  return app;
}
