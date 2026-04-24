import { describe, expect, test } from 'bun:test';
import {
  ABSOLUTE_POSITION_LENGTH,
  ABSOLUTE_POSITION_MIN_LENGTH,
  type BuildAbsolutePositionOptions,
  buildAbsolutePosition,
  parseAbsolutePosition,
} from '../src/packets/absolute-position.ts';

/** Build → parse round-trip helper. */
function roundTrip(opts: BuildAbsolutePositionOptions = {}) {
  const buf = buildAbsolutePosition(opts);
  const result = parseAbsolutePosition(buf);
  expect(result).not.toBeNull();
  return result ?? ({} as never);
}

describe('buildAbsolutePosition', () => {
  test('produces correct packet length', () => {
    expect(buildAbsolutePosition().length).toBe(ABSOLUTE_POSITION_LENGTH);
    expect(ABSOLUTE_POSITION_LENGTH).toBe(52);
  });

  test('writes correct header and kind byte', () => {
    const buf = buildAbsolutePosition();
    expect(buf[0]).toBe(0x51);
    expect(buf[9]).toBe(0x4c);
    expect(buf[0x0a]).toBe(0x0b);
  });

  test('writes device ID at 0x21', () => {
    const buf = buildAbsolutePosition({ deviceId: 2 });
    expect(buf[0x21]).toBe(2);
  });

  test('default device ID is 1', () => {
    const buf = buildAbsolutePosition();
    expect(buf[0x21]).toBe(1);
  });

  test('writes track length at 0x24-0x27', () => {
    const buf = buildAbsolutePosition({ trackLength: 300 });
    // 300 = 0x0000012C
    expect(buf[0x24]).toBe(0x00);
    expect(buf[0x25]).toBe(0x00);
    expect(buf[0x26]).toBe(0x01);
    expect(buf[0x27]).toBe(0x2c);
  });

  test('writes playhead at 0x28-0x2b', () => {
    const buf = buildAbsolutePosition({ playhead: 45000 });
    // 45000 = 0x0000AFC8
    expect(buf[0x28]).toBe(0x00);
    expect(buf[0x29]).toBe(0x00);
    expect(buf[0x2a]).toBe(0xaf);
    expect(buf[0x2b]).toBe(0xc8);
  });

  test('writes positive pitch at 0x2c-0x2f', () => {
    const buf = buildAbsolutePosition({ pitch: 3.26 });
    // 3.26 × 100 = 326 = 0x00000146
    expect(buf[0x2c]).toBe(0x00);
    expect(buf[0x2d]).toBe(0x00);
    expect(buf[0x2e]).toBe(0x01);
    expect(buf[0x2f]).toBe(0x46);
  });

  test('writes negative pitch correctly', () => {
    const buf = buildAbsolutePosition({ pitch: -5 });
    // -5 × 100 = -500, as u32: 0xFFFFFE0C
    expect(buf[0x2c]).toBe(0xff);
    expect(buf[0x2d]).toBe(0xff);
    expect(buf[0x2e]).toBe(0xfe);
    expect(buf[0x2f]).toBe(0x0c);
  });

  test('writes BPM × 10 at 0x30-0x31', () => {
    const buf = buildAbsolutePosition({ trackBpm: 128.5 });
    // 128.5 × 10 = 1285 = 0x0505
    expect(buf[0x30]).toBe(0x05);
    expect(buf[0x31]).toBe(0x05);
  });
});

describe('parseAbsolutePosition', () => {
  test('returns null for too-short buffer', () => {
    expect(parseAbsolutePosition(new Uint8Array(47))).toBeNull();
  });

  test('accepts minimum-length buffer (48 bytes, no BPM)', () => {
    const buf = buildAbsolutePosition();
    const trimmed = buf.subarray(0, ABSOLUTE_POSITION_MIN_LENGTH);
    const result = parseAbsolutePosition(trimmed);
    expect(result).not.toBeNull();
    expect(result?.trackBpm).toBe(0); // Too short for BPM
  });

  test('returns null for wrong header magic', () => {
    const buf = buildAbsolutePosition();
    buf[0] = 0x00;
    expect(parseAbsolutePosition(buf)).toBeNull();
  });

  test('returns null for wrong kind byte', () => {
    const buf = buildAbsolutePosition();
    buf[0x0a] = 0x28; // beat kind
    expect(parseAbsolutePosition(buf)).toBeNull();
  });

  test('round-trip: deviceId', () => {
    expect(roundTrip({ deviceId: 1 }).deviceId).toBe(1);
    expect(roundTrip({ deviceId: 4 }).deviceId).toBe(4);
  });

  test('round-trip: deviceName', () => {
    expect(roundTrip({ deviceName: 'CDJ-3000' }).deviceName).toBe('CDJ-3000');
  });

  test('round-trip: trackLength', () => {
    expect(roundTrip({ trackLength: 0 }).trackLength).toBe(0);
    expect(roundTrip({ trackLength: 300 }).trackLength).toBe(300);
    expect(roundTrip({ trackLength: 3600 }).trackLength).toBe(3600);
  });

  test('round-trip: playhead', () => {
    expect(roundTrip({ playhead: 0 }).playhead).toBe(0);
    expect(roundTrip({ playhead: 45000 }).playhead).toBe(45000);
    expect(roundTrip({ playhead: 300000 }).playhead).toBe(300000);
  });

  test('round-trip: positive pitch', () => {
    expect(roundTrip({ pitch: 0 }).pitch).toBeCloseTo(0, 2);
    expect(roundTrip({ pitch: 3.26 }).pitch).toBeCloseTo(3.26, 2);
    expect(roundTrip({ pitch: 10.5 }).pitch).toBeCloseTo(10.5, 2);
  });

  test('round-trip: negative pitch', () => {
    expect(roundTrip({ pitch: -5 }).pitch).toBeCloseTo(-5, 2);
    expect(roundTrip({ pitch: -12.34 }).pitch).toBeCloseTo(-12.34, 2);
  });

  test('round-trip: trackBpm', () => {
    expect(roundTrip({ trackBpm: 0 }).trackBpm).toBe(0);
    expect(roundTrip({ trackBpm: 128 }).trackBpm).toBeCloseTo(128, 1);
    expect(roundTrip({ trackBpm: 128.5 }).trackBpm).toBeCloseTo(128.5, 1);
    expect(roundTrip({ trackBpm: 174.2 }).trackBpm).toBeCloseTo(174.2, 1);
  });

  test('custom timestamp is preserved', () => {
    const buf = buildAbsolutePosition();
    const now = new Date('2026-01-01T00:00:00Z');
    const r = parseAbsolutePosition(buf, now);
    expect(r?.timestamp).toEqual(now);
  });

  test('full round-trip: realistic CDJ-3000 values', () => {
    const r = roundTrip({
      deviceId: 1,
      deviceName: 'CDJ-3000',
      trackLength: 312, // 5:12
      playhead: 95400, // 1:35.4
      pitch: 3.26,
      trackBpm: 128.0,
    });
    expect(r.deviceId).toBe(1);
    expect(r.deviceName).toBe('CDJ-3000');
    expect(r.trackLength).toBe(312);
    expect(r.playhead).toBe(95400);
    expect(r.pitch).toBeCloseTo(3.26, 2);
    expect(r.trackBpm).toBeCloseTo(128.0, 1);
  });

  test('time-remaining can be derived from trackLength and playhead', () => {
    const r = roundTrip({
      trackLength: 300,
      playhead: 45000,
    });
    const timeRemainingMs = r.trackLength * 1000 - r.playhead;
    expect(timeRemainingMs).toBe(255000); // 4:15.0
  });

  test('effective BPM can be derived from trackBpm and pitch', () => {
    const r = roundTrip({
      trackBpm: 128.0,
      pitch: 6.0,
    });
    const effectiveBpm = (r.trackBpm * (100 + r.pitch)) / 100;
    expect(effectiveBpm).toBeCloseTo(135.68, 1);
  });

  test('zero pitch produces exact trackBpm as effective', () => {
    const r = roundTrip({
      trackBpm: 140.0,
      pitch: 0,
    });
    const effectiveBpm = (r.trackBpm * (100 + r.pitch)) / 100;
    expect(effectiveBpm).toBeCloseTo(140.0, 5);
  });
});
