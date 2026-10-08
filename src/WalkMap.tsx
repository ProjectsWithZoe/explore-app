import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import type { WalkMapHandle, WalkMapProps } from './types';

// Native (iOS / Android) map backed by react-native-maps.
const WalkMap = forwardRef<WalkMapHandle, WalkMapProps>(function WalkMap(
  { initialRegion, points, geometry, userLocation, onPress, accentColor, stopColor },
  ref,
) {
  const mapRef = useRef<MapView>(null);

  useImperativeHandle(ref, () => ({
    animateTo(coordinate) {
      mapRef.current?.animateToRegion({ ...coordinate, latitudeDelta: 0.018, longitudeDelta: 0.018 }, 450);
    },
  }));

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      initialRegion={initialRegion}
      mapType="standard"
      showsUserLocation={!!userLocation}
      showsMyLocationButton={false}
      showsCompass={false}
      onPress={(event) => onPress(event.nativeEvent.coordinate)}
    >
      {points.map((point, index) => (
        <Marker
          key={point.id}
          coordinate={point}
          title={index === 0 ? 'Start' : `Stop ${index + 1}`}
          description={`${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`}
        >
          <View style={[styles.marker, { backgroundColor: index === 0 ? accentColor : stopColor }]}>
            <Text style={styles.markerText}>{index + 1}</Text>
          </View>
        </Marker>
      ))}
      {geometry.length > 1 && (
        <Polyline coordinates={geometry} strokeWidth={5} strokeColor={accentColor} lineCap="round" lineJoin="round" />
      )}
    </MapView>
  );
});

export default WalkMap;

const styles = StyleSheet.create({
  marker: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#FFFFFF' },
  markerText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
});
