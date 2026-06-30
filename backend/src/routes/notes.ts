import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../lib/postgres';
import { requireAuth } from '../lib/requireAuth';

interface NoteBody {
  content?: string;
  color?: string;
  pos_x?: number;
  pos_y?: number;
}

async function ownsSession(sessionId: number, userId: number): Promise<boolean> {
  const res = await query(`SELECT id FROM morph_sessions WHERE id = $1 AND user_id = $2`, [sessionId, userId]);
  return res.rows.length > 0;
}

/** A note is owned by the user iff its session is. */
async function ownedNoteSession(noteId: number, userId: number): Promise<number | null> {
  const res = await query(
    `SELECT n.session_id FROM morph_session_notes n
     JOIN morph_sessions s ON s.id = n.session_id
     WHERE n.id = $1 AND s.user_id = $2`,
    [noteId, userId]
  );
  return res.rows.length > 0 ? res.rows[0].session_id : null;
}

export default async function noteRoutes(fastify: FastifyInstance) {
  // GET /api/sessions/:sessionId/notes
  fastify.get<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/notes',
    async (req: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;
      const sessionId = Number(req.params.sessionId);
      if (!(await ownsSession(sessionId, user.userId))) return reply.status(403).send({ error: 'Forbidden' });

      const res = await query(
        `SELECT id, session_id, content, color, pos_x, pos_y FROM morph_session_notes
         WHERE session_id = $1 ORDER BY created_at ASC`,
        [sessionId]
      );
      return reply.send({ notes: res.rows });
    }
  );

  // POST /api/sessions/:sessionId/notes
  fastify.post<{ Params: { sessionId: string }; Body: NoteBody }>(
    '/api/sessions/:sessionId/notes',
    async (req: FastifyRequest<{ Params: { sessionId: string }; Body: NoteBody }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;
      const sessionId = Number(req.params.sessionId);
      if (!(await ownsSession(sessionId, user.userId))) return reply.status(403).send({ error: 'Forbidden' });

      const b = req.body ?? {};
      const res = await query(
        `INSERT INTO morph_session_notes (session_id, content, color, pos_x, pos_y)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, session_id, content, color, pos_x, pos_y`,
        [sessionId, b.content ?? '', b.color ?? 'yellow', b.pos_x ?? 120, b.pos_y ?? 120]
      );
      return reply.status(201).send({ note: res.rows[0] });
    }
  );

  // PATCH /api/notes/:id
  fastify.patch<{ Params: { id: string }; Body: NoteBody }>(
    '/api/notes/:id',
    async (req: FastifyRequest<{ Params: { id: string }; Body: NoteBody }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;
      const id = Number(req.params.id);
      if ((await ownedNoteSession(id, user.userId)) === null) return reply.status(404).send({ error: 'Note not found' });

      const b = req.body ?? {};
      const res = await query(
        `UPDATE morph_session_notes SET
           content = COALESCE($2, content),
           color   = COALESCE($3, color),
           pos_x   = COALESCE($4, pos_x),
           pos_y   = COALESCE($5, pos_y),
           updated_at = NOW()
         WHERE id = $1
         RETURNING id, session_id, content, color, pos_x, pos_y`,
        [id, b.content ?? null, b.color ?? null, b.pos_x ?? null, b.pos_y ?? null]
      );
      return reply.send({ note: res.rows[0] });
    }
  );

  // DELETE /api/notes/:id
  fastify.delete<{ Params: { id: string } }>(
    '/api/notes/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;
      const id = Number(req.params.id);
      if ((await ownedNoteSession(id, user.userId)) === null) return reply.status(404).send({ error: 'Note not found' });
      await query(`DELETE FROM morph_session_notes WHERE id = $1`, [id]);
      return reply.send({ ok: true });
    }
  );
}
