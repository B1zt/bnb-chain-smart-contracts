import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, {type FastifyError, type FastifyInstance} from 'fastify';
import {config} from './config.js';
import {loggerOptions} from './lib/logger.js';
import {prisma} from './lib/prisma.js';
import {apiRoutes} from './routes.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    // Trust the proxy so rate limiting keys on the real client IP rather than the load balancer's.
    trustProxy: true,
  });

  await app.register(cors, {origin: config.CORS_ORIGINS, methods: ['GET']});
  await app.register(rateLimit, {max: 300, timeWindow: '1 minute'});

  app.get('/health', async () => {
    // A health check that does not touch the database is not a health check.
    await prisma.$queryRaw`SELECT 1`;
    return {status: 'ok', chainId: config.CHAIN_ID};
  });

  await app.register(apiRoutes, {prefix: '/api/v1'});

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({error}, 'request failed');

    const status = error.statusCode ?? 500;
    // Internal errors are logged in full but never echoed: stack traces leak schema details.
    return reply.status(status).send({error: status >= 500 ? 'Internal server error' : error.message});
  });

  return app;
}
