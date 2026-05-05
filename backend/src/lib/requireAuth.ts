import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, JwtPayload } from './jwt';

const COOKIE_NAME = 'morph_token';

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<JwtPayload | null> {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    reply.status(401).send({ error: 'Not authenticated' });
    return null;
  }
  try {
    return verifyToken(token);
  } catch {
    reply.status(401).send({ error: 'Invalid or expired session' });
    return null;
  }
}
