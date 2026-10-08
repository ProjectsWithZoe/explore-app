import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Coordinate, Region, WalkMapHandle, WalkMapProps } from './types';

// Web map backed by MapLibre GL (react-native-maps has no web support).
// Uses Mapbox Outdoors when EXPO_PUBLIC_MAPBOX_TOKEN is set, otherwise OpenFreeMap (free, no key).

const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
const MAPBOX_STYLE = 'mapbox/outdoors-v12';
const FALLBACK_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const ROUTE_SOURCE = 'walk-route';

// MapLibre doesn't understand mapbox:// URLs, so rewrite them to the Mapbox HTTP APIs.
function transformMapboxUrl(url: string): { url: string } {
  if (!MAPBOX_TOKEN || !url.startsWith('mapbox://')) return { url };
  const withToken = (u: string) => `${u}${u.includes('?') ? '&' : '?'}access_token=${MAPBOX_TOKEN}`;
  const path = url.slice('mapbox://'.length);
  if (path.startsWith('styles/')) return { url: withToken(`https://api.mapbox.com/styles/v1/${path.slice(7)}`) };
  if (path.startsWith('fonts/')) return { url: withToken(`https://api.mapbox.com/fonts/v1/${path.slice(6)}`) };
  if (path.startsWith('sprites/')) {
    // mapbox://sprites/mapbox/outdoors-v12@2x.json -> /styles/v1/mapbox/outdoors-v12/sprite@2x.json
    const m = path.slice(8).match(/^(.*?)((?:@\dx)?\.(?:json|png))?$/)!;
    return { url: withToken(`https://api.mapbox.com/styles/v1/${m[1]}/sprite${m[2] ?? ''}`) };
  }
  // Tile sources: mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2
  return { url: withToken(`https://api.mapbox.com/v4/${path}.json?secure`) };
}

// Drop Mapbox-only style fields that MapLibre's style validator rejects.
function cleanMapboxStyle(_previous: unknown, next: maplibregl.StyleSpecification) {
  const { projection, fog, imports, ...rest } = next as any;
  return rest as maplibregl.StyleSpecification;
}

function zoomForRegion(region: Region) {
  const zoom = Math.log2(360 / Math.max(region.longitudeDelta, 0.0001));
  return Math.min(18, Math.max(3, zoom));
}

function markerElement(n: number, color: string, title: string) {
  const el = document.createElement('div');
  el.title = title;
  el.textContent = String(n);
  el.style.cssText = `width:32px;height:32px;border-radius:16px;background:${color};border:3px solid #fff;box-sizing:border-box;display:flex;align-items:center;justify-content:center;color:#fff;font:900 11px system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.3);cursor:default`;
  return el;
}

function userDotElement() {
  const el = document.createElement('div');
  el.style.cssText = 'width:18px;height:18px;border-radius:9px;background:#2F80ED;border:3px solid #fff;box-sizing:border-box;box-shadow:0 0 0 6px rgba(47,128,237,.2)';
  return el;
}

function routeData(geometry: Coordinate[]): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: geometry.map((c) => [c.longitude, c.latitude]) },
  };
}

const WalkMap = forwardRef<WalkMapHandle, WalkMapProps>(function WalkMap(
  { initialRegion, points, geometry, userLocation, onPress, accentColor, stopColor, bottomInset = 0 },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  useImperativeHandle(ref, () => ({
    animateTo(coordinate) {
      mapRef.current?.flyTo({ center: [coordinate.longitude, coordinate.latitude], zoom: 15.5, duration: 600 });
    },
  }));

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      transformRequest: transformMapboxUrl,
      center: [initialRegion.longitude, initialRegion.latitude],
      zoom: zoomForRegion(initialRegion),
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.setStyle(MAPBOX_TOKEN ? `mapbox://styles/${MAPBOX_STYLE}` : FALLBACK_STYLE, {
      transformStyle: MAPBOX_TOKEN ? cleanMapboxStyle : undefined,
    });
    mapRef.current = map;

    map.on('click', (e) => onPressRef.current({ latitude: e.lngLat.lat, longitude: e.lngLat.lng }));
    map.on('load', () => {
      map.addSource(ROUTE_SOURCE, { type: 'geojson', data: routeData(geometryRef.current) });
      map.addLayer({
        id: `${ROUTE_SOURCE}-casing`,
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#FFFFFF', 'line-width': 9, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: ROUTE_SOURCE,
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': accentColor, 'line-width': 5 },
      });
    });

    // The container can change size without a window resize (panel layout, orientation).
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the attribution clear of the route panel that overlays the bottom of the map on phones.
  useEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>('.maplibregl-ctrl-bottom-left');
    if (el) el.style.bottom = `${bottomInset}px`;
  }, [bottomInset]);

  // Route line.
  useEffect(() => {
    const source = mapRef.current?.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData(routeData(geometry));
  }, [geometry]);

  // Numbered stop markers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = points.map((point, index) => {
      const el = markerElement(index + 1, index === 0 ? accentColor : stopColor, index === 0 ? 'Start' : `Stop ${index + 1}`);
      el.addEventListener('click', (e) => e.stopPropagation());
      return new maplibregl.Marker({ element: el }).setLngLat([point.longitude, point.latitude]).addTo(map);
    });
  }, [points, accentColor, stopColor]);

  // User location dot.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!userLocation) {
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      return;
    }
    const lngLat: [number, number] = [userLocation.longitude, userLocation.latitude];
    if (userMarkerRef.current) userMarkerRef.current.setLngLat(lngLat);
    else userMarkerRef.current = new maplibregl.Marker({ element: userDotElement() }).setLngLat(lngLat).addTo(map);
  }, [userLocation?.latitude, userLocation?.longitude]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
    </View>
  );
});

export default WalkMap;
