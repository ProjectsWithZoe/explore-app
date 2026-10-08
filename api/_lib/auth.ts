import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from './db';
import { error } from './http';

const scrypt = promisify(scryptCb) as (pw: Buffer, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

// ~100 ms and 32 MB per hash: slow enough to make offline guessing of a 6-digit PIN expensive.
const SCRYPT_OPTS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 180;

export const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export function normaliseUsername(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Rejects PINs that are trivially guessable: all one digit, or a straight run like 123456 / 987654. */
export function pinProblem(pin: unknown): string | null {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) return 'PIN must be exactly 6 digits.';
  if (/^(\d)\1{5}$/.test(pin)) return 'Choose a PIN that isn’t the same digit repeated.';
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'Choose a PIN that isn’t a simple sequence.';
  return null;
}

function pepper() {
  const value = process.env.AUTH_PEPPER;
  if (!value) throw new Error('AUTH_PEPPER is not set.');
  return value;
}

async function derive(pin: string, salt: Buffer) {
  // Mix in a server-side secret so a leaked database alone isn't enough to brute-force PINs.
  const peppered = createHmac('sha256', pepper()).update(pin).digest();
  return scrypt(peppered, salt, 32, SCRYPT_OPTS);
}

export async function hashPin(pin: string) {
  const salt = randomBytes(16);
  const hash = await derive(pin, salt);
  return { hash: hash.toString('base64'), salt: salt.toString('base64') };
}

export async function verifyPin(pin: string, hash: string, salt: string) {
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(pin, Buffer.from(salt, 'base64'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Burns the same time as a real check so response timing doesn't reveal whether a username exists. */
export async function dummyVerify() {
  await derive('000000', randomBytes(16));
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: number) {
  const token = randomBytes(32).toString('base64url');
  await sql`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${tokenHash(token)}, ${userId}, now() + make_interval(days => ${SESSION_DAYS}))
  `;
  // Opportunistic cleanup of expired sessions for this user.
  await sql`DELETE FROM sessions WHERE user_id = ${userId} AND expires_at < now()`;
  return token;
}

function bearer(request: Request) {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export type AuthedUser = { id: number; username: string; tokenHash: string };

/** Returns the signed-in user, or a 401 Response to send back. */
export async function requireUser(request: Request): Promise<AuthedUser | Response> {
  const token = bearer(request);
  if (!token) return error(401, 'Please sign in.');
  const hash = tokenHash(token);
  const rows = await sql`
    SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hash} AND s.expires_at > now()
  `;
  if (!rows.length) return error(401, 'Your session has expired. Please sign in again.');
  return { id: Number(rows[0].id), username: rows[0].username, tokenHash: hash };
}

/** Counts recent events of a kind from an IP; returns true when the limit has been reached. */
export async function rateLimited(kind: string, ip: string, limit: number, windowMinutes: number) {
  const rows = await sql`
    SELECT count(*)::int AS n FROM rate_events
    WHERE kind = ${kind} AND ip = ${ip} AND at > now() - make_interval(mins => ${windowMinutes})
  `;
  return rows[0].n >= limit;
}

export async function recordRateEvent(kind: string, ip: string) {
  await sql`INSERT INTO rate_events (kind, ip) VALUES (${kind}, ${ip})`;
  // Keep the table small.
  await sql`DELETE FROM rate_events WHERE at < now() - interval '1 day'`;
}
