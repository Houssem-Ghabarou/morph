import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { testConnection } from './lib/postgres';
import { runMigrations } from './lib/migrations';
import chatRoutes from './routes/chat';
import schemaRoutes from './routes/schema';
import dataRoutes from './routes/data';
import sessionRoutes from './routes/sessions';

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

  // Routes
  await fastify.register(sessionRoutes);
  await fastify.register(chatRoutes);
  await fastify.register(schemaRoutes);
  await fastify.register(dataRoutes);

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
