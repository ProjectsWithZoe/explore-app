import type { NewRouteRecord, RouteRecord } from './types';

// Web storage backed by localStorage. expo-sqlite on web needs a WASM build plus
// cross-origin-isolation headers that would block the OpenStreetMap tiles.

const KEY = 'walkexplore.routes.v1';

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
