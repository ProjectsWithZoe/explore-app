import { requireUser } from './_lib/auth';
import { sql } from './_lib/db';
import { error, handle, json, methodNotAllowed, readJson } from './_lib/http';

export default handle(async (request) => {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
  const user = await requireUser(request);
  if (user instanceof Response) return user;

  const body = await readJson(request);
  const unit = body?.unit === 'lb' ? 'lb' : 'kg';
  const weightKg = body?.weightKg == null ? null : Number(body.weightKg);
  if (weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 25 || weightKg > 300)) {
    return error(400, 'Weight must be between 25 and 300 kg.');
  }

  await sql`
    INSERT INTO profiles (user_id, weight_kg, unit) VALUES (${user.id}, ${weightKg}, ${unit})
    ON CONFLICT (user_id) DO UPDATE SET weight_kg = excluded.weight_kg, unit = excluded.unit, updated_at = now()
  `;
  return json({ weightKg, unit });
});
