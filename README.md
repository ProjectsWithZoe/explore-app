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
