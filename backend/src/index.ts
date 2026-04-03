import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { testConnection } from './lib/postgres';
import { runMigrations } from './lib/migrations';
import chatRoutes from './routes/chat';
import schemaRoutes from './routes/schema';
import dataRoutes from './routes/data';
import sessionRoutes from './routes/sessions';
import importRoutes from './routes/import';

const fastify = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  },
});

async function bootstrap() {
  await fastify.register(cors, {
    origin: ['http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  await fastify.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB max

  // Routes
  await fastify.register(sessionRoutes);
  await fastify.register(chatRoutes);
  await fastify.register(schemaRoutes);
  await fastify.register(dataRoutes);
  await fastify.register(importRoutes);

  fastify.get('/health', async () => ({ status: 'ok' }));

  const port = Number(process.env.PORT ?? 3001);
  await fastify.listen({ port, host: '0.0.0.0' });

  await testConnection();
  fastify.log.info('PostgreSQL connection OK');

  await runMigrations();
  fastify.log.info('Migrations OK');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
