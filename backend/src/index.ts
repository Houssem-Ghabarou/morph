import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { testConnection } from './lib/postgres';
import chatRoutes from './routes/chat';
import schemaRoutes from './routes/schema';
import dataRoutes from './routes/data';

const fastify = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  },
});

async function bootstrap() {
  // CORS — allow Next.js dev server
  await fastify.register(cors, {
    origin: ['http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  // Routes
  await fastify.register(chatRoutes);
  await fastify.register(schemaRoutes);
  await fastify.register(dataRoutes);

  // Health check
  fastify.get('/health', async () => ({ status: 'ok' }));

  // Start
  const port = Number(process.env.PORT ?? 3001);
  await fastify.listen({ port, host: '0.0.0.0' });

  // Verify DB
  await testConnection();
  fastify.log.info('PostgreSQL connection OK');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
