import { USERNAME_RE, createSession, hashPin, normaliseUsername, pinProblem, rateLimited, recordRateEvent } from './_lib/auth';
import { sql } from './_lib/db';
import { clientIp, error, handle, json, methodNotAllowed, readJson } from './_lib/http';

export default handle(async (request) => {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  const ip = clientIp(request);
  if (await rateLimited('signup', ip, 10, 60)) {
    return error(429, 'Too many accounts created from this network. Try again in an hour.');
  }

  const body = await readJson(request);
  const username = normaliseUsername(body?.username);
  if (!USERNAME_RE.test(username)) {
    return error(400, 'Usernames are 3–30 characters: lowercase letters, numbers and dashes.');
  }
  const problem = pinProblem(body?.pin);
  if (problem) return error(400, problem);

  const { hash, salt } = await hashPin(body.pin);
  const rows = await sql`
    INSERT INTO users (username, pin_hash, pin_salt) VALUES (${username}, ${hash}, ${salt})
    ON CONFLICT (username) DO NOTHING
    RETURNING id
  `;
  if (!rows.length) return error(409, 'That username is taken. Try another one.');

  await recordRateEvent('signup', ip);
  const token = await createSession(Number(rows[0].id));
  return json({ token, username }, 201);
});
