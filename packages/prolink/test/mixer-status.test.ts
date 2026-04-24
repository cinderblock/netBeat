import { describe, expect, test } from 'bun:test';
import {
  type BuildMixerStatusOptions,
  buildMixerStatus,
  MIXER_STATUS_LENGTH,
  parseMixerStatus,
} from '../src/packets/mixer-status.ts';

/** Build → parse round-trip helper. */
function roundTrip(opts: BuildMixerStatusOptions = {}) {
  const buf = buildMixerStatus(opts);
  const result = parseMixerStatus(buf);
  expect(result).not.toBeNull();
  return result ?? ({} as never);
}

describe('buildMixerStatus', () => {
  test('produces correct packet length', () => {
    expect(buildMixerStatus().length).toBe(MIXER_STATUS_LENGTH);
    expect(MIXER_STATUS_LENGTH).toBe(56);
  });

  test('writes correct header and kind byte', () => {
    const buf = buildMixerStatus();
    // Pro DJ Link magic header
    expect(buf[0]).toBe(0x51);
    expect(buf[9]).toBe(0x4c);
    // Kind byte
    expect(buf[0x0a]).toBe(0x29);
  });

  test('writes device ID at 0x21', () => {
    const buf = buildMixerStatus({ deviceId: 0x21 });
    expect(buf[0x21]).toBe(0x21);
  });

  test('writes custom device ID', () => {
    const buf = buildMixerStatus({ deviceId: 5 });
    expect(buf[0x21]).toBe(5);
  });

  test('writes device name at 0x0c', () => {
    const buf = buildMixerStatus({ deviceName: 'DJM-V10' });
    // 'D' = 0x44
    expect(buf[0x0c]).toBe(0x44);
  });

  test('writes len_r = 0x0014', () => {
    const buf = buildMixerStatus();
    expect(buf[0x22]).toBe(0x00);
    expect(buf[0x23]).toBe(0x14);
  });

  test('writes master flags (0xf0) when isMaster=true', () => {
    const buf = buildMixerStatus({ isMaster: true });
    expect(buf[0x27]).toBe(0xf0);
  });

  test('writes non-master flags (0xd0) when isMaster=false', () => {
    const buf = buildMixerStatus({ isMaster: false });
    expect(buf[0x27]).toBe(0xd0);
  });

  test('writes pitch as 0x00100000', () => {
    const buf = buildMixerStatus();
    expect(buf[0x28]).toBe(0x00);
    expect(buf[0x29]).toBe(0x10);
    expect(buf[0x2a]).toBe(0x00);
    expect(buf[0x2b]).toBe(0x00);
  });

  test('writes BPM × 100 at 0x2e-0x2f', () => {
    const buf = buildMixerStatus({ bpm: 128.5 });
    // 128.5 × 100 = 12850 = 0x3232
    expect(buf[0x2e]).toBe(0x32);
    expect(buf[0x2f]).toBe(0x32);
  });

  test('writes master-handoff at 0x36', () => {
    const buf = buildMixerStatus({ masterHandoff: 2 });
    expect(buf[0x36]).toBe(2);
  });

  test('writes beat-within-bar at 0x37', () => {
    const buf = buildMixerStatus({ beatInBar: 3 });
    expect(buf[0x37]).toBe(3);
  });

  test('default device ID is 0x21 (33)', () => {
    const buf = buildMixerStatus();
    expect(buf[0x21]).toBe(0x21);
  });

  test('default master-handoff is 0xff', () => {
    const buf = buildMixerStatus();
    expect(buf[0x36]).toBe(0xff);
  });
});

describe('parseMixerStatus', () => {
  test('returns null for too-short buffer', () => {
    expect(parseMixerStatus(new Uint8Array(55))).toBeNull();
  });

  test('returns null for wrong header magic', () => {
    const buf = buildMixerStatus();
    buf[0] = 0x00;
    expect(parseMixerStatus(buf)).toBeNull();
  });

  test('returns null for wrong kind byte', () => {
    const buf = buildMixerStatus();
    buf[0x0a] = 0x0a; // CDJ status kind instead of mixer
    expect(parseMixerStatus(buf)).toBeNull();
  });

  test('round-trip: deviceId', () => {
    expect(roundTrip({ deviceId: 0x21 }).deviceId).toBe(0x21);
    expect(roundTrip({ deviceId: 5 }).deviceId).toBe(5);
  });

  test('round-trip: deviceName', () => {
    expect(roundTrip({ deviceName: 'DJM-V10' }).deviceName).toBe('DJM-V10');
    expect(roundTrip({ deviceName: 'DJM-900NXS2' }).deviceName).toBe('DJM-900NXS2');
  });

  test('round-trip: isMaster true', () => {
    const m = roundTrip({ isMaster: true });
    expect(m.isMaster).toBe(true);
    expect(m.statusFlags).toBe(0xf0);
  });

  test('round-trip: isMaster false', () => {
    const m = roundTrip({ isMaster: false });
    expect(m.isMaster).toBe(false);
    expect(m.statusFlags).toBe(0xd0);
  });

  test('round-trip: BPM', () => {
    expect(roundTrip({ bpm: 128.0 }).bpm).toBeCloseTo(128.0, 2);
    expect(roundTrip({ bpm: 89.25 }).bpm).toBeCloseTo(89.25, 2);
    expect(roundTrip({ bpm: 174.99 }).bpm).toBeCloseTo(174.99, 2);
    expect(roundTrip({ bpm: 0 }).bpm).toBe(0);
  });

  test('round-trip: beatInBar', () => {
    expect(roundTrip({ beatInBar: 1 }).beatInBar).toBe(1);
    expect(roundTrip({ beatInBar: 4 }).beatInBar).toBe(4);
  });

  test('round-trip: masterHandoff', () => {
    expect(roundTrip({ masterHandoff: 0xff }).masterHandoff).toBe(0xff);
    expect(roundTrip({ masterHandoff: 2 }).masterHandoff).toBe(2);
  });

  test('round-trip: explicit statusFlags overrides isMaster', () => {
    const m = roundTrip({ statusFlags: 0xf0, isMaster: false });
    expect(m.isMaster).toBe(true);
    expect(m.statusFlags).toBe(0xf0);
  });

  test('custom timestamp is preserved', () => {
    const buf = buildMixerStatus();
    const now = new Date('2026-01-01T00:00:00Z');
    const m = parseMixerStatus(buf, now);
    expect(m?.timestamp).toEqual(now);
  });

  test('full round-trip with all fields', () => {
    const m = roundTrip({
      deviceId: 0x21,
      deviceName: 'DJM-900NXS2',
      isMaster: true,
      bpm: 140.0,
      beatInBar: 3,
      masterHandoff: 0xff,
    });
    expect(m.deviceId).toBe(0x21);
    expect(m.deviceName).toBe('DJM-900NXS2');
    expect(m.isMaster).toBe(true);
    expect(m.bpm).toBeCloseTo(140.0, 2);
    expect(m.beatInBar).toBe(3);
    expect(m.masterHandoff).toBe(0xff);
  });
});
