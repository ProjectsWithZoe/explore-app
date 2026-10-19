# WalkExplore

An iPhone-first Expo walking route planner.

## Run locally with Expo Go

This project is aligned to Expo SDK 57 / React Native 0.86.2.

```bash
rm -rf node_modules package-lock.json
npm install
npx expo start -c
```

Scan the QR code with the matching Expo Go build.

### Map setup

The iOS map uses the native Apple Maps implementation through `react-native-maps`. No Google Maps API key is required for testing in Expo Go.

If Expo reports a version mismatch, run:

```bash
npx expo install --fix
npx expo start -c
```

## Run on the web

```bash
npm run web          # dev server
npm run build:web    # static build in dist/
```

On the web the map uses MapLibre GL (`src/WalkMap.web.tsx`) with the Mapbox Outdoors style when
`EXPO_PUBLIC_MAPBOX_TOKEN` is set in `.env` (use a public `pk.` token restricted to your domain), falling back to
the free OpenFreeMap style without one. Routes are stored in localStorage (`src/storage.web.ts`). iOS/Android keep `react-native-maps` and Expo SQLite. The layout is a bottom
sheet on phones and a side panel on screens 768px and wider. `vercel.json` is set up to deploy `dist/` as a
single-page app. Browser location needs HTTPS (or localhost).

### Install as an app (PWA)

The web build is installable: `public/manifest.webmanifest` and `public/icons/` provide the app name and icons,
`public/sw.js` caches the app so it opens offline, and `public/index.html` adds the iOS home-screen tags. On iPhone,
open the site in Safari → Share → Add to Home Screen; on Android, Chrome offers Install app. Map tiles and walking
routes still need a connection. When changing `public/sw.js`, bump its `CACHE` name so installed copies refresh.

## Features

- Live foreground location
- Tap the map to add Start / Stop points
- Walking route geometry and distance via Valhalla/OpenStreetMap
- Route estimate fallback when the routing service is unavailable
- Circular walks: pick a start and a distance (0–50 km) and get a loop back to the start, with Shuffle for another
- Save routes for later
- Log completed walks with date/time
- Local route history using Expo SQLite
- iPhone-first UI

## Estimated steps
WalkExplore now shows an estimated step count alongside distance and time. The planning estimate uses approximately 1,400 steps per kilometre. Segment chips show estimated steps for each stop-to-stop section, and saved/completed routes retain their estimate. These are planning estimates, not pedometer measurements.

## Estimated calories
Calories are estimated as 3.5 METs (moderate walking, ~5 km/h) × body weight (kg) × walk duration (hours). The
first time a route has two or more stops, the app asks for the user's weight in kg or lb, or they can use a 70 kg
average. Tap the calorie figure or the note under the stats to change it. The weight is stored on the device only
(SQLite `settings` table natively, localStorage on the web), and calories for saved walks are recalculated with the
current weight. These are planning estimates, not measurements.

## Accounts and sync
People can create an account with a random username and a 6-digit PIN (Profile tab). Signed-in walks and weight
are stored in Neon Postgres through Vercel Functions in `api/`; signed-out use stays on the device. On first sign-in,
walks saved on the device move into the account.

- Schema: `db/schema.sql`. Apply with `npm run db:migrate` (reads `NEON_DATABASE_URL` from `.env`; safe to re-run).
- Server-only env vars (set both in Vercel): `NEON_DATABASE_URL`, `AUTH_PEPPER`. Never change `AUTH_PEPPER` once
  users exist, or every PIN stops working.
- PINs: scrypt with a per-user salt plus the pepper; trivially guessable PINs are rejected. Every 5th wrong PIN locks
  the account (15 min, doubling up to 24 h), and an IP is limited to 20 failed sign-ins per 15 minutes and 10 sign-ups
  per hour. There is no PIN reset.
- Native builds call the deployed API at `EXPO_PUBLIC_API_URL` (defaults to https://explore-app-three.vercel.app).

## Circular walks (Loop mode)
Switch the planner to **Loop**, tap the map (or **Start here**) to set the start, choose a distance on the slider
(0–50 km, in 0.5 km steps) and tap **Generate**. The code is in `src/routing.ts` (`findLoops`) and the slider is
`src/DistanceSlider.tsx`.

Valhalla has no round-trip mode, so each loop is a triangle or square of waypoints that passes through the start,
routed start → corners → start with "through" waypoints (no U-turns at the corners). The first try measures how
winding the local streets are, then three more directions are routed at the corrected size. Loops within 12% of the
chosen distance are ranked by turns (left, right, sharp and U-turns), with a penalty for walking back over the same
streets, and the simplest is shown. **Shuffle** goes through the other loops from that search first, then searches
directions not tried yet. One search makes about 4–6 requests to the public Valhalla server. Saved loops store the
start, corners and finish, so they reopen with the same line.
