import { describe, expect, test } from 'bun:test';
import {
  buildKeepAlive,
  classifyDeviceType,
  DEVICE_TYPE_BYTE,
  KEEP_ALIVE_LENGTH,
  parseKeepAlive,
  type SelfIdentity,
} from '../src/index.ts';

const TEST_IDENTITY: SelfIdentity = {
  id: 7,
  name: 'netbeat-test',
  ip: '192.168.1.42',
  mac: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
  rawType: DEVICE_TYPE_BYTE.CDJ,
};

describe('classifyDeviceType', () => {
  test('maps canonical bytes to device types', () => {
    expect(classifyDeviceType(0x01)).toBe('cdj');
    expect(classifyDeviceType(0x02)).toBe('mixer');
    expect(classifyDeviceType(0x03)).toBe('mixer');
    expect(classifyDeviceType(0x04)).toBe('rekordbox');
  });

  test('unknown bytes fall through to "unknown"', () => {
    expect(classifyDeviceType(0x00)).toBe('unknown');
    expect(classifyDeviceType(0xff)).toBe('unknown');
  });
});

describe('buildKeepAlive', () => {
  test('produces a 54-byte packet', () => {
    const packet = buildKeepAlive(TEST_IDENTITY);
    expect(packet.length).toBe(KEEP_ALIVE_LENGTH);
    expect(packet.length).toBe(0x36);
  });

  test('starts with the Pro DJ Link magic', () => {
    const packet = buildKeepAlive(TEST_IDENTITY);
    expect(Array.from(packet.subarray(0, 10))).toEqual([
      0x51, 0x73, 0x70, 0x74, 0x31, 0x57, 0x6d, 0x4a, 0x4f, 0x4c,
    ]);
  });

  test('writes kind 0x06 at offset 0x0a', () => {
    const packet = buildKeepAlive(TEST_IDENTITY);
    expect(packet[0x0a]).toBe(0x06);
  });

  test('encodes the device ID and type byte', () => {
    const packet = buildKeepAlive(TEST_IDENTITY);
    expect(packet[0x24]).toBe(7);
    expect(packet[0x34]).toBe(DEVICE_TYPE_BYTE.CDJ);
  });

  test('encodes MAC and IP at the documented offsets', () => {
    const packet = buildKeepAlive(TEST_IDENTITY);
    expect(Array.from(packet.subarray(0x26, 0x2c))).toEqual([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    expect(Array.from(packet.subarray(0x2c, 0x30))).toEqual([192, 168, 1, 42]);
  });

  test('throws on bad MAC length', () => {
    expect(() =>
      buildKeepAlive({
        ...TEST_IDENTITY,
        mac: new Uint8Array([1, 2, 3]),
      }),
    ).toThrow(/mac must be 6 bytes/);
  });

  test('throws on malformed IP', () => {
    expect(() => buildKeepAlive({ ...TEST_IDENTITY, ip: 'not-an-ip' })).toThrow(/Invalid IPv4/);
    expect(() => buildKeepAlive({ ...TEST_IDENTITY, ip: '300.1.1.1' })).toThrow(/Invalid IPv4/);
  });

  test('throws on out-of-range device ID', () => {
    expect(() => buildKeepAlive({ ...TEST_IDENTITY, id: -1 })).toThrow(/id must be a byte/);
    expect(() => buildKeepAlive({ ...TEST_IDENTITY, id: 300 })).toThrow(/id must be a byte/);
  });

  test('truncates names longer than 20 chars', () => {
    const long = 'netbeat-this-name-is-way-too-long';
    const packet = buildKeepAlive({ ...TEST_IDENTITY, name: long });
    // The 20-byte name field must not bleed into the following bytes.
    // Byte 0x20 is the fixed 0x01 protocol marker.
    expect(packet[0x20]).toBe(0x01);
  });
});

describe('parseKeepAlive', () => {
  test('round-trips buildKeepAlive output back to an equivalent Device', () => {
    const packet = buildKeepAlive(TEST_IDENTITY);
    const device = parseKeepAlive(packet);
    expect(device).not.toBeNull();
    if (!device) return;
    expect(device.id).toBe(TEST_IDENTITY.id);
    expect(device.name).toBe(TEST_IDENTITY.name);
    expect(device.ip).toBe(TEST_IDENTITY.ip);
    expect(Array.from(device.mac)).toEqual(Array.from(TEST_IDENTITY.mac));
    expect(device.rawType).toBe(TEST_IDENTITY.rawType);
    expect(device.type).toBe('cdj');
    expect(device.lastSeen).toBeInstanceOf(Date);
  });

  test('returns null on wrong magic', () => {
    const packet = buildKeepAlive(TEST_IDENTITY);
    packet[0] = 0x00;
    expect(parseKeepAlive(packet)).toBeNull();
  });

  test('returns null on short buffer', () => {
    expect(parseKeepAlive(new Uint8Array(10))).toBeNull();
  });

  test('returns null on a non-keepalive kind', () => {
    const packet = buildKeepAlive(TEST_IDENTITY);
    packet[0x0a] = 0x28; // beat kind — shouldn't be handled by parseKeepAlive
    expect(parseKeepAlive(packet)).toBeNull();
  });

  test('uses the injected `now` for lastSeen', () => {
    const packet = buildKeepAlive(TEST_IDENTITY);
    const fixed = new Date('2026-04-21T15:00:00Z');
    const device = parseKeepAlive(packet, fixed);
    expect(device?.lastSeen.getTime()).toBe(fixed.getTime());
  });

  test('strips trailing NULs and whitespace from the name', () => {
    const packet = buildKeepAlive({ ...TEST_IDENTITY, name: 'CDJ-3000   ' });
    const device = parseKeepAlive(packet);
    expect(device?.name).toBe('CDJ-3000');
  });

  test('classifies a mixer keep-alive correctly', () => {
    const packet = buildKeepAlive({
      ...TEST_IDENTITY,
      id: 0x21,
      rawType: DEVICE_TYPE_BYTE.MIXER,
      name: 'DJM-900NXS2',
    });
    const device = parseKeepAlive(packet);
    expect(device?.type).toBe('mixer');
    expect(device?.id).toBe(0x21);
  });
});
