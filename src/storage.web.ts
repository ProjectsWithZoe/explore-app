import type { NewRouteRecord, Profile, RouteRecord } from './types';

// Web storage backed by localStorage. expo-sqlite on web needs a WASM build plus
// cross-origin-isolation headers that would block the OpenStreetMap tiles.

const KEY = 'walkexplore.routes.v1';
const PROFILE_KEY = 'walkexplore.profile.v1';

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

export async function loadProfile(): Promise<Profile | null> {
  try {
    const raw = window.localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as Profile) : null;
  } catch {
    return null;
  }
}

export async function saveProfile(profile: Profile) {
  try {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // Storage unavailable; the choice lasts for this session only.
  }
}
