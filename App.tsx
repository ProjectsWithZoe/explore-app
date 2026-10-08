import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import * as Location from 'expo-location';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import WalkMap from './src/WalkMap';
import { clearRoutes, deleteRoute, insertRoute, listRoutes, loadProfile, loadSession, saveProfile, saveSession } from './src/storage';
import { ApiError, api, pinProblem, randomUsername } from './src/api';
import type { Coordinate, NewRouteRecord, Profile, Region, RoutePoint, RouteRecord, Session, WalkMapHandle, WeightUnit } from './src/types';

const COLORS = {
  ink: '#17231D',
  muted: '#6C766F',
  bg: '#F4F5EF',
  card: '#FFFFFF',
  accent: '#1F6B4A',
  accentSoft: '#E1EEE7',
  line: '#DDE2DB',
  warm: '#E7B96A',
  danger: '#A94B43',
  white: '#FFFFFF',
};

const DEFAULT_CENTER = { latitude: 51.5074, longitude: -0.1278 };
const ROUTER_URL = 'https://valhalla1.openstreetmap.de/route';
const WIDE_BREAKPOINT = 768;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function haversineKm(a: Coordinate, b: Coordinate) {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const la1 = (a.latitude * Math.PI) / 180;
  const la2 = (b.latitude * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function formatDistance(km: number) {
  if (!Number.isFinite(km)) return '—';
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km >= 10 ? 1 : 2)} km`;
}

function estimatedStepsForDistance(km: number) {
  if (!Number.isFinite(km) || km <= 0) return 0;
  // Planning estimate only: roughly 1,400 steps per kilometre.
  return Math.max(0, Math.round(km * 1400));
}

type Tab = 'plan' | 'routes' | 'profile';

const AVERAGE_WEIGHT_KG = 70;
const KG_PER_LB = 0.45359237;
// Walking at a moderate pace (~5 km/h) is about 3.5 METs; kcal = MET × kg × hours.
const WALKING_MET = 3.5;

function estimatedCalories(durationMin: number, weightKg: number) {
  if (!Number.isFinite(durationMin) || durationMin <= 0) return 0;
  return Math.round(WALKING_MET * weightKg * (durationMin / 60));
}

function formatWeight(kg: number, unit: WeightUnit) {
  return unit === 'lb' ? `${Math.round(kg / KG_PER_LB)} lb` : `${Math.round(kg)} kg`;
}

function formatSteps(steps: number) {
  if (!Number.isFinite(steps)) return '—';
  return `${Math.round(steps).toLocaleString()} steps`;
}

function formatDuration(min: number) {
  if (!Number.isFinite(min)) return '—';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function formatDateTime(iso?: string | null) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

// Valhalla's default encoded shape is polyline6. Decode without an extra package.
function decodePolyline6(encoded: string): Coordinate[] {
  let index = 0;
  let lat = 0;
  let lon = 0;
  const coordinates: Coordinate[] = [];
  const factor = 1e6;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push({ latitude: lat / factor, longitude: lon / factor });
  }
  return coordinates;
}

async function routeWithValhalla(points: RoutePoint[]) {
  if (points.length < 2) {
    return { distanceKm: 0, durationMin: 0, geometry: points };
  }

  const response = await fetch(ROUTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locations: points.map((p) => ({ lat: p.latitude, lon: p.longitude })),
      costing: 'pedestrian',
      units: 'kilometers',
      shape_format: 'polyline6',
      directions_options: { units: 'kilometers' },
    }),
  });

  if (!response.ok) throw new Error(`Routing service returned ${response.status}.`);
  const data = await response.json();

  if (!data.trip?.legs) throw new Error('No walkable route was returned for these points.');

  const geometry: Coordinate[] = [];
  data.trip.legs.forEach((leg: any, index: number) => {
    const decoded = decodePolyline6(leg.shape);
    geometry.push(...(index ? decoded.slice(1) : decoded));
  });

  const distanceKm = Number(data.trip.summary?.length ?? 0);
  const durationMin = Number(data.trip.summary?.time ?? 0) / 60;

  return { distanceKm, durationMin, geometry };
}

export default function App() {
  return (
    <SafeAreaProvider>
      <WalkExplore />
    </SafeAreaProvider>
  );
}

function WalkExplore() {
  const insets = useSafeAreaInsets();
  // Device insets (notch / status bar / home indicator) are 0 in a normal browser tab
  // and non-zero natively or when installed as a full-screen PWA.
  const topInset = insets.top > 0 ? insets.top + 6 : 16;
  const bottomInset = insets.bottom;
  const mapRef = useRef<WalkMapHandle>(null);
  const { width, height } = useWindowDimensions();
  const isWide = width >= WIDE_BREAKPOINT;
  const isCompact = width < 390;
  const [panelHeight, setPanelHeight] = useState(360);
  const [toast, setToast] = useState<{ title: string; message: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Signed-in account (null = using this device only). A ref too, so async callbacks see the latest value.
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [authMode, setAuthMode] = useState<'signup' | 'login' | null>(null);
  const [authUsername, setAuthUsername] = useState('');
  const [authPin, setAuthPin] = useState('');
  const [authPinConfirm, setAuthPinConfirm] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const centeredOnUser = useRef(false);
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [tab, setTab] = useState<Tab>('plan');
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  // Only the phone bottom sheet can be minimised; the desktop side panel doesn't cover the map.
  const collapsed = panelCollapsed && !isWide;
  const [points, setPoints] = useState<RoutePoint[]>([]);
  const [routeGeometry, setRouteGeometry] = useState<Coordinate[]>([]);
  const [distanceKm, setDistanceKm] = useState(0);
  const [durationMin, setDurationMin] = useState(0);
  const [estimatedSteps, setEstimatedSteps] = useState(0);
  const [segmentSteps, setSegmentSteps] = useState<number[]>([]);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [routeName, setRouteName] = useState('My walking route');
  const [showNameModal, setShowNameModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<'save' | 'complete' | null>(null);
  const [records, setRecords] = useState<RouteRecord[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<RouteRecord | null>(null);
  // undefined = still loading, null = never asked.
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [showWeightModal, setShowWeightModal] = useState(false);
  const [weightInput, setWeightInput] = useState('');
  const [weightUnit, setWeightUnit] = useState<WeightUnit>('kg');
  const [weightError, setWeightError] = useState('');
  const weightKg = profile?.weightKg ?? AVERAGE_WEIGHT_KG;
  const usingAverageWeight = !profile?.weightKg;
  const calories = estimatedCalories(durationMin, weightKg);

  const userCoordinate: Coordinate | null = location
    ? { latitude: location.coords.latitude, longitude: location.coords.longitude }
    : null;

  const currentRegion: Region = useMemo(() => {
    if (!location) return { ...DEFAULT_CENTER, latitudeDelta: 0.025, longitudeDelta: 0.025 };
    return {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      latitudeDelta: 0.025,
      longitudeDelta: 0.025,
    };
  }, [location]);

  useEffect(() => {
    let mounted = true;
    restoreSession();
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          if (mounted) setPermissionDenied(true);
          return;
        }
        const current = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        if (mounted) setLocation(current);
      } catch (e) {
        console.warn(e);
        if (mounted) setPermissionDenied(true);
      }
    })();
    return () => {
      mounted = false;
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // Ask for a weight once, the first time a route has a calorie estimate to show.
  useEffect(() => {
    if (profile === null && points.length > 1 && !showNameModal) openWeightModal();
  }, [profile, points.length]);

  // The map mounts before the location fix arrives, so jump to the user once it does.
  useEffect(() => {
    if (!userCoordinate || centeredOnUser.current) return;
    centeredOnUser.current = true;
    mapRef.current?.animateTo(userCoordinate);
  }, [userCoordinate?.latitude, userCoordinate?.longitude]);

  useEffect(() => {
    if (points.length < 2) {
      setRouteGeometry([]);
      setDistanceKm(0);
      setDurationMin(0);
      setEstimatedSteps(0);
      setSegmentSteps([]);
      setRouteError('');
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setRouting(true);
      setRouteError('');
      try {
        const result = await routeWithValhalla(points);
        if (!cancelled) {
          setRouteGeometry(result.geometry);
          setDistanceKm(result.distanceKm);
          setDurationMin(result.durationMin);
          const straightSegmentDistances = points.slice(1).map((p, i) => haversineKm(points[i], p));
          const straightTotal = straightSegmentDistances.reduce((a, b) => a + b, 0);
          const ratio = straightTotal > 0 ? result.distanceKm / straightTotal : 1;
          const segmentDistances = straightSegmentDistances.map((d) => d * ratio);
          const steps = segmentDistances.map(estimatedStepsForDistance);
          setSegmentSteps(steps);
          setEstimatedSteps(steps.reduce((a, b) => a + b, 0));
        }
      } catch (e: any) {
        if (!cancelled) {
          // Keep the planner useful if the public routing service is unavailable.
          let rough = 0;
          for (let i = 1; i < points.length; i++) rough += haversineKm(points[i - 1], points[i]) * 1.25;
          setDistanceKm(rough);
          setDurationMin((rough / 4.8) * 60);
          setRouteGeometry(points);
          const steps = points.slice(1).map((p, i) => estimatedStepsForDistance(haversineKm(points[i], p) * 1.25));
          setSegmentSteps(steps);
          setEstimatedSteps(steps.reduce((a, b) => a + b, 0));
          setRouteError('Walking route service is unavailable, so this is an estimate.');
        }
      } finally {
        if (!cancelled) setRouting(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [points]);

  // Sheet handle: tap to toggle the planner, swipe down to minimise, swipe up to bring it back.
  const sheetPan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 30) setPanelCollapsed(true);
      else if (g.dy < -30) setPanelCollapsed(false);
      else if (Math.abs(g.dy) < 6 && Math.abs(g.dx) < 6) setPanelCollapsed((c) => !c);
    },
  }), []);

  function openWeightModal() {
    const unit = profile?.unit ?? 'kg';
    setWeightUnit(unit);
    setWeightInput(profile?.weightKg ? String(Math.round(unit === 'lb' ? profile.weightKg / KG_PER_LB : profile.weightKg)) : '');
    setWeightError('');
    setShowWeightModal(true);
  }

  function changeWeightUnit(unit: WeightUnit) {
    if (unit === weightUnit) return;
    const value = parseFloat(weightInput.replace(',', '.'));
    if (Number.isFinite(value) && value > 0) {
      setWeightInput(String(Math.round(unit === 'lb' ? value / KG_PER_LB : value * KG_PER_LB)));
    }
    setWeightUnit(unit);
  }

  async function storeProfile(next: Profile) {
    setProfile(next);
    setShowWeightModal(false);
    try {
      const s = sessionRef.current;
      if (s) await api.saveProfile(s.token, next);
      else await saveProfile(next);
    } catch (e) {
      console.warn(e);
      notify('Weight not saved', e instanceof ApiError ? e.message : 'Something went wrong saving your weight.');
    }
  }

  function applySession(next: Session | null) {
    sessionRef.current = next;
    setSession(next);
  }

  async function switchToDeviceData() {
    applySession(null);
    setProfile(await loadProfile().catch(() => null));
    await loadRecords();
  }

  async function restoreSession() {
    const saved = await loadSession().catch(() => null);
    if (!saved) {
      await switchToDeviceData();
      return;
    }
    applySession(saved);
    try {
      const me = await api.me(saved.token);
      setProfile(me.profile);
      await loadRecords();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await saveSession(null);
        await switchToDeviceData();
        notify('Signed out', 'Your session expired. Sign in again to see your walks.');
      } else {
        notify('Offline', 'Can’t reach the server right now, so your walks may be out of date.');
      }
    }
  }

  function openAuth(mode: 'signup' | 'login') {
    setAuthMode(mode);
    setAuthUsername(mode === 'signup' ? randomUsername() : '');
    setAuthPin('');
    setAuthPinConfirm('');
    setAuthError('');
  }

  async function submitAuth() {
    if (!authMode || authBusy) return;
    const username = authUsername.trim().toLowerCase();
    if (!username) return setAuthError('Enter your username.');
    if (authMode === 'signup') {
      const problem = pinProblem(authPin);
      if (problem) return setAuthError(problem);
      if (authPin !== authPinConfirm) return setAuthError('The two PINs don’t match.');
    } else if (!/^\d{6}$/.test(authPin)) {
      return setAuthError('Enter your 6-digit PIN.');
    }

    setAuthBusy(true);
    setAuthError('');
    try {
      const next = authMode === 'signup' ? await api.signup(username, authPin) : await api.login(username, authPin);
      await saveSession(next);
      applySession(next);
      const moved = await moveDeviceDataIntoAccount(next);
      setAuthMode(null);
      notify(
        authMode === 'signup' ? 'Account created' : 'Signed in',
        moved ? `Signed in as ${next.username}. ${moved} walk${moved === 1 ? '' : 's'} from this device moved to your account.` : `Signed in as ${next.username}.`,
      );
    } catch (e) {
      setAuthError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setAuthBusy(false);
    }
  }

  /** Uploads walks and weight saved on this device into the account, then loads the account's data. */
  async function moveDeviceDataIntoAccount(next: Session) {
    const local = await listRoutes().catch(() => [] as RouteRecord[]);
    if (local.length) {
      const walks: NewRouteRecord[] = local.map(({ id, ...walk }) => walk);
      for (let i = 0; i < walks.length; i += 500) await api.addWalks(next.token, walks.slice(i, i + 500));
      await clearRoutes();
    }
    const me = await api.me(next.token);
    let accountProfile = me.profile;
    if (!accountProfile) {
      const localProfile = await loadProfile().catch(() => null);
      if (localProfile) {
        await api.saveProfile(next.token, localProfile);
        accountProfile = localProfile;
      }
    }
    setProfile(accountProfile);
    await loadRecords();
    return local.length;
  }

  async function signOut() {
    const current = sessionRef.current;
    await saveSession(null);
    if (current) api.logout(current.token).catch(() => {});
    setConfirmDelete(false);
    await switchToDeviceData();
    notify('Signed out', 'Walks you log now are saved on this device only.');
  }

  async function deleteAccount() {
    const current = sessionRef.current;
    if (!current) return;
    try {
      await api.deleteAccount(current.token);
    } catch (e) {
      notify('Couldn’t delete account', e instanceof ApiError ? e.message : 'Please try again.');
      return;
    }
    await saveSession(null);
    setConfirmDelete(false);
    await switchToDeviceData();
    notify('Account deleted', 'Your account and its walks have been removed.');
  }

  function submitWeight() {
    const value = parseFloat(weightInput.replace(',', '.'));
    const kg = weightUnit === 'lb' ? value * KG_PER_LB : value;
    if (!Number.isFinite(kg) || kg < 25 || kg > 300) {
      setWeightError(weightUnit === 'lb' ? 'Enter a weight between 55 and 660 lb.' : 'Enter a weight between 25 and 300 kg.');
      return;
    }
    storeProfile({ weightKg: Math.round(kg * 10) / 10, unit: weightUnit });
  }

  function notify(title: string, message: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ title, message });
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }

  async function loadRecords() {
    try {
      const s = sessionRef.current;
      const rows = s ? await api.listWalks(s.token) : await listRoutes();
      setRecords(rows.map((row) => ({
        ...row,
        estimatedSteps: row.estimatedSteps ?? estimatedStepsForDistance(row.distanceKm),
      })));
    } catch (e) {
      console.warn(e);
      if (e instanceof ApiError) notify('Couldn’t load walks', e.message);
    }
  }

  function centerOnUser() {
    if (!userCoordinate) {
      notify('Location unavailable', 'Allow location access in your browser or device settings.');
      return;
    }
    mapRef.current?.animateTo(userCoordinate);
  }

  function addCurrentLocation() {
    if (!location) return;
    if (points.some((p) => haversineKm(p, location.coords) < 0.01)) return;
    setPoints((prev) => [
      ...prev,
      {
        id: uid(),
        label: prev.length === 0 ? 'Start' : `Stop ${prev.length + 1}`,
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      },
    ]);
  }

  function addMapPoint(coordinate: Coordinate) {
    setPoints((prev) => [
      ...prev,
      {
        ...coordinate,
        id: uid(),
        label: prev.length === 0 ? 'Start' : `Stop ${prev.length + 1}`,
      },
    ]);
  }

  function removePoint(id: string) {
    setPoints((prev) => prev.filter((p) => p.id !== id).map((p, i) => ({
      ...p,
      label: i === 0 ? 'Start' : `Stop ${i + 1}`,
    })));
  }

  function clearPlan() {
    setPoints([]);
    setRouteGeometry([]);
    setDistanceKm(0);
    setDurationMin(0);
    setRouteError('');
  }

  function requestSave(action: 'save' | 'complete') {
    if (points.length < 2) {
      notify('Add another stop', 'Tap the map to add at least two points to your route.');
      return;
    }
    setPendingAction(action);
    setShowNameModal(true);
  }

  async function persistRoute(action: 'save' | 'complete') {
    const now = new Date().toISOString();
    const walk: NewRouteRecord = {
      name: routeName.trim() || 'Walking route',
      createdAt: now,
      completedAt: action === 'complete' ? now : null,
      saved: action === 'save' ? 1 : 0,
      distanceKm,
      durationMin,
      estimatedSteps,
      points,
      geometry: routeGeometry,
    };
    try {
      const s = sessionRef.current;
      if (s) await api.addWalks(s.token, [walk]);
      else await insertRoute(walk);
    } catch (e) {
      console.warn(e);
      notify('Could not save', e instanceof ApiError ? e.message : 'Something went wrong storing this route.');
      return;
    }
    await loadRecords();
    setShowNameModal(false);
    setPendingAction(null);
    if (action === 'complete') {
      notify('Walk logged', 'Your route has been added to your history.');
    } else {
      notify('Route saved', 'You can find it in Saved routes.');
    }
  }

  async function deleteRecord(id: number) {
    try {
      const s = sessionRef.current;
      if (s) await api.deleteWalk(s.token, id);
      else await deleteRoute(id);
    } catch (e) {
      notify('Couldn’t delete', e instanceof ApiError ? e.message : 'Please try again.');
      return;
    }
    if (selectedRecord?.id === id) setSelectedRecord(null);
    await loadRecords();
  }

  function loadRecord(record: RouteRecord) {
    setPoints(record.points);
    setRouteGeometry(record.geometry);
    setDistanceKm(record.distanceKm);
    setDurationMin(record.durationMin);
    setEstimatedSteps(record.estimatedSteps ?? estimatedStepsForDistance(record.distanceKm));
    setSegmentSteps(record.points.slice(1).map((p, i) => estimatedStepsForDistance(haversineKm(record.points[i], p))));
    setRouteName(record.name);
    setSelectedRecord(null);
    setPanelCollapsed(false);
    setTab('plan');
  }

  const saved = records.filter((r) => r.saved === 1 && !r.completedAt);
  const history = records.filter((r) => !!r.completedAt);
  const totalWalkedKm = history.reduce((sum, r) => sum + r.distanceKm, 0);
  const totalCalories = history.reduce((sum, r) => sum + estimatedCalories(r.durationMin, weightKg), 0);
  const activity = useMemo(() => activityStats(history, weightKg), [history, weightKg]);
  // Five summary cards don't fit in one row on phones; wrap them into a grid.
  const summaryWraps = width < 520;
  const totalSteps = history.reduce((sum, r) => sum + (r.estimatedSteps ?? estimatedStepsForDistance(r.distanceKm)), 0);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" translucent backgroundColor="transparent" />
      {tab === 'plan' ? (
        <View style={styles.planScreen}>
          <WalkMap
            ref={mapRef}
            initialRegion={currentRegion}
            points={points}
            geometry={routeGeometry}
            userLocation={userCoordinate}
            onPress={addMapPoint}
            accentColor={COLORS.accent}
            stopColor="#25352D"
            bottomInset={isWide ? 0 : panelHeight}
          />

          <View style={[styles.topOverlay, { top: topInset }, isWide && styles.topOverlayWide]}>
            <View style={styles.brandPill}>
              <View style={styles.brandDot} />
              <Text style={styles.brand}>WalkExplore</Text>
            </View>
            <Pressable style={styles.iconButton} onPress={() => setTab('routes')}>
              <Text style={styles.icon}>▤</Text>
            </Pressable>
          </View>

          <View style={[styles.mapActions, { bottom: isWide ? 24 : panelHeight + 14 }]}>
            <Pressable style={styles.floatingButton} onPress={centerOnUser}>
              <Text style={styles.floatingIcon}>⌾</Text>
            </Pressable>
            <Pressable style={styles.floatingButton} onPress={addCurrentLocation}>
              <Text style={styles.floatingIcon}>＋</Text>
            </Pressable>
          </View>

          <View
            style={[
              styles.bottomPanel,
              isWide
                ? [styles.sidePanel, { top: topInset, maxHeight: height - topInset - 18 }]
                : { maxHeight: height * 0.62, paddingBottom: Math.max(12, bottomInset) },
            ]}
            onLayout={(e) => setPanelHeight(e.nativeEvent.layout.height)}
          >
            {!isWide && (
              <View>
                <View
                  {...sheetPan.panHandlers}
                  style={styles.handleArea}
                  accessibilityRole="button"
                  accessibilityLabel={collapsed ? 'Show route planner' : 'Minimise route planner'}
                >
                  <View style={styles.handle} />
                </View>
                {collapsed && (
                  <Pressable style={styles.collapsedRow} onPress={() => setPanelCollapsed(false)}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      {points.length > 1 ? (
                        <>
                          <Text style={styles.collapsedSummary} numberOfLines={1}>
                            {formatDistance(distanceKm)} · {formatDuration(durationMin)}
                          </Text>
                          <Text style={styles.collapsedDetail} numberOfLines={1}>
                            {estimatedSteps.toLocaleString()} steps · {calories.toLocaleString()} kcal
                          </Text>
                        </>
                      ) : (
                        <>
                          <Text style={styles.eyebrow}>ROUTE PLANNER</Text>
                          <Text style={styles.collapsedSummary} numberOfLines={1}>
                            {points.length === 1 ? 'Start set. Tap the map to add a stop' : 'Tap the map to start a walk'}
                          </Text>
                        </>
                      )}
                    </View>
                    <View style={styles.collapsedButton}>
                      <Text style={styles.collapsedButtonText}>Show ⌃</Text>
                    </View>
                  </Pressable>
                )}
              </View>
            )}
            {!collapsed && (
            <>
            <ScrollView showsVerticalScrollIndicator={false} bounces={false} style={styles.panelScroll}>
            <View style={styles.panelHeader}>
              <View>
                <Text style={styles.eyebrow}>ROUTE PLANNER</Text>
                <Text style={styles.title}>Build your walk</Text>
              </View>
              <View style={styles.panelHeaderActions}>
                {points.length > 0 && (
                  <Pressable onPress={clearPlan} hitSlop={8}>
                    <Text style={styles.clearText}>Clear</Text>
                  </Pressable>
                )}
                {!isWide && (
                  <Pressable
                    style={styles.minimiseButton}
                    onPress={() => setPanelCollapsed(true)}
                    accessibilityRole="button"
                    accessibilityLabel="Minimise route planner"
                    hitSlop={6}
                  >
                    <Text style={styles.minimiseText}>⌄</Text>
                  </Pressable>
                )}
              </View>
            </View>

            <View style={styles.helperRow}>
              <Text style={styles.helper}>Tap anywhere on the map to add your next stop.</Text>
              <View style={styles.routeStatus}>
                <View style={[styles.statusDot, routing && styles.statusDotBusy]} />
                <Text style={styles.statusText}>{routing ? 'Routing…' : points.length > 1 ? 'Walkable' : 'Ready'}</Text>
              </View>
            </View>

            {points.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pointsRow}>
                {points.map((point, index) => (
                  <View key={point.id} style={styles.pointChip}>
                    <View style={[styles.chipNumber, index === 0 && styles.chipNumberStart]}>
                      <Text style={styles.chipNumberText}>{index + 1}</Text>
                    </View>
                    <Text style={styles.pointChipText}>{point.label}</Text>
                    <Pressable onPress={() => removePoint(point.id)} hitSlop={8}>
                      <Text style={styles.chipRemove}>×</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            )}

            <View style={[styles.statsCard, isCompact && styles.statsCardCompact]}>
              <View style={styles.stat}>
                <Text style={styles.statLabel} numberOfLines={1}>DISTANCE</Text>
                <Text style={[styles.distance, isCompact && styles.distanceCompact]} numberOfLines={1}>{formatDistance(distanceKm)}</Text>
              </View>
              <View style={[styles.statDivider, isCompact && styles.statDividerCompact]} />
              <View style={styles.stat}>
                <Text style={styles.statLabel} numberOfLines={1}>TIME</Text>
                <Text style={[styles.time, isCompact && styles.timeCompact]} numberOfLines={1}>{formatDuration(durationMin)}</Text>
              </View>
              <View style={[styles.statDivider, isCompact && styles.statDividerCompact]} />
              <View style={styles.stat}>
                <Text style={styles.statLabel} numberOfLines={1}>STEPS</Text>
                <Text style={[styles.time, isCompact && styles.timeCompact]} numberOfLines={1}>{estimatedSteps.toLocaleString()}</Text>
              </View>
              <View style={[styles.statDivider, isCompact && styles.statDividerCompact]} />
              <Pressable
                style={styles.stat}
                onPress={openWeightModal}
                accessibilityRole="button"
                accessibilityLabel="Estimated calories. Change weight"
              >
                <Text style={styles.statLabel} numberOfLines={1}>KCAL</Text>
                <Text style={[styles.time, isCompact && styles.timeCompact]} numberOfLines={1}>{calories.toLocaleString()}</Text>
              </Pressable>
            </View>

            <Pressable onPress={openWeightModal} hitSlop={6} style={styles.calorieNote}>
              <Text style={styles.calorieNoteText}>
                {usingAverageWeight
                  ? `Estimates. Calories assume a ${formatWeight(AVERAGE_WEIGHT_KG, profile?.unit ?? 'kg')} average. `
                  : `Estimates. Calories use your weight (${formatWeight(weightKg, profile?.unit ?? 'kg')}). `}
                <Text style={styles.calorieNoteLink}>{usingAverageWeight ? 'Add your weight' : 'Change'}</Text>
              </Text>
            </Pressable>

            {routeError ? <Text style={styles.warning}>{routeError}</Text> : null}

            {points.length > 1 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.segmentRow}>
                {points.slice(1).map((point, index) => (
                  <View key={point.id} style={styles.segmentChip}>
                    <Text style={styles.segmentLabel}>STOP {index + 1} → {index + 2}</Text>
                    <Text style={styles.segmentValue}>~{(segmentSteps[index] ?? 0).toLocaleString()} steps</Text>
                  </View>
                ))}
              </ScrollView>
            )}

            <View style={styles.actionRow}>
              <Pressable style={styles.secondaryButton} onPress={() => requestSave('save')}>
                <Text style={styles.secondaryButtonText}>♡  Save</Text>
              </Pressable>
              <Pressable style={styles.primaryButton} onPress={() => requestSave('complete')}>
                <Text style={styles.primaryButtonText}>✓  Log as done</Text>
              </Pressable>
            </View>
            </ScrollView>

            <TabBar active="plan" onChange={setTab} style={styles.tabBar} />
            </>
            )}
          </View>
        </View>
      ) : tab === 'routes' ? (
        <View style={[styles.routesScreen, { paddingTop: topInset }]}>
          <View style={[styles.routesHeader, styles.contentWidth]}>
            <View>
              <Text style={styles.eyebrow}>YOUR WALKS</Text>
              <Text style={styles.title}>Routes</Text>
            </View>
            <Pressable style={styles.closeButton} onPress={() => setTab('plan')}>
              <Text style={styles.closeText}>Map</Text>
            </Pressable>
          </View>

          <View style={[styles.summaryRow, styles.contentWidth, summaryWraps && styles.summaryRowCompact]}>
            <View style={[styles.summaryCard, summaryWraps && styles.summaryCardCompact]}>
              <Text style={styles.summaryValue}>{history.length}</Text>
              <Text style={styles.summaryLabel}>Walks done</Text>
            </View>
            <View style={[styles.summaryCard, summaryWraps && styles.summaryCardCompact]}>
              <Text style={styles.summaryValue}>{formatDistance(totalWalkedKm)}</Text>
              <Text style={styles.summaryLabel}>Distance</Text>
            </View>
            <View style={[styles.summaryCard, summaryWraps && styles.summaryCardCompact]}>
              <Text style={styles.summaryValue}>{saved.length}</Text>
              <Text style={styles.summaryLabel}>Saved</Text>
            </View>
            <View style={[styles.summaryCard, summaryWraps && styles.summaryCardCompact]}>
              <Text style={styles.summaryValue}>{totalSteps.toLocaleString()}</Text>
              <Text style={styles.summaryLabel}>Est. steps</Text>
            </View>
            <View style={[styles.summaryCard, summaryWraps && styles.summaryCardCompact]}>
              <Text style={styles.summaryValue}>{totalCalories.toLocaleString()}</Text>
              <Text style={styles.summaryLabel}>Est. kcal</Text>
            </View>
          </View>

          <ScrollView contentContainerStyle={[styles.routesList, styles.contentWidth]}>
            {saved.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Saved for later</Text>
                {saved.map((record) => (
                  <RouteCard key={record.id} record={record} onPress={() => loadRecord(record)} onDelete={() => deleteRecord(record.id)} weightKg={weightKg} saved />
                ))}
              </>
            )}

            <Text style={[styles.sectionTitle, saved.length ? { marginTop: 24 } : null]}>Walk history</Text>
            {history.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyIcon}>◌</Text>
                <Text style={styles.emptyTitle}>No walks logged yet</Text>
                <Text style={styles.emptyText}>Build a route on the map, then tap “Log as done” when you’ve walked it.</Text>
                <Pressable style={styles.primaryButtonSmall} onPress={() => setTab('plan')}>
                  <Text style={styles.primaryButtonText}>Plan a walk</Text>
                </Pressable>
              </View>
            ) : (
              history.map((record) => (
                <RouteCard key={record.id} record={record} onPress={() => setSelectedRecord(record)} onDelete={() => deleteRecord(record.id)} weightKg={weightKg} />
              ))
            )}
          </ScrollView>

          <TabBar active="routes" onChange={setTab} style={[styles.routesTabBar, { paddingBottom: Math.max(9, bottomInset) }]} />
        </View>
      ) : (
        <View style={[styles.routesScreen, { paddingTop: topInset }]}>
          <View style={[styles.routesHeader, styles.contentWidth]}>
            <View>
              <Text style={styles.eyebrow}>YOUR ACTIVITY</Text>
              <Text style={styles.title}>Profile</Text>
            </View>
            <Pressable style={styles.closeButton} onPress={() => setTab('plan')}>
              <Text style={styles.closeText}>Map</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={[styles.routesList, styles.contentWidth]}>
            <View style={[styles.accountCard, styles.profileSection]}>
              {session ? (
                <>
                  <View style={styles.accountRow}>
                    <View style={styles.avatar}><Text style={styles.avatarText}>{session.username[0]?.toUpperCase()}</Text></View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.eyebrow}>SIGNED IN AS</Text>
                      <Text style={styles.routeName} numberOfLines={1}>{session.username}</Text>
                    </View>
                    <Pressable style={styles.closeButton} onPress={signOut}>
                      <Text style={styles.closeText}>Sign out</Text>
                    </Pressable>
                  </View>
                  <Text style={styles.accountNote}>Your walks sync to any device where you sign in with this username and your PIN.</Text>
                  {confirmDelete ? (
                    <View style={styles.deleteConfirm}>
                      <Text style={styles.deleteConfirmText}>Permanently delete this account and all its walks? This can’t be undone.</Text>
                      <View style={styles.modalActions}>
                        <Pressable style={styles.cancelButton} onPress={() => setConfirmDelete(false)}>
                          <Text style={styles.cancelText}>Keep account</Text>
                        </Pressable>
                        <Pressable style={[styles.deleteButton, { flex: 1 }]} onPress={deleteAccount}>
                          <Text style={styles.deleteText}>Delete forever</Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : (
                    <Pressable onPress={() => setConfirmDelete(true)} hitSlop={6} style={{ alignSelf: 'flex-start', marginTop: 10 }}>
                      <Text style={styles.deleteLink}>Delete account</Text>
                    </Pressable>
                  )}
                </>
              ) : (
                <>
                  <Text style={styles.routeName}>Keep your walks safe</Text>
                  <Text style={styles.accountNote}>
                    Right now your walks are saved on this device only. Create an account with a username and 6-digit PIN to keep them and see them on any device.
                  </Text>
                  <View style={styles.modalActions}>
                    <Pressable style={styles.secondaryButton} onPress={() => openAuth('login')}>
                      <Text style={styles.secondaryButtonText}>Sign in</Text>
                    </Pressable>
                    <Pressable style={styles.primaryButton} onPress={() => openAuth('signup')}>
                      <Text style={styles.primaryButtonText}>Create account</Text>
                    </Pressable>
                  </View>
                </>
              )}
            </View>

            <ProfileStats
              stats={activity}
              columns={isWide ? 3 : 2}
              weightLabel={usingAverageWeight
                ? `${formatWeight(AVERAGE_WEIGHT_KG, profile?.unit ?? 'kg')} average`
                : formatWeight(weightKg, profile?.unit ?? 'kg')}
              usingAverageWeight={usingAverageWeight}
              onChangeWeight={openWeightModal}
              onPlan={() => setTab('plan')}
            />
          </ScrollView>

          <TabBar active="profile" onChange={setTab} style={[styles.routesTabBar, { paddingBottom: Math.max(9, bottomInset) }]} />
        </View>
      )}

      <Modal visible={showNameModal} transparent animationType="fade" onRequestClose={() => setShowNameModal(false)}>
        <KeyboardAvoidingView style={[styles.modalBackdrop, isWide && styles.modalBackdropWide]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{pendingAction === 'complete' ? 'Log this walk' : 'Save this route'}</Text>
            <Text style={styles.modalSubtitle}>Give your route a name so it is easy to find later.</Text>
            <TextInput
              value={routeName}
              onChangeText={setRouteName}
              placeholder="e.g. Sunday park loop"
              placeholderTextColor="#9AA29C"
              style={styles.nameInput}
              autoFocus
              selectTextOnFocus
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.cancelButton} onPress={() => setShowNameModal(false)}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.primaryButton} onPress={() => pendingAction && persistRoute(pendingAction)}>
                <Text style={styles.primaryButtonText}>{pendingAction === 'complete' ? 'Log walk' : 'Save route'}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={showWeightModal} transparent animationType="fade" onRequestClose={() => setShowWeightModal(false)}>
        <KeyboardAvoidingView style={[styles.modalBackdrop, isWide && styles.modalBackdropWide]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Estimate calories</Text>
            <Text style={styles.modalSubtitle}>
              Add your weight for a more accurate calorie estimate, or use the {AVERAGE_WEIGHT_KG} kg average. It stays on this device.
            </Text>
            <View style={styles.weightRow}>
              <TextInput
                value={weightInput}
                onChangeText={(text) => { setWeightInput(text); setWeightError(''); }}
                placeholder={weightUnit === 'lb' ? 'e.g. 154' : 'e.g. 70'}
                placeholderTextColor="#9AA29C"
                keyboardType="decimal-pad"
                inputMode="decimal"
                returnKeyType="done"
                onSubmitEditing={submitWeight}
                style={[styles.nameInput, styles.weightInput]}
                accessibilityLabel={`Weight in ${weightUnit === 'lb' ? 'pounds' : 'kilograms'}`}
              />
              <View style={styles.unitToggle}>
                {(['kg', 'lb'] as const).map((unit) => (
                  <Pressable
                    key={unit}
                    style={[styles.unitOption, weightUnit === unit && styles.unitOptionActive]}
                    onPress={() => changeWeightUnit(unit)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: weightUnit === unit }}
                  >
                    <Text style={[styles.unitText, weightUnit === unit && styles.unitTextActive]}>{unit}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            {weightError ? <Text style={styles.weightError}>{weightError}</Text> : null}
            <View style={styles.weightActions}>
              <Pressable style={styles.primaryButton} onPress={submitWeight}>
                <Text style={styles.primaryButtonText}>Save weight</Text>
              </Pressable>
              <Pressable
                style={styles.cancelButton}
                onPress={() => storeProfile({ weightKg: null, unit: weightUnit })}
              >
                <Text style={styles.cancelText}>Use {AVERAGE_WEIGHT_KG} kg average</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={!!authMode} transparent animationType="fade" onRequestClose={() => !authBusy && setAuthMode(null)}>
        <KeyboardAvoidingView style={[styles.modalBackdrop, isWide && styles.modalBackdropWide]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{authMode === 'signup' ? 'Create an account' : 'Sign in'}</Text>
            <Text style={styles.modalSubtitle}>
              {authMode === 'signup'
                ? 'Here’s a random username. Shuffle it or type your own. There’s no PIN reset, so keep your username and PIN somewhere safe.'
                : 'Enter your username and 6-digit PIN.'}
            </Text>

            <Text style={styles.fieldLabel}>Username</Text>
            <View style={styles.weightRow}>
              <TextInput
                value={authUsername}
                onChangeText={(t) => { setAuthUsername(t.toLowerCase()); setAuthError(''); }}
                placeholder="e.g. brisk-otter-4821"
                placeholderTextColor="#9AA29C"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                textContentType="username"
                maxLength={30}
                style={[styles.nameInput, styles.weightInput]}
                accessibilityLabel="Username"
              />
              {authMode === 'signup' && (
                <Pressable
                  style={styles.shuffleButton}
                  onPress={() => setAuthUsername(randomUsername())}
                  accessibilityRole="button"
                  accessibilityLabel="Suggest another username"
                >
                  <Text style={styles.shuffleText}>↻</Text>
                </Pressable>
              )}
            </View>

            <Text style={styles.fieldLabel}>{authMode === 'signup' ? 'Choose a 6-digit PIN' : 'PIN'}</Text>
            <TextInput
              value={authPin}
              onChangeText={(t) => { setAuthPin(t.replace(/\D/g, '').slice(0, 6)); setAuthError(''); }}
              placeholder="••••••"
              placeholderTextColor="#9AA29C"
              secureTextEntry
              keyboardType="number-pad"
              inputMode="numeric"
              maxLength={6}
              autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
              textContentType={authMode === 'signup' ? 'newPassword' : 'password'}
              onSubmitEditing={authMode === 'login' ? submitAuth : undefined}
              style={[styles.nameInput, styles.pinInput]}
              accessibilityLabel="6-digit PIN"
            />
            {authMode === 'signup' && (
              <>
                <Text style={styles.fieldLabel}>Confirm PIN</Text>
                <TextInput
                  value={authPinConfirm}
                  onChangeText={(t) => { setAuthPinConfirm(t.replace(/\D/g, '').slice(0, 6)); setAuthError(''); }}
                  placeholder="••••••"
                  placeholderTextColor="#9AA29C"
                  secureTextEntry
                  keyboardType="number-pad"
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="new-password"
                  textContentType="newPassword"
                  onSubmitEditing={submitAuth}
                  style={[styles.nameInput, styles.pinInput]}
                  accessibilityLabel="Confirm PIN"
                />
              </>
            )}

            {authError ? <Text style={styles.weightError}>{authError}</Text> : null}

            <View style={styles.weightActions}>
              <Pressable style={[styles.primaryButton, authBusy && { opacity: 0.6 }]} onPress={submitAuth} disabled={authBusy}>
                <Text style={styles.primaryButtonText}>
                  {authBusy ? 'Please wait…' : authMode === 'signup' ? 'Create account' : 'Sign in'}
                </Text>
              </Pressable>
              <Pressable style={styles.cancelButton} onPress={() => setAuthMode(null)} disabled={authBusy}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            </View>
            <Pressable
              onPress={() => openAuth(authMode === 'signup' ? 'login' : 'signup')}
              disabled={authBusy}
              style={{ alignSelf: 'center', marginTop: 12 }}
              hitSlop={6}
            >
              <Text style={styles.calorieNoteText}>
                {authMode === 'signup' ? 'Already have an account? ' : 'New here? '}
                <Text style={styles.calorieNoteLink}>{authMode === 'signup' ? 'Sign in' : 'Create an account'}</Text>
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={!!selectedRecord} transparent animationType="slide" onRequestClose={() => setSelectedRecord(null)}>
        {selectedRecord && (
          <View style={[styles.detailBackdrop, isWide && styles.detailBackdropWide]}>
            <View style={[styles.detailCard, { paddingBottom: 20 + bottomInset }, isWide && styles.detailCardWide]}>
              <View style={styles.detailHandle} />
              <View style={styles.panelHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.eyebrow}>{selectedRecord.completedAt ? 'WALK COMPLETED' : 'SAVED ROUTE'}</Text>
                  <Text style={styles.detailTitle}>{selectedRecord.name}</Text>
                </View>
                <Pressable onPress={() => setSelectedRecord(null)}>
                  <Text style={styles.closeX}>×</Text>
                </Pressable>
              </View>
              <View style={styles.detailStats}>
                <View><Text style={styles.detailValue}>{formatDistance(selectedRecord.distanceKm)}</Text><Text style={styles.detailLabel}>Distance</Text></View>
                <View><Text style={styles.detailValue}>{formatDuration(selectedRecord.durationMin)}</Text><Text style={styles.detailLabel}>Time</Text></View>
                <View><Text style={styles.detailValue}>{(selectedRecord.estimatedSteps ?? estimatedStepsForDistance(selectedRecord.distanceKm)).toLocaleString()}</Text><Text style={styles.detailLabel}>Est. steps</Text></View>
                <View><Text style={styles.detailValue}>{estimatedCalories(selectedRecord.durationMin, weightKg).toLocaleString()}</Text><Text style={styles.detailLabel}>Est. kcal</Text></View>
              </View>
              <Text style={styles.detailDate}>
                {selectedRecord.completedAt ? `Walked ${formatDateTime(selectedRecord.completedAt)}` : `Saved ${formatDateTime(selectedRecord.createdAt)}`}
              </Text>
              <View style={styles.detailActions}>
                <Pressable style={styles.secondaryButton} onPress={() => { loadRecord(selectedRecord); }}>
                  <Text style={styles.secondaryButtonText}>Open on map</Text>
                </Pressable>
                <Pressable style={styles.deleteButton} onPress={() => deleteRecord(selectedRecord.id)}>
                  <Text style={styles.deleteText}>Delete</Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}
      </Modal>

      {permissionDenied && tab === 'plan' && (
        <View style={[styles.permissionBanner, { top: topInset + 56 }, isWide && styles.permissionBannerWide]} pointerEvents="none">
          <Text style={styles.permissionText}>Location access is off. You can still plan routes by tapping the map.</Text>
        </View>
      )}

      {toast && (
        <View style={[styles.toast, { top: topInset }]} pointerEvents="none">
          <Text style={styles.toastTitle}>{toast.title}</Text>
          <Text style={styles.toastText}>{toast.message}</Text>
        </View>
      )}
    </View>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

type ActivityWindow = { label: string; walks: number; steps: number; calories: number };
type ActivityStats = ReturnType<typeof activityStats>;

function activityStats(history: RouteRecord[], weightKg: number, now = new Date()) {
  const walks = history
    .filter((r) => !!r.completedAt)
    .map((r) => ({
      at: new Date(r.completedAt!).getTime(),
      km: r.distanceKm,
      min: r.durationMin,
      steps: r.estimatedSteps ?? estimatedStepsForDistance(r.distanceKm),
      calories: estimatedCalories(r.durationMin, weightKg),
    }));
  const today = startOfDay(now);
  const firstWalk = walks.length ? Math.min(...walks.map((w) => w.at)) : null;
  // Calendar days from the first logged walk up to and including today.
  const daysTracked = firstWalk === null ? 0 : Math.max(1, Math.round((today - startOfDay(new Date(firstWalk))) / DAY_MS) + 1);
  const n = walks.length;

  const summarise = (label: string, since: number): ActivityWindow => {
    const inWindow = walks.filter((w) => w.at >= since);
    return {
      label,
      walks: inWindow.length,
      steps: inWindow.reduce((sum, w) => sum + w.steps, 0),
      calories: inWindow.reduce((sum, w) => sum + w.calories, 0),
    };
  };

  const totalSteps = walks.reduce((sum, w) => sum + w.steps, 0);
  return {
    walks: n,
    firstWalk,
    // A week or month that hasn't fully elapsed yet counts as one, so a first walk reads as 1/week, not 7/week.
    perDay: daysTracked ? n / daysTracked : 0,
    perWeek: daysTracked ? n / Math.max(1, daysTracked / 7) : 0,
    perMonth: daysTracked ? n / Math.max(1, daysTracked / 30.44) : 0,
    distanceKm: walks.reduce((sum, w) => sum + w.km, 0),
    durationMin: walks.reduce((sum, w) => sum + w.min, 0),
    steps: totalSteps,
    calories: walks.reduce((sum, w) => sum + w.calories, 0),
    stepsPerWalk: n ? Math.round(totalSteps / n) : 0,
    recent: [
      summarise('Today', today),
      summarise('Last 7 days', today - 6 * DAY_MS),
      summarise('Last 30 days', today - 29 * DAY_MS),
    ],
  };
}

function formatAverage(value: number) {
  if (value === 0) return '0';
  return value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value).toLocaleString();
}

function ProfileStats({
  stats,
  columns,
  weightLabel,
  usingAverageWeight,
  onChangeWeight,
  onPlan,
}: {
  stats: ActivityStats;
  columns: 2 | 3;
  weightLabel: string;
  usingAverageWeight: boolean;
  onChangeWeight: () => void;
  onPlan: () => void;
}) {
  const cell = { flexBasis: columns === 3 ? '31%' : '46%' } as const;
  const tile = (value: string, label: string) => (
    <View key={label} style={[styles.statTile, cell]}>
      <Text style={styles.summaryValue} numberOfLines={1}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );

  return (
    <>
      {stats.walks === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyIcon}>◌</Text>
          <Text style={styles.emptyTitle}>No activity yet</Text>
          <Text style={styles.emptyText}>Log a walk and your averages, steps and calories will show up here.</Text>
          <Pressable style={styles.primaryButtonSmall} onPress={onPlan}>
            <Text style={styles.primaryButtonText}>Plan a walk</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Text style={styles.sectionTitle}>Average walks</Text>
          <View style={styles.averagesCard}>
            {[
              { value: stats.perDay, unit: 'per day' },
              { value: stats.perWeek, unit: 'per week' },
              { value: stats.perMonth, unit: 'per month' },
            ].map((a, i) => (
              <React.Fragment key={a.unit}>
                {i > 0 && <View style={styles.statDivider} />}
                <View style={styles.averageItem}>
                  <Text style={styles.averageValue}>{formatAverage(a.value)}</Text>
                  <Text style={styles.summaryLabel}>{a.unit}</Text>
                </View>
              </React.Fragment>
            ))}
          </View>
          {stats.firstWalk !== null && (
            <Text style={styles.statsFootnote}>
              Since your first logged walk on {new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(stats.firstWalk)}
            </Text>
          )}

          <Text style={[styles.sectionTitle, styles.sectionSpacing]}>Totals</Text>
          <View style={styles.statGrid}>
            {tile(stats.walks.toLocaleString(), 'Walks done')}
            {tile(formatDistance(stats.distanceKm), 'Distance')}
            {tile(stats.steps.toLocaleString(), 'Est. steps')}
            {tile(stats.calories.toLocaleString(), 'Est. kcal')}
            {tile(formatDuration(stats.durationMin), 'Time walking')}
            {tile(stats.stepsPerWalk.toLocaleString(), 'Avg steps per walk')}
          </View>

          <Text style={[styles.sectionTitle, styles.sectionSpacing]}>Recent</Text>
          <View style={styles.recentCard}>
            {stats.recent.map((w, i) => (
              <View key={w.label} style={[styles.recentRow, i > 0 && styles.recentRowBorder]}>
                <Text style={styles.recentLabel}>{w.label}</Text>
                <Text style={styles.recentValue} numberOfLines={1}>
                  {w.walks} {w.walks === 1 ? 'walk' : 'walks'} · {w.steps.toLocaleString()} steps · {w.calories.toLocaleString()} kcal
                </Text>
              </View>
            ))}
          </View>
        </>
      )}

      <Text style={[styles.sectionTitle, styles.sectionSpacing]}>Your weight</Text>
      <View style={styles.weightCard}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.routeName}>{weightLabel}</Text>
          <Text style={styles.routeMeta}>
            {usingAverageWeight ? 'Add your weight for more accurate calories.' : 'Used for calorie estimates.'} Stored on this device only.
          </Text>
        </View>
        <Pressable style={styles.closeButton} onPress={onChangeWeight}>
          <Text style={styles.closeText}>{usingAverageWeight ? 'Add' : 'Change'}</Text>
        </Pressable>
      </View>
    </>
  );
}

const TABS: { key: Tab; icon: string; label: string }[] = [
  { key: 'plan', icon: '⌁', label: 'Plan' },
  { key: 'routes', icon: '◷', label: 'Routes' },
  { key: 'profile', icon: '◉', label: 'Profile' },
];

function TabBar({ active, onChange, style }: { active: Tab; onChange: (tab: Tab) => void; style: any }) {
  return (
    <View style={style}>
      {TABS.map((t) => (
        <Pressable
          key={t.key}
          style={styles.tabItem}
          onPress={() => onChange(t.key)}
          accessibilityRole="tab"
          accessibilityState={{ selected: active === t.key }}
        >
          <Text style={[styles.tabIcon, active === t.key && styles.tabActive]}>{t.icon}</Text>
          <Text style={[styles.tabLabel, active === t.key && styles.tabActive]}>{t.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function RouteCard({
  record,
  onPress,
  onDelete,
  saved,
  weightKg,
}: {
  record: RouteRecord;
  onPress: () => void;
  onDelete: () => void;
  saved?: boolean;
  weightKg: number;
}) {
  return (
    <Pressable style={styles.routeCard} onPress={onPress}>
      <View style={styles.routeIconWrap}>
        <Text style={styles.routeIcon}>{saved ? '♡' : '✓'}</Text>
      </View>
      <View style={styles.routeCardBody}>
        <Text style={styles.routeName} numberOfLines={1}>{record.name}</Text>
        <Text style={styles.routeMeta}>
          {saved ? `Saved ${formatDateTime(record.createdAt)}` : formatDateTime(record.completedAt)}
        </Text>
        <View style={styles.routeMetrics}>
          <Text style={styles.routeMetric}>{formatDistance(record.distanceKm)}</Text>
          <Text style={styles.metricDot}>·</Text>
          <Text style={styles.routeMetric}>{formatDuration(record.durationMin)}</Text>
          <Text style={styles.metricDot}>·</Text>
          <Text style={styles.routeMetric}>{(record.estimatedSteps ?? estimatedStepsForDistance(record.distanceKm)).toLocaleString()} steps</Text>
          <Text style={styles.metricDot}>·</Text>
          <Text style={styles.routeMetric}>{estimatedCalories(record.durationMin, weightKg).toLocaleString()} kcal</Text>
        </View>
      </View>
      <Pressable onPress={onDelete} hitSlop={10} style={styles.moreButton}>
        <Text style={styles.moreText}>•••</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  planScreen: { flex: 1, backgroundColor: COLORS.bg },
  routesScreen: { flex: 1, backgroundColor: COLORS.bg },
  contentWidth: { width: '100%', maxWidth: 760, alignSelf: 'center' },
  topOverlay: {
    position: 'absolute', left: 18, right: 18,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  topOverlayWide: { left: 436 },
  brandPill: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.95)',
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 24,
    shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4,
  },
  brandDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.accent, marginRight: 8 },
  brand: { fontSize: 15, fontWeight: '800', color: COLORS.ink, letterSpacing: -0.2 },
  iconButton: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.card, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4,
  },
  icon: { fontSize: 20, color: COLORS.ink },
  mapActions: { position: 'absolute', right: 18, gap: 10 },
  floatingButton: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: COLORS.card, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 5,
  },
  floatingIcon: { fontSize: 23, color: COLORS.ink },
  bottomPanel: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: COLORS.bg,
    borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 18, paddingTop: 9,
    paddingBottom: 12,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 20, shadowOffset: { width: 0, height: -6 }, elevation: 12,
  },
  sidePanel: {
    left: 18, bottom: 'auto', right: 'auto', width: 400,
    borderRadius: 28, paddingTop: 20, boxShadow: '0 8px 28px rgba(0,0,0,0.16)',
  },
  panelScroll: { flexGrow: 0, flexShrink: 1 },
  handleArea: { alignSelf: 'stretch', alignItems: 'center', paddingTop: 6, paddingBottom: 14, marginTop: -6, cursor: 'grab' } as any,
  handle: { width: 38, height: 4, borderRadius: 2, backgroundColor: '#CBD0CA' },
  collapsedRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 4 },
  collapsedSummary: { fontSize: 16, fontWeight: '800', color: COLORS.ink },
  collapsedButton: { backgroundColor: COLORS.accentSoft, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9 },
  collapsedButtonText: { fontSize: 13, fontWeight: '800', color: COLORS.accent },
  panelHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  minimiseButton: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.line,
    alignItems: 'center', justifyContent: 'center',
  },
  minimiseText: { fontSize: 18, lineHeight: 20, color: COLORS.ink, fontWeight: '700', marginTop: -4 },
  panelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  eyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 1.5, color: COLORS.muted, marginBottom: 4 },
  title: { fontSize: 27, fontWeight: '800', letterSpacing: -0.8, color: COLORS.ink },
  clearText: { color: COLORS.danger, fontWeight: '700' },
  helperRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 5, marginBottom: 10 },
  helper: { flex: 1, color: COLORS.muted, fontSize: 13 },
  pointsRow: { marginBottom: 10 },
  pointChip: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.card, borderRadius: 18,
    paddingVertical: 6, paddingLeft: 7, paddingRight: 9, marginRight: 7,
    borderWidth: 1, borderColor: COLORS.line,
  },
  chipNumber: { width: 25, height: 25, borderRadius: 13, backgroundColor: '#EEF1ED', alignItems: 'center', justifyContent: 'center', marginRight: 6 },
  chipNumberStart: { backgroundColor: COLORS.accent },
  chipNumberText: { fontSize: 11, fontWeight: '800', color: COLORS.ink },
  pointChipText: { fontSize: 12, fontWeight: '700', color: COLORS.ink, marginRight: 7 },
  chipRemove: { fontSize: 17, color: COLORS.muted, lineHeight: 17 },
  statsCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.card, borderRadius: 18,
    padding: 13, borderWidth: 1, borderColor: COLORS.line,
  },
  statsCardCompact: { padding: 11 },
  statDividerCompact: { marginHorizontal: 6 },
  distanceCompact: { fontSize: 17 },
  timeCompact: { fontSize: 15 },
  stat: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  calorieNote: { marginTop: 7, alignSelf: 'flex-start' },
  calorieNoteText: { fontSize: 11, color: COLORS.muted },
  calorieNoteLink: { color: COLORS.accent, fontWeight: '800' },
  collapsedDetail: { fontSize: 12, fontWeight: '700', color: COLORS.muted, marginTop: 2 },
  weightRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  weightInput: { flex: 1, minWidth: 0 },
  unitToggle: { flexDirection: 'row', backgroundColor: COLORS.bg, borderRadius: 14, padding: 3, borderWidth: 1, borderColor: COLORS.line },
  unitOption: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 11 },
  unitOptionActive: { backgroundColor: COLORS.accent },
  unitText: { fontSize: 14, fontWeight: '800', color: COLORS.muted },
  unitTextActive: { color: COLORS.white },
  weightActions: { gap: 8, marginTop: 14 },
  profileSection: { marginBottom: 24 },
  accountCard: { backgroundColor: COLORS.card, borderRadius: 18, borderWidth: 1, borderColor: COLORS.line, padding: 15 },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: COLORS.accent, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: COLORS.white, fontSize: 18, fontWeight: '800' },
  accountNote: { fontSize: 12, lineHeight: 17, color: COLORS.muted, marginTop: 8 },
  deleteLink: { fontSize: 12, fontWeight: '700', color: COLORS.danger },
  deleteConfirm: { marginTop: 12, padding: 12, borderRadius: 14, backgroundColor: '#FBF1EF' },
  deleteConfirmText: { fontSize: 12, lineHeight: 17, color: COLORS.danger, fontWeight: '600' },
  fieldLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, color: COLORS.muted, marginBottom: 6, marginTop: 12, textTransform: 'uppercase' },
  pinInput: { letterSpacing: 6, fontSize: 18 },
  shuffleButton: {
    width: 48, height: 48, borderRadius: 14, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.bg,
    alignItems: 'center', justifyContent: 'center',
  },
  shuffleText: { fontSize: 20, color: COLORS.ink, fontWeight: '700' },
  weightError: { fontSize: 12, color: COLORS.danger, marginTop: 8 },
  statLabel: { fontSize: 8.5, fontWeight: '800', letterSpacing: 1, color: COLORS.muted, marginBottom: 2 },
  distance: { fontSize: 20, fontWeight: '800', color: COLORS.ink, letterSpacing: -0.5 },
  time: { fontSize: 17, fontWeight: '800', color: COLORS.ink },
  statDivider: { width: 1, height: 34, backgroundColor: COLORS.line, marginHorizontal: 8 },
  routeStatus: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.accent },
  statusDotBusy: { backgroundColor: COLORS.warm },
  statusText: { fontSize: 9, fontWeight: '700', color: COLORS.muted },
  warning: { fontSize: 11, color: '#8C6C31', marginTop: 7 },
  segmentRow: { marginTop: 8, marginBottom: 1 },
  segmentChip: { backgroundColor: COLORS.accentSoft, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 7, marginRight: 7 },
  segmentLabel: { fontSize: 8, fontWeight: '800', color: COLORS.muted, letterSpacing: 0.7 },
  segmentValue: { fontSize: 10, fontWeight: '800', color: COLORS.ink, marginTop: 2 },
  actionRow: { flexDirection: 'row', gap: 9, marginTop: 10 },
  secondaryButton: {
    flex: 1, minHeight: 46, borderRadius: 15, borderWidth: 1, borderColor: COLORS.line,
    backgroundColor: COLORS.card, alignItems: 'center', justifyContent: 'center',
  },
  secondaryButtonText: { color: COLORS.ink, fontSize: 14, fontWeight: '800' },
  primaryButton: {
    flex: 1.45, minHeight: 46, borderRadius: 15, backgroundColor: COLORS.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  primaryButtonText: { color: COLORS.white, fontSize: 14, fontWeight: '800' },
  tabBar: {
    marginTop: 11, paddingTop: 8, borderTopWidth: 1, borderTopColor: COLORS.line,
    flexDirection: 'row', justifyContent: 'space-around',
  },
  routesTabBar: {
    paddingHorizontal: 18, paddingTop: 8,
    borderTopWidth: 1, borderTopColor: COLORS.line, flexDirection: 'row', justifyContent: 'space-around', backgroundColor: COLORS.bg,
  },
  tabItem: { alignItems: 'center', minWidth: 72 },
  sectionSpacing: { marginTop: 24 },
  averagesCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.card, borderRadius: 18,
    paddingVertical: 15, paddingHorizontal: 12, borderWidth: 1, borderColor: COLORS.line,
  },
  averageItem: { flex: 1, alignItems: 'center' },
  averageValue: { fontSize: 24, fontWeight: '800', color: COLORS.accent, letterSpacing: -0.5 },
  statsFootnote: { fontSize: 11, color: COLORS.muted, marginTop: 7 },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statTile: { flexGrow: 1, backgroundColor: COLORS.card, borderRadius: 17, padding: 13, borderWidth: 1, borderColor: COLORS.line },
  recentCard: { backgroundColor: COLORS.card, borderRadius: 18, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 14 },
  recentRow: { paddingVertical: 12 },
  recentRowBorder: { borderTopWidth: 1, borderTopColor: COLORS.line },
  recentLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1, color: COLORS.muted, textTransform: 'uppercase' },
  recentValue: { fontSize: 14, fontWeight: '700', color: COLORS.ink, marginTop: 3 },
  weightCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: COLORS.card, borderRadius: 18,
    padding: 14, borderWidth: 1, borderColor: COLORS.line,
  },
  tabIcon: { fontSize: 20, lineHeight: 24, height: 24, color: '#9AA29C', marginBottom: 1, textAlign: 'center' },
  tabLabel: { fontSize: 10, color: '#8B938D', fontWeight: '700' },
  tabActive: { color: COLORS.accent },
  routesHeader: { paddingHorizontal: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  closeButton: { paddingHorizontal: 15, paddingVertical: 9, backgroundColor: COLORS.card, borderRadius: 17, borderWidth: 1, borderColor: COLORS.line },
  closeText: { fontSize: 12, fontWeight: '800', color: COLORS.ink },
  summaryRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 18, marginTop: 18 },
  summaryRowCompact: { flexWrap: 'wrap' },
  summaryCardCompact: { flexBasis: '45%', flexGrow: 1 },
  summaryCard: { flex: 1, backgroundColor: COLORS.card, borderRadius: 17, padding: 13, borderWidth: 1, borderColor: COLORS.line },
  summaryValue: { fontSize: 19, fontWeight: '800', color: COLORS.ink },
  summaryLabel: { fontSize: 9, fontWeight: '700', color: COLORS.muted, marginTop: 2 },
  routesList: { paddingHorizontal: 18, paddingTop: 24, paddingBottom: 100 },
  sectionTitle: { fontSize: 12, fontWeight: '800', letterSpacing: 1.1, color: COLORS.muted, marginBottom: 9, textTransform: 'uppercase' },
  routeCard: {
    backgroundColor: COLORS.card, borderRadius: 18, borderWidth: 1, borderColor: COLORS.line,
    padding: 12, flexDirection: 'row', alignItems: 'center', marginBottom: 8,
  },
  routeIconWrap: { width: 40, height: 40, borderRadius: 14, backgroundColor: COLORS.accentSoft, alignItems: 'center', justifyContent: 'center', marginRight: 11 },
  routeIcon: { color: COLORS.accent, fontSize: 18, fontWeight: '800' },
  routeCardBody: { flex: 1, minWidth: 0 },
  routeName: { fontSize: 15, fontWeight: '800', color: COLORS.ink },
  routeMeta: { fontSize: 10, color: COLORS.muted, marginTop: 2 },
  routeMetrics: { flexDirection: 'row', alignItems: 'center', marginTop: 7 },
  routeMetric: { fontSize: 10, color: COLORS.ink, fontWeight: '700' },
  metricDot: { color: '#B3BAB4', marginHorizontal: 5 },
  moreButton: { width: 34, height: 40, alignItems: 'center', justifyContent: 'center' },
  moreText: { color: COLORS.muted, fontSize: 12, letterSpacing: 1 },
  emptyCard: { backgroundColor: COLORS.card, borderRadius: 22, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: COLORS.line },
  emptyIcon: { fontSize: 36, color: COLORS.accent, marginBottom: 8 },
  emptyTitle: { fontSize: 17, fontWeight: '800', color: COLORS.ink },
  emptyText: { textAlign: 'center', fontSize: 12, lineHeight: 18, color: COLORS.muted, marginTop: 6, marginBottom: 16 },
  primaryButtonSmall: { paddingHorizontal: 18, paddingVertical: 11, borderRadius: 13, backgroundColor: COLORS.accent },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(13,22,17,0.35)', justifyContent: 'center', padding: 20 },
  modalBackdropWide: { alignItems: 'center' },
  modalCard: { backgroundColor: COLORS.card, borderRadius: 24, padding: 22, width: '100%', maxWidth: 440 },
  modalTitle: { fontSize: 23, fontWeight: '800', color: COLORS.ink, letterSpacing: -0.4 },
  modalSubtitle: { color: COLORS.muted, fontSize: 13, lineHeight: 19, marginTop: 5, marginBottom: 14 },
  nameInput: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: COLORS.ink, backgroundColor: COLORS.bg },
  modalActions: { flexDirection: 'row', gap: 9, marginTop: 13 },
  cancelButton: { flex: 1, minHeight: 46, borderRadius: 14, backgroundColor: COLORS.bg, alignItems: 'center', justifyContent: 'center' },
  cancelText: { fontWeight: '800', color: COLORS.ink },
  detailBackdrop: { flex: 1, backgroundColor: 'rgba(13,22,17,0.28)', justifyContent: 'flex-end' },
  detailCard: { backgroundColor: COLORS.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 18 },
  detailBackdropWide: { justifyContent: 'center', alignItems: 'center', padding: 20 },
  detailCardWide: { width: '100%', maxWidth: 520, borderRadius: 28, paddingBottom: 20 },
  detailHandle: { width: 38, height: 4, borderRadius: 2, backgroundColor: '#CBD0CA', alignSelf: 'center', marginBottom: 17 },
  detailTitle: { fontSize: 26, fontWeight: '800', color: COLORS.ink, letterSpacing: -0.7 },
  closeX: { fontSize: 28, color: COLORS.muted, padding: 5 },
  detailStats: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: COLORS.card, borderRadius: 18, padding: 15, marginTop: 17, borderWidth: 1, borderColor: COLORS.line },
  detailValue: { fontSize: 18, fontWeight: '800', color: COLORS.ink },
  detailLabel: { fontSize: 9, color: COLORS.muted, fontWeight: '700', marginTop: 3 },
  detailDate: { fontSize: 12, color: COLORS.muted, marginTop: 13 },
  detailActions: { flexDirection: 'row', gap: 9, marginTop: 16 },
  deleteButton: { paddingHorizontal: 17, minHeight: 46, borderRadius: 15, backgroundColor: '#F4E5E3', alignItems: 'center', justifyContent: 'center' },
  deleteText: { color: COLORS.danger, fontWeight: '800' },
  permissionBannerWide: { left: 436, right: 18 },
  permissionBanner: { position: 'absolute', left: 18, right: 18, backgroundColor: '#FFF7DF', borderRadius: 14, padding: 10, borderWidth: 1, borderColor: '#E9D8A7' },
  permissionText: { fontSize: 11, lineHeight: 16, color: '#6F5725', textAlign: 'center', fontWeight: '600' },
  toast: {
    position: 'absolute', alignSelf: 'center', maxWidth: 420, marginHorizontal: 18,
    backgroundColor: COLORS.ink, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 10,
  },
  toastTitle: { color: COLORS.white, fontSize: 14, fontWeight: '800' },
  toastText: { color: '#C9D2CC', fontSize: 12, marginTop: 2 },
});
