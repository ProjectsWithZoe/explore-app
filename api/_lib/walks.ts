import { sql } from './db';

const MAX_POINTS = 50;
const MAX_GEOMETRY = 20000;
export const MAX_WALKS_PER_REQUEST = 500;

type Coord = { latitude: number; longitude: number };

export type WalkInput = {
  name: string;
  createdAt: string;
  completedAt: string | null;
  saved: boolean;
  distanceKm: number;
  durationMin: number;
  estimatedSteps: number;
  points: (Coord & { id: string; label: string })[];
  geometry: Coord[];
};

const finiteNonNeg = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isDate = (v: unknown) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const isCoord = (c: any) =>
  c && typeof c.latitude === 'number' && typeof c.longitude === 'number' &&
  Math.abs(c.latitude) <= 90 && Math.abs(c.longitude) <= 180;

/** Validates and normalises a walk sent by the client; returns null if it's malformed. */
export function parseWalk(raw: any): WalkInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 100) : '';
  if (!name || !isDate(raw.createdAt)) return null;
  if (raw.completedAt != null && !isDate(raw.completedAt)) return null;
  if (![raw.distanceKm, raw.durationMin, raw.estimatedSteps].every(finiteNonNeg)) return null;
  if (!Array.isArray(raw.points) || raw.points.length > MAX_POINTS || !raw.points.every(isCoord)) return null;
  if (!Array.isArray(raw.geometry) || raw.geometry.length > MAX_GEOMETRY || !raw.geometry.every(isCoord)) return null;
  return {
    name,
    createdAt: raw.createdAt,
    completedAt: raw.completedAt ?? null,
    saved: raw.saved === true || raw.saved === 1,
    distanceKm: raw.distanceKm,
    durationMin: raw.durationMin,
    estimatedSteps: Math.round(raw.estimatedSteps),
    points: raw.points.map((p: any, i: number) => ({
      id: typeof p.id === 'string' ? p.id.slice(0, 40) : String(i),
      label: typeof p.label === 'string' ? p.label.slice(0, 40) : `Stop ${i + 1}`,
      latitude: p.latitude,
      longitude: p.longitude,
    })),
    geometry: raw.geometry.map((c: Coord) => ({ latitude: c.latitude, longitude: c.longitude })),
  };
}

/** Shape the app uses for a route record. */
export function toRecord(row: any) {
  return {
    id: Number(row.id),
    name: row.name,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    saved: row.saved ? 1 : 0,
    distanceKm: Number(row.distance_km),
    durationMin: Number(row.duration_min),
    estimatedSteps: Number(row.estimated_steps),
    points: row.points,
    geometry: row.geometry,
  };
}

export async function insertWalks(userId: number, walks: WalkInput[]) {
  if (!walks.length) return [];
  const rows = await sql`
    INSERT INTO walks (user_id, name, created_at, completed_at, saved, distance_km, duration_min, estimated_steps, points, geometry)
    SELECT ${userId}, x.name, x."createdAt", x."completedAt", x.saved, x."distanceKm", x."durationMin", x."estimatedSteps", x.points, x.geometry
    FROM jsonb_to_recordset(${JSON.stringify(walks)}::jsonb) AS x(
      name text, "createdAt" timestamptz, "completedAt" timestamptz, saved boolean,
      "distanceKm" real, "durationMin" real, "estimatedSteps" int, points jsonb, geometry jsonb
    )
    RETURNING *
  `;
  return rows.map(toRecord);
}
