import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { query } from '../lib/postgres';
import { signToken, verifyToken } from '../lib/jwt';

const COOKIE_NAME = 'morph_token';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
};

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: { email: string; password: string } }>(
    '/api/auth/register',
    async (req: FastifyRequest<{ Body: { email: string; password: string } }>, reply: FastifyReply) => {
      const { email, password } = req.body ?? {};

      if (!email?.trim() || !password) {
        return reply.status(400).send({ error: 'Email and password are required' });
      }
      if (password.length < 6) {
        return reply.status(400).send({ error: 'Password must be at least 6 characters' });
      }

      const existing = await query(`SELECT id FROM morph_users WHERE email = $1`, [email.toLowerCase().trim()]);
      if (existing.rows.length > 0) {
        return reply.status(409).send({ error: 'An account with this email already exists' });
      }

      const hash = await bcrypt.hash(password, 12);
      const result = await query(
        `INSERT INTO morph_users (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
        [email.toLowerCase().trim(), hash]
      );

      const user = result.rows[0];
      const token = signToken({ userId: user.id, email: user.email });
      reply.setCookie(COOKIE_NAME, token, COOKIE_OPTS);
      return reply.status(201).send({ user: { id: user.id, email: user.email } });
    }
  );

  fastify.post<{ Body: { email: string; password: string } }>(
    '/api/auth/login',
    async (req: FastifyRequest<{ Body: { email: string; password: string } }>, reply: FastifyReply) => {
      const { email, password } = req.body ?? {};

      if (!email?.trim() || !password) {
        return reply.status(400).send({ error: 'Email and password are required' });
      }

      const result = await query(
        `SELECT id, email, password_hash FROM morph_users WHERE email = $1`,
        [email.toLowerCase().trim()]
      );

      if (result.rows.length === 0) {
        return reply.status(401).send({ error: 'Invalid email or password' });
      }

      const user = result.rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return reply.status(401).send({ error: 'Invalid email or password' });
      }

      const token = signToken({ userId: user.id, email: user.email });
      reply.setCookie(COOKIE_NAME, token, COOKIE_OPTS);
      return reply.send({ user: { id: user.id, email: user.email } });
    }
  );

  fastify.post('/api/auth/logout', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.send({ ok: true });
  });

  fastify.get('/api/auth/me', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return reply.status(401).send({ error: 'Not authenticated' });

    try {
      const payload = verifyToken(token);
      const result = await query(`SELECT id, email FROM morph_users WHERE id = $1`, [payload.userId]);
      if (result.rows.length === 0) return reply.status(401).send({ error: 'User not found' });
      return reply.send({ user: result.rows[0] });
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired session' });
    }
  });
}
