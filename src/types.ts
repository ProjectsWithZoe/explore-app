export type Coordinate = { latitude: number; longitude: number };
export type RoutePoint = Coordinate & { id: string; label: string };
export type Region = Coordinate & { latitudeDelta: number; longitudeDelta: number };
export type RouteRecord = {
  id: number;
  name: string;
  createdAt: string;
  completedAt?: string | null;
  saved: number;
  distanceKm: number;
  durationMin: number;
  estimatedSteps: number;
  points: RoutePoint[];
  geometry: Coordinate[];
};
export type NewRouteRecord = Omit<RouteRecord, 'id'>;

export type WalkMapHandle = {
  animateTo: (coordinate: Coordinate) => void;
};

export type WalkMapProps = {
  initialRegion: Region;
  points: RoutePoint[];
  geometry: Coordinate[];
  userLocation: Coordinate | null;
  onPress: (coordinate: Coordinate) => void;
  accentColor: string;
  stopColor: string;
  /** Height of UI covering the bottom of the map, so map chrome can sit above it. */
  bottomInset?: number;
};

export type WeightUnit = 'kg' | 'lb';
export type Profile = {
  /** null means the user chose the 70 kg average. */
  weightKg: number | null;
  unit: WeightUnit;
};
