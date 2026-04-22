import { describe, expect, test } from 'bun:test';
import {
  ALL_PORTS,
  hasProlinkHeader,
  PORTS,
  PROLINK_HEADER,
  PROTOCOL,
  readKind,
} from '../src/index.ts';

describe('@netbeat/prolink public surface', () => {
  test('PROTOCOL identifies pro-dj-link', () => {
    expect(PROTOCOL).toBe('pro-dj-link');
  });

  test('PORTS includes the three well-known Pro DJ Link UDP ports', () => {
    expect(PORTS.DISCOVERY).toBe(50000);
    expect(PORTS.BEAT).toBe(50001);
    expect(PORTS.STATUS).toBe(50002);
  });

  test('all PORTS values are in the documented 50000-range', () => {
    for (const port of Object.values(PORTS)) {
      expect(port).toBeGreaterThanOrEqual(50000);
      expect(port).toBeLessThan(51000);
    }
  });

  test('ALL_PORTS covers every PORTS value', () => {
    expect(new Set(ALL_PORTS)).toEqual(new Set(Object.values(PORTS)));
  });
});

describe('Pro DJ Link header', () => {
  test('PROLINK_HEADER is the 10-byte magic', () => {
    expect(PROLINK_HEADER.length).toBe(10);
    expect(Array.from(PROLINK_HEADER)).toEqual([
      0x51, 0x73, 0x70, 0x74, 0x31, 0x57, 0x6d, 0x4a, 0x4f, 0x4c,
    ]);
  });

  test('hasProlinkHeader rejects short buffers', () => {
    expect(hasProlinkHeader(new Uint8Array(0))).toBe(false);
    expect(hasProlinkHeader(PROLINK_HEADER.slice(0, 5))).toBe(false);
  });

  test('hasProlinkHeader rejects payloads with a wrong byte', () => {
    const bad = new Uint8Array([...PROLINK_HEADER, 0x06]);
    bad[0] = 0x00;
    expect(hasProlinkHeader(bad)).toBe(false);
  });

  test('readKind returns the kind byte for valid headers', () => {
    const packet = new Uint8Array([...PROLINK_HEADER, 0x06, 0x00]);
    expect(readKind(packet)).toBe(0x06);
  });

  test('readKind returns null when magic mismatches', () => {
    const bad = new Uint8Array([...PROLINK_HEADER, 0x06]);
    bad[9] = 0xff;
    expect(readKind(bad)).toBe(null);
  });
});
