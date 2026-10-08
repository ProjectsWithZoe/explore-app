import * as SQLite from 'expo-sqlite';
import type { NewRouteRecord, Profile, RouteRecord, Session } from './types';

// Native storage backed by Expo SQLite.

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('walkexplore.db');
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS routes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          completedAt TEXT,
          saved INTEGER NOT NULL DEFAULT 0,
          distanceKm REAL NOT NULL DEFAULT 0,
          durationMin REAL NOT NULL DEFAULT 0,
          estimatedSteps INTEGER NOT NULL DEFAULT 0,
          pointsJson TEXT NOT NULL,
          geometryJson TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
      `);
      try {
        await db.execAsync('ALTER TABLE routes ADD COLUMN estimatedSteps INTEGER NOT NULL DEFAULT 0;');
      } catch {
        // Column already exists on an existing installation.
      }
      return db;
    })();
  }
  return dbPromise;
}

export async function listRoutes(): Promise<RouteRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>('SELECT * FROM routes ORDER BY COALESCE(completedAt, createdAt) DESC');
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    saved: row.saved,
    distanceKm: row.distanceKm,
    durationMin: row.durationMin,
    estimatedSteps: row.estimatedSteps,
    points: JSON.parse(row.pointsJson),
    geometry: JSON.parse(row.geometryJson),
  }));
}

export async function insertRoute(r: NewRouteRecord) {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO routes (name, createdAt, completedAt, saved, distanceKm, durationMin, estimatedSteps, pointsJson, geometryJson)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.name,
    r.createdAt,
    r.completedAt ?? null,
    r.saved,
    r.distanceKm,
    r.durationMin,
    r.estimatedSteps,
    JSON.stringify(r.points),
    JSON.stringify(r.geometry),
  );
}

export async function deleteRoute(id: number) {
  const db = await getDb();
  await db.runAsync('DELETE FROM routes WHERE id = ?', id);
}

/** Removes every route stored on this device (after they've been moved into an account). */
export async function clearRoutes() {
  const db = await getDb();
  await db.runAsync('DELETE FROM routes');
}

async function getSetting<T>(key: string): Promise<T | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return row ? (JSON.parse(row.value) as T) : null;
}

async function setSetting(key: string, value: unknown) {
  const db = await getDb();
  if (value === null) {
    await db.runAsync('DELETE FROM settings WHERE key = ?', key);
    return;
  }
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

export const loadProfile = () => getSetting<Profile>('profile');
export const saveProfile = (profile: Profile) => setSetting('profile', profile);
export const loadSession = () => getSetting<Session>('session');
export const saveSession = (session: Session | null) => setSetting('session', session);
