import { requireUser } from './_lib/auth';
import { sql } from './_lib/db';
import { handle, json, methodNotAllowed } from './_lib/http';

// GET: the signed-in user and their profile. DELETE: delete the account and all its data.
export default handle(async (request) => {
  const user = await requireUser(request);
  if (user instanceof Response) return user;

  if (request.method === 'GET') {
    const rows = await sql`SELECT weight_kg, unit FROM profiles WHERE user_id = ${user.id}`;
    const profile = rows.length ? { weightKg: rows[0].weight_kg == null ? null : Number(rows[0].weight_kg), unit: rows[0].unit } : null;
    return json({ username: user.username, profile });
  }
  if (request.method === 'DELETE') {
    await sql`DELETE FROM users WHERE id = ${user.id}`;
    return new Response(null, { status: 204 });
  }
  return methodNotAllowed(['GET', 'DELETE']);
});
