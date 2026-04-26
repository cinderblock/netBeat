import { describe, expect, test } from 'bun:test';
import { parseDeviceId } from '../../src/protocol/device-id.js';
import {
  buildDiscovery,
  DISCOVERY_ACTION,
  hasDiscoveryMagic,
  parseDiscovery,
} from '../../src/protocol/discovery.js';
import { DISCOVERY_MAGIC } from '../../src/protocol/ports.js';

describe('Discovery', () => {
  const testDeviceId = parseDeviceId('01234567-89ab-cdef-0123-456789abcdef');

  test('hasDiscoveryMagic recognizes "airD"', () => {
    expect(hasDiscoveryMagic(DISCOVERY_MAGIC)).toBe(true);
    expect(hasDiscoveryMagic(new Uint8Array([0x61, 0x69, 0x72, 0x44, 0x00]))).toBe(true);
    expect(hasDiscoveryMagic(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBe(false);
    expect(hasDiscoveryMagic(new Uint8Array([0x61, 0x69, 0x72]))).toBe(false);
  });

  test('buildDiscovery + parseDiscovery round-trip (LOGIN)', () => {
    const opts = {
      deviceId: testDeviceId,
      source: 'TestDevice',
      action: DISCOVERY_ACTION.LOGIN,
      softwareName: 'JP13',
      softwareVersion: '2.4.0',
      port: 39000,
    };

    const buf = buildDiscovery(opts);
    const parsed = parseDiscovery(buf);

    expect(parsed).not.toBeNull();
    expect(parsed?.deviceId).toEqual(testDeviceId);
    expect(parsed?.source).toBe('TestDevice');
    expect(parsed?.action).toBe(DISCOVERY_ACTION.LOGIN);
    expect(parsed?.softwareName).toBe('JP13');
    expect(parsed?.softwareVersion).toBe('2.4.0');
    expect(parsed?.port).toBe(39000);
  });

  test('buildDiscovery + parseDiscovery round-trip (LOGOUT)', () => {
    const opts = {
      deviceId: testDeviceId,
      source: 'SC6000',
      action: DISCOVERY_ACTION.LOGOUT,
      softwareName: 'JP13',
      softwareVersion: '3.0.0',
      port: 0,
    };

    const buf = buildDiscovery(opts);
    const parsed = parseDiscovery(buf);

    expect(parsed).not.toBeNull();
    expect(parsed?.action).toBe(DISCOVERY_ACTION.LOGOUT);
    expect(parsed?.source).toBe('SC6000');
  });

  test('parseDiscovery returns null for malformed data', () => {
    expect(parseDiscovery(new Uint8Array(0))).toBeNull();
    expect(parseDiscovery(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBeNull();
    // Valid magic but truncated
    expect(parseDiscovery(new Uint8Array([0x61, 0x69, 0x72, 0x44]))).toBeNull();
  });

  test('parseDiscovery rejects unknown action', () => {
    const opts = {
      deviceId: testDeviceId,
      source: 'Test',
      action: 'UNKNOWN_ACTION' as typeof DISCOVERY_ACTION.LOGIN,
      softwareName: 'JP13',
      softwareVersion: '1.0',
      port: 1234,
    };
    // Build with invalid action
    const buf = buildDiscovery(opts);
    const parsed = parseDiscovery(buf);
    expect(parsed).toBeNull();
  });

  test('discovery message starts with "airD" magic', () => {
    const buf = buildDiscovery({
      deviceId: testDeviceId,
      source: 'X',
      action: DISCOVERY_ACTION.LOGIN,
      softwareName: 'JP13',
      softwareVersion: '1.0',
      port: 51337,
    });
    expect(buf[0]).toBe(0x61); // 'a'
    expect(buf[1]).toBe(0x69); // 'i'
    expect(buf[2]).toBe(0x72); // 'r'
    expect(buf[3]).toBe(0x44); // 'D'
  });
});
