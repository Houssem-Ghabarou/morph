import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import { testConnection } from './lib/postgres';
import { runMigrations } from './lib/migrations';
import authRoutes from './routes/auth';
import chatRoutes from './routes/chat';
import schemaRoutes from './routes/schema';
import dataRoutes from './routes/data';
import sessionRoutes from './routes/sessions';
import importRoutes from './routes/import';
import connectionRoutes from './routes/connections';
import emailRoutes from './routes/email';
import automationRoutes from './routes/automations';
import noteRoutes from './routes/notes';
import { startScheduler } from './lib/automationScheduler';

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
    credentials: true,
  });

  await fastify.register(cookie);
  await fastify.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // Auth routes (public — no middleware)
  await fastify.register(authRoutes);

  // Protected routes
  await fastify.register(sessionRoutes);
  await fastify.register(chatRoutes);
  await fastify.register(schemaRoutes);
  await fastify.register(dataRoutes);
  await fastify.register(importRoutes);
  await fastify.register(connectionRoutes);
  await fastify.register(emailRoutes);
  await fastify.register(automationRoutes);
  await fastify.register(noteRoutes);

  fastify.get('/health', async () => ({ status: 'ok' }));

  const port = Number(process.env.PORT ?? 3001);
  await fastify.listen({ port, host: '0.0.0.0' });

  await testConnection();
  fastify.log.info('PostgreSQL connection OK');

  await runMigrations();
  fastify.log.info('Migrations OK');

  await startScheduler();
  fastify.log.info('Automation scheduler OK');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
