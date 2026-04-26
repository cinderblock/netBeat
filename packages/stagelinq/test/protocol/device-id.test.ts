import { describe, expect, test } from 'bun:test';
import {
  deviceIdEquals,
  formatDeviceId,
  KNOWN_TOKENS,
  parseDeviceId,
  randomDeviceId,
} from '../../src/protocol/device-id.js';

describe('DeviceId', () => {
  test('formatDeviceId produces standard UUID format', () => {
    const id = new Uint8Array([
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32,
      0x10,
    ]);
    expect(formatDeviceId(id)).toBe('01234567-89ab-cdef-fedc-ba9876543210');
  });

  test('parseDeviceId from dashed UUID string', () => {
    const uuid = '01234567-89ab-cdef-fedc-ba9876543210';
    const id = parseDeviceId(uuid);
    expect(id).toEqual(
      new Uint8Array([
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32,
        0x10,
      ]),
    );
  });

  test('parseDeviceId from plain hex string', () => {
    const hex = '0123456789abcdeffedcba9876543210';
    const id = parseDeviceId(hex);
    expect(formatDeviceId(id)).toBe('01234567-89ab-cdef-fedc-ba9876543210');
  });

  test('parseDeviceId throws on invalid length', () => {
    expect(() => parseDeviceId('0123')).toThrow('32 hex chars');
  });

  test('formatDeviceId + parseDeviceId round-trip', () => {
    const original = randomDeviceId();
    const formatted = formatDeviceId(original);
    const parsed = parseDeviceId(formatted);
    expect(parsed).toEqual(original);
  });

  test('deviceIdEquals', () => {
    const a = parseDeviceId('01234567-89ab-cdef-fedc-ba9876543210');
    const b = parseDeviceId('01234567-89ab-cdef-fedc-ba9876543210');
    const c = parseDeviceId('ffffffff-ffff-ffff-ffff-ffffffffffff');
    expect(deviceIdEquals(a, b)).toBe(true);
    expect(deviceIdEquals(a, c)).toBe(false);
  });

  test('randomDeviceId generates valid v4 UUID', () => {
    const id = randomDeviceId();
    expect(id.length).toBe(16);
    // Version nibble should be 4.
    expect(((id[6] ?? 0) >> 4) & 0x0f).toBe(4);
    // Variant bits should be 10xx.
    expect(((id[8] ?? 0) >> 6) & 0x03).toBe(2);
  });

  test('randomDeviceId generates unique values', () => {
    const a = randomDeviceId();
    const b = randomDeviceId();
    expect(deviceIdEquals(a, b)).toBe(false);
  });

  test('KNOWN_TOKENS.SOUND_SWITCH has expected value', () => {
    // "SoundSwitch" in ASCII bytes followed by zeros
    const expected = new Uint8Array([
      0x53, 0x6f, 0x75, 0x6e, 0x64, 0x53, 0x77, 0x69, 0x74, 0x63, 0x68, 0x00, 0x00, 0x00, 0x00,
      0x00,
    ]);
    expect(KNOWN_TOKENS.SOUND_SWITCH).toEqual(expected);
  });

  test('KNOWN_TOKENS.LISTEN is all zeros', () => {
    expect(KNOWN_TOKENS.LISTEN).toEqual(new Uint8Array(16));
  });
});
