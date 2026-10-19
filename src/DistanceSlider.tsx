import React, { useMemo, useRef } from 'react';
import { PanResponder, Platform, StyleSheet, View } from 'react-native';

type Props = {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  color: string;
  trackColor: string;
  accessibilityLabel: string;
  formatValue: (value: number) => string;
};

const THUMB = 26;

// A small dependency-free slider (React Native core no longer ships one). Drag or tap anywhere on the track;
// arrow keys on the web and the screen-reader adjust gesture step it.
export default function DistanceSlider({ value, min, max, step, onChange, color, trackColor, accessibilityLabel, formatValue }: Props) {
  const trackRef = useRef<View>(null);
  const track = useRef({ x: 0, width: 1 });
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };

  const snap = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const setFromPageX = (pageX: number) => {
    const ratio = (pageX - track.current.x - THUMB / 2) / Math.max(1, track.current.width - THUMB);
    const next = snap(min + Math.min(1, Math.max(0, ratio)) * (max - min));
    if (next !== latest.current.value) latest.current.onChange(next);
  };

  const pan = useMemo(() => PanResponder.create({
    // Claim the gesture before the planner's ScrollView or the sheet can.
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      const pageX = e.nativeEvent.pageX;
      trackRef.current?.measureInWindow((x, _y, width) => {
        track.current = { x, width };
        setFromPageX(pageX);
      });
    },
    onPanResponderMove: (_e, g) => setFromPageX(g.moveX),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [min, max, step]);

  const nudge = (direction: 1 | -1) => latest.current.onChange(snap(latest.current.value + direction * step));
  const ratio = (value - min) / (max - min);
  const webKeys = Platform.OS === 'web'
    ? {
        tabIndex: 0,
        onKeyDown: (e: any) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); nudge(1); }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); nudge(-1); }
          if (e.key === 'Home') { e.preventDefault(); onChange(min); }
          if (e.key === 'End') { e.preventDefault(); onChange(max); }
        },
      }
    : {};

  return (
    <View
      ref={trackRef}
      {...pan.panHandlers}
      {...(webKeys as any)}
      style={styles.hitArea}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={formatValue(value)}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
    >
      <View style={[styles.track, { backgroundColor: trackColor }]} pointerEvents="none">
        <View style={[styles.fill, { backgroundColor: color, width: `${ratio * 100}%` }]} />
      </View>
      <View
        pointerEvents="none"
        style={[styles.thumb, { borderColor: color, left: `${ratio * 100}%`, marginLeft: -ratio * THUMB }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // touch-action stops the browser scrolling or zooming the page while dragging.
  hitArea: { height: 40, justifyContent: 'center', ...(Platform.OS === 'web' ? { cursor: 'pointer', touchAction: 'none', userSelect: 'none' } : null) } as any,
  track: { height: 6, borderRadius: 3, marginHorizontal: THUMB / 2, overflow: 'hidden' },
  fill: { height: 6 },
  thumb: {
    position: 'absolute', top: 7, width: THUMB, height: THUMB, borderRadius: THUMB / 2,
    backgroundColor: '#FFFFFF', borderWidth: 3, boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
  } as any,
});
