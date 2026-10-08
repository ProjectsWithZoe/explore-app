import { dummyVerify, createSession, normaliseUsername, rateLimited, recordRateEvent, verifyPin } from './_lib/auth';
import { sql } from './_lib/db';
import { clientIp, error, handle, json, methodNotAllowed, readJson } from './_lib/http';

const ATTEMPTS_BEFORE_LOCK = 5;
const WRONG = 'Username or PIN is incorrect.';

function lockedMessage(until: string | Date) {
  const minutes = Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60000));
  const wait = minutes >= 60 ? `${Math.ceil(minutes / 60)} hour${minutes >= 120 ? 's' : ''}` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `Too many wrong PINs. This account is locked for ${wait}.`;
}

export default handle(async (request) => {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  const ip = clientIp(request);
  // Stops one network from cycling through many usernames.
  if (await rateLimited('login_fail', ip, 20, 15)) {
    return error(429, 'Too many failed sign-ins from this network. Try again in 15 minutes.');
  }

  const body = await readJson(request);
  const username = normaliseUsername(body?.username);
  const pin = typeof body?.pin === 'string' ? body.pin : '';

  const users = await sql`SELECT id, pin_hash, pin_salt, locked_until FROM users WHERE username = ${username}`;
  if (!users.length || !/^\d{6}$/.test(pin)) {
    await dummyVerify();
    await recordRateEvent('login_fail', ip);
    return error(401, WRONG);
  }
  const user = users[0];

  // Count the attempt *before* checking the PIN, atomically, so parallel requests can't
  // squeeze in extra guesses. Every 5th failure locks the account: 15 min, then 30, 60… up to 24 h.
  const attempt = await sql`
    UPDATE users SET
      failed_attempts = failed_attempts + 1,
      locked_until = CASE
        WHEN (failed_attempts + 1) % ${ATTEMPTS_BEFORE_LOCK} = 0
          THEN now() + make_interval(mins => LEAST(15 * power(2, (failed_attempts + 1) / ${ATTEMPTS_BEFORE_LOCK} - 1), 1440)::int)
        ELSE locked_until
      END
    WHERE id = ${user.id} AND (locked_until IS NULL OR locked_until <= now())
    RETURNING failed_attempts
  `;
  if (!attempt.length) return error(423, lockedMessage(user.locked_until));

  if (!(await verifyPin(pin, user.pin_hash, user.pin_salt))) {
    await recordRateEvent('login_fail', ip);
    const failures = Number(attempt[0].failed_attempts);
    const left = ATTEMPTS_BEFORE_LOCK - (failures % ATTEMPTS_BEFORE_LOCK);
    if (left === ATTEMPTS_BEFORE_LOCK) {
      const locked = await sql`SELECT locked_until FROM users WHERE id = ${user.id}`;
      return error(423, lockedMessage(locked[0].locked_until));
    }
    return error(401, `${WRONG} ${left} attempt${left === 1 ? '' : 's'} left before a temporary lock.`);
  }

  await sql`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ${user.id}`;
  const token = await createSession(Number(user.id));
  return json({ token, username });
});
