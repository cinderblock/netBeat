import { describe, expect, test } from 'bun:test';
import {
  type BuildOnAirOptions,
  buildOnAir,
  ON_AIR_6CH_LENGTH,
  ON_AIR_MIN_LENGTH,
  parseOnAir,
} from '../src/packets/on-air.ts';

/** Build → parse round-trip helper. */
function roundTrip(opts: BuildOnAirOptions = {}) {
  const buf = buildOnAir(opts);
  const result = parseOnAir(buf);
  expect(result).not.toBeNull();
  return result ?? ({} as never);
}

describe('buildOnAir', () => {
  test('produces correct 4-channel packet length', () => {
    expect(buildOnAir().length).toBe(ON_AIR_MIN_LENGTH);
    expect(ON_AIR_MIN_LENGTH).toBe(40);
  });

  test('produces correct 6-channel packet length', () => {
    const buf = buildOnAir({ channels: [true, false, true, false, true, false] });
    expect(buf.length).toBe(ON_AIR_6CH_LENGTH);
    expect(ON_AIR_6CH_LENGTH).toBe(42);
  });

  test('writes correct header and kind byte', () => {
    const buf = buildOnAir();
    expect(buf[0]).toBe(0x51);
    expect(buf[9]).toBe(0x4c);
    expect(buf[0x0a]).toBe(0x03);
  });

  test('writes subtype 0x00 for 4-channel', () => {
    const buf = buildOnAir();
    expect(buf[0x0b]).toBe(0x00);
  });

  test('writes subtype 0x03 for 6-channel', () => {
    const buf = buildOnAir({ channels: [true, true, true, true, true, true] });
    expect(buf[0x0b]).toBe(0x03);
  });

  test('writes device ID at 0x21', () => {
    const buf = buildOnAir({ deviceId: 0x21 });
    expect(buf[0x21]).toBe(0x21);
  });

  test('writes channel flags at 0x24..0x27', () => {
    const buf = buildOnAir({ channels: [true, false, true, false] });
    expect(buf[0x24]).toBe(0x01);
    expect(buf[0x25]).toBe(0x00);
    expect(buf[0x26]).toBe(0x01);
    expect(buf[0x27]).toBe(0x00);
  });

  test('writes 6-channel flags at 0x24..0x29', () => {
    const buf = buildOnAir({ channels: [true, true, false, false, true, false] });
    expect(buf[0x24]).toBe(0x01);
    expect(buf[0x25]).toBe(0x01);
    expect(buf[0x26]).toBe(0x00);
    expect(buf[0x27]).toBe(0x00);
    expect(buf[0x28]).toBe(0x01);
    expect(buf[0x29]).toBe(0x00);
  });

  test('default device ID is 0x21 (33)', () => {
    const buf = buildOnAir();
    expect(buf[0x21]).toBe(0x21);
  });

  test('default channels are all off-air', () => {
    const buf = buildOnAir();
    expect(buf[0x24]).toBe(0x00);
    expect(buf[0x25]).toBe(0x00);
    expect(buf[0x26]).toBe(0x00);
    expect(buf[0x27]).toBe(0x00);
  });
});

describe('parseOnAir', () => {
  test('returns null for too-short buffer', () => {
    expect(parseOnAir(new Uint8Array(39))).toBeNull();
  });

  test('returns null for wrong header magic', () => {
    const buf = buildOnAir();
    buf[0] = 0x00;
    expect(parseOnAir(buf)).toBeNull();
  });

  test('returns null for wrong kind byte', () => {
    const buf = buildOnAir();
    buf[0x0a] = 0x28; // beat kind
    expect(parseOnAir(buf)).toBeNull();
  });

  test('round-trip: deviceId', () => {
    expect(roundTrip({ deviceId: 0x21 }).deviceId).toBe(0x21);
    expect(roundTrip({ deviceId: 5 }).deviceId).toBe(5);
  });

  test('round-trip: deviceName', () => {
    expect(roundTrip({ deviceName: 'DJM-V10' }).deviceName).toBe('DJM-V10');
    expect(roundTrip({ deviceName: 'DJM-900NXS2' }).deviceName).toBe('DJM-900NXS2');
  });

  test('round-trip: 4-channel all off-air', () => {
    const r = roundTrip({ channels: [false, false, false, false] });
    expect(r.channels).toEqual([false, false, false, false]);
  });

  test('round-trip: 4-channel mixed', () => {
    const r = roundTrip({ channels: [true, false, true, false] });
    expect(r.channels).toEqual([true, false, true, false]);
  });

  test('round-trip: 4-channel all on-air', () => {
    const r = roundTrip({ channels: [true, true, true, true] });
    expect(r.channels).toEqual([true, true, true, true]);
  });

  test('round-trip: 6-channel DJM-V10', () => {
    const r = roundTrip({ channels: [true, true, false, false, true, false] });
    expect(r.channels).toEqual([true, true, false, false, true, false]);
    expect(r.channels).toHaveLength(6);
  });

  test('round-trip: 6-channel all on-air', () => {
    const r = roundTrip({ channels: [true, true, true, true, true, true] });
    expect(r.channels).toEqual([true, true, true, true, true, true]);
  });

  test('custom timestamp is preserved', () => {
    const buf = buildOnAir();
    const now = new Date('2026-01-01T00:00:00Z');
    const r = parseOnAir(buf, now);
    expect(r?.timestamp).toEqual(now);
  });

  test('non-zero flag values are treated as on-air', () => {
    const buf = buildOnAir();
    // Set channel 1 to 0x02 instead of 0x01 — should still be on-air
    buf[0x24] = 0x02;
    buf[0x25] = 0xff;
    const r = parseOnAir(buf);
    expect(r?.channels[0]).toBe(true);
    expect(r?.channels[1]).toBe(true);
  });

  test('returns null for 6-channel subtype with too-short buffer', () => {
    // Build a 6-channel packet, then truncate it
    const full = buildOnAir({ channels: [true, true, true, true, true, true] });
    const truncated = full.subarray(0, 41); // 1 byte short
    expect(parseOnAir(truncated)).toBeNull();
  });
});
