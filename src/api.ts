import { Platform } from 'react-native';
import type { NewRouteRecord, Profile, RouteRecord, Session } from './types';

// The web app calls its own origin; native builds need the deployed site's address.
const API_BASE = Platform.OS === 'web' ? '' : (process.env.EXPO_PUBLIC_API_URL ?? 'https://explore-app-three.vercel.app');

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError('Can’t reach the server. Check your connection and try again.', 0);
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error ?? `Request failed (${response.status}).`, response.status);
  return data as T;
}

export const api = {
  signup: (username: string, pin: string) => request<Session>('signup', { method: 'POST', body: { username, pin } }),
  login: (username: string, pin: string) => request<Session>('login', { method: 'POST', body: { username, pin } }),
  logout: (token: string) => request<void>('logout', { method: 'POST', token }),
  me: (token: string) => request<{ username: string; profile: Profile | null }>('me', { token }),
  deleteAccount: (token: string) => request<void>('me', { method: 'DELETE', token }),
  saveProfile: (token: string, profile: Profile) => request<Profile>('profile', { method: 'PUT', body: profile, token }),
  listWalks: async (token: string) => (await request<{ walks: RouteRecord[] }>('walks', { token })).walks,
  addWalks: async (token: string, walks: NewRouteRecord[]) =>
    (await request<{ walks: RouteRecord[] }>('walks', { method: 'POST', body: { walks }, token })).walks,
  deleteWalk: (token: string, id: number) => request<void>(`walks?id=${id}`, { method: 'DELETE', token }),
};

const ADJECTIVES = ['brisk', 'sunny', 'quiet', 'misty', 'bold', 'lucky', 'swift', 'calm', 'wild', 'merry', 'steady', 'bright', 'gentle', 'nimble', 'rambling', 'breezy'];
const NOUNS = ['otter', 'heron', 'fox', 'badger', 'wren', 'hare', 'robin', 'stag', 'owl', 'lark', 'finch', 'beaver', 'kestrel', 'marten', 'puffin', 'vole'];

export function randomUsername() {
  const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${Math.floor(1000 + Math.random() * 9000)}`;
}

/** Same rules as the server, so people get instant feedback. */
export function pinProblem(pin: string): string | null {
  if (!/^\d{6}$/.test(pin)) return 'PIN must be exactly 6 digits.';
  if (/^(\d)\1{5}$/.test(pin)) return 'Choose a PIN that isn’t the same digit repeated.';
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'Choose a PIN that isn’t a simple sequence.';
  return null;
}
