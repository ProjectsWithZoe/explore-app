import type { NewRouteRecord, Profile, RouteRecord, Session } from './types';

// Web storage backed by localStorage. expo-sqlite on web needs a WASM build plus
// cross-origin-isolation headers that would block the OpenStreetMap tiles.

const KEY = 'walkexplore.routes.v1';
const PROFILE_KEY = 'walkexplore.profile.v1';
const SESSION_KEY = 'walkexplore.session.v1';

function read(): RouteRecord[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RouteRecord[]) : [];
  } catch {
    return [];
  }
}

function write(records: RouteRecord[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(records));
  } catch {
    // Storage unavailable (private mode / quota); keep going without persistence.
  }
}

export async function listRoutes(): Promise<RouteRecord[]> {
  return read().sort((a, b) =>
    (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt),
  );
}

export async function insertRoute(r: NewRouteRecord) {
  const records = read();
  const id = records.reduce((max, x) => Math.max(max, x.id), 0) + 1;
  write([...records, { ...r, id }]);
}

export async function deleteRoute(id: number) {
  write(read().filter((r) => r.id !== id));
}

/** Removes every route stored on this device (after they've been moved into an account). */
export async function clearRoutes() {
  write([]);
}

function getItem<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function setItem(key: string, value: unknown) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode / quota); the value lasts for this session only.
  }
}

export async function loadProfile() {
  return getItem<Profile>(PROFILE_KEY);
}

export async function saveProfile(profile: Profile) {
  setItem(PROFILE_KEY, profile);
}

export async function loadSession() {
  return getItem<Session>(SESSION_KEY);
}

export async function saveSession(session: Session | null) {
  setItem(SESSION_KEY, session);
}
