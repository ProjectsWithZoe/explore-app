import { requireUser } from './_lib/auth';
import { sql } from './_lib/db';
import { error, handle, json, methodNotAllowed, readJson } from './_lib/http';
import { MAX_WALKS_PER_REQUEST, insertWalks, parseWalk, toRecord } from './_lib/walks';

// GET: list the user's walks. POST { walks: [...] }: add one or more (also used to import
// walks saved on the device before signing in). DELETE ?id=: remove one.
export default handle(async (request) => {
  const user = await requireUser(request);
  if (user instanceof Response) return user;

  if (request.method === 'GET') {
    const rows = await sql`
      SELECT * FROM walks WHERE user_id = ${user.id}
      ORDER BY COALESCE(completed_at, created_at) DESC
    `;
    return json({ walks: rows.map(toRecord) });
  }

  if (request.method === 'POST') {
    const body = await readJson(request);
    if (!body || !Array.isArray(body.walks)) return error(400, 'Expected { walks: [...] }.');
    if (body.walks.length > MAX_WALKS_PER_REQUEST) return error(413, `Send at most ${MAX_WALKS_PER_REQUEST} walks at a time.`);
    const walks = body.walks.map(parseWalk);
    if (walks.some((w: unknown) => w === null)) return error(400, 'One or more walks are invalid.');
    return json({ walks: await insertWalks(user.id, walks) }, 201);
  }

  if (request.method === 'DELETE') {
    const id = Number(new URL(request.url).searchParams.get('id'));
    if (!Number.isInteger(id) || id <= 0) return error(400, 'Missing walk id.');
    await sql`DELETE FROM walks WHERE id = ${id} AND user_id = ${user.id}`;
    return new Response(null, { status: 204 });
  }

  return methodNotAllowed(['GET', 'POST', 'DELETE']);
});
