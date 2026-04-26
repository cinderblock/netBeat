import { describe, expect, test } from 'bun:test';
import { parseDeviceId } from '../../src/protocol/device-id.js';
import {
  buildServiceHandshake,
  buildServicesRequest,
  DIRECTORY_MSG,
  parseDirectoryMessage,
} from '../../src/protocol/directory.js';
import { ReadContext } from '../../src/protocol/read-context.js';
import { WriteContext } from '../../src/protocol/write-context.js';

describe('Directory messages', () => {
  const testDeviceId = parseDeviceId('01234567-89ab-cdef-0123-456789abcdef');

  test('parseDirectoryMessage ServicesAnnouncement', () => {
    const w = new WriteContext();
    w.writeUInt32(DIRECTORY_MSG.SERVICES_ANNOUNCEMENT);
    w.writeBytes(testDeviceId);
    w.writeNetworkString('StateMap');
    w.writeUInt16(39001);
    w.writeNetworkString('BeatInfo');
    w.writeUInt16(39002);

    const msg = parseDirectoryMessage(w.finish());
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe(DIRECTORY_MSG.SERVICES_ANNOUNCEMENT);
    if (msg?.type === DIRECTORY_MSG.SERVICES_ANNOUNCEMENT) {
      expect(msg?.services.length).toBe(2);
      expect(msg?.services[0]?.name).toBe('StateMap');
      expect(msg?.services[0]?.port).toBe(39001);
      expect(msg?.services[1]?.name).toBe('BeatInfo');
      expect(msg?.services[1]?.port).toBe(39002);
    }
  });

  test('parseDirectoryMessage TimeStamp', () => {
    const w = new WriteContext();
    w.writeUInt32(DIRECTORY_MSG.TIMESTAMP);
    w.writeBytes(testDeviceId);
    // 16 bytes padding
    w.writeBytes(new Uint8Array(16));
    w.writeUInt64(1_000_000_000n); // 1 second in nanoseconds

    const msg = parseDirectoryMessage(w.finish());
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe(DIRECTORY_MSG.TIMESTAMP);
    if (msg?.type === DIRECTORY_MSG.TIMESTAMP) {
      expect(msg?.timeAlive).toBe(1_000_000_000n);
    }
  });

  test('parseDirectoryMessage ServicesRequest', () => {
    const w = new WriteContext();
    w.writeUInt32(DIRECTORY_MSG.SERVICES_REQUEST);
    w.writeBytes(testDeviceId);
    w.writeNetworkString('BeatInfo');
    w.writeUInt16(45000);

    const msg = parseDirectoryMessage(w.finish());
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe(DIRECTORY_MSG.SERVICES_REQUEST);
    if (msg?.type === DIRECTORY_MSG.SERVICES_REQUEST) {
      expect(msg?.serviceName).toBe('BeatInfo');
      expect(msg?.servicePort).toBe(45000);
    }
  });

  test('parseDirectoryMessage returns null for unknown type', () => {
    const w = new WriteContext();
    w.writeUInt32(0xff);
    w.writeBytes(testDeviceId);
    expect(parseDirectoryMessage(w.finish())).toBeNull();
  });

  test('parseDirectoryMessage returns null for truncated data', () => {
    expect(parseDirectoryMessage(new Uint8Array(4))).toBeNull();
    expect(parseDirectoryMessage(new Uint8Array(0))).toBeNull();
  });

  test('buildServicesRequest round-trip', () => {
    const buf = buildServicesRequest(testDeviceId, 'StateMap', 39001);
    const msg = parseDirectoryMessage(buf);
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe(DIRECTORY_MSG.SERVICES_REQUEST);
    if (msg?.type === DIRECTORY_MSG.SERVICES_REQUEST) {
      expect(msg?.serviceName).toBe('StateMap');
      expect(msg?.servicePort).toBe(39001);
      expect(msg?.deviceId).toEqual(testDeviceId);
    }
  });

  test('buildServiceHandshake format', () => {
    const buf = buildServiceHandshake(testDeviceId, 'StateMap');
    const ctx = new ReadContext(buf);
    expect(ctx.readUInt32()).toBe(0x0); // message ID
    const id = ctx.readBytes(16);
    expect(id).toEqual(testDeviceId);
    expect(ctx.readNetworkString()).toBe('StateMap');
    expect(ctx.readUInt16()).toBe(0); // reserved
  });
});
