import { requireUser } from './_lib/auth';
import { sql } from './_lib/db';
import { handle, methodNotAllowed } from './_lib/http';

export default handle(async (request) => {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  const user = await requireUser(request);
  if (user instanceof Response) return new Response(null, { status: 204 });
  await sql`DELETE FROM sessions WHERE token_hash = ${user.tokenHash}`;
  return new Response(null, { status: 204 });
});
