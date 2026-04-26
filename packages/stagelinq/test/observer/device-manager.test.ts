import { describe, expect, test } from 'bun:test';
import { DeviceManager } from '../../src/observer/device-manager.js';
import type { DeviceEventType, StageLinqDevice } from '../../src/observer/types.js';
import { parseDeviceId } from '../../src/protocol/device-id.js';
import { DISCOVERY_ACTION, type DiscoveryMessage } from '../../src/protocol/discovery.js';

function makeDiscovery(overrides: Partial<DiscoveryMessage> = {}): DiscoveryMessage {
  return {
    deviceId: parseDeviceId('01234567-89ab-cdef-0123-456789abcdef'),
    source: 'SC6000',
    action: DISCOVERY_ACTION.LOGIN,
    softwareName: 'JP13',
    softwareVersion: '2.4.0',
    port: 39000,
    ...overrides,
  };
}

describe('DeviceManager', () => {
  test('ingest LOGIN adds device and emits "added"', () => {
    const events: [DeviceEventType, StageLinqDevice][] = [];
    const dm = new DeviceManager();
    dm.onEvent((e, d) => events.push([e, d]));

    dm.ingest(makeDiscovery(), '192.168.1.100');

    expect(events.length).toBe(1);
    expect(events[0]?.[0]).toBe('added');
    expect(events[0]?.[1].model.name).toBe('SC6000');
    expect(events[0]?.[1].address).toBe('192.168.1.100');
    expect(dm.list().length).toBe(1);
  });

  test('ingest LOGIN again emits "updated"', () => {
    const events: [DeviceEventType, StageLinqDevice][] = [];
    const dm = new DeviceManager();
    dm.onEvent((e, d) => events.push([e, d]));

    dm.ingest(makeDiscovery(), '192.168.1.100');
    dm.ingest(makeDiscovery(), '192.168.1.100');

    expect(events.length).toBe(2);
    expect(events[0]?.[0]).toBe('added');
    expect(events[1]?.[0]).toBe('updated');
    expect(dm.list().length).toBe(1);
  });

  test('ingest LOGOUT removes device and emits "removed"', () => {
    const events: [DeviceEventType, StageLinqDevice][] = [];
    const dm = new DeviceManager();
    dm.onEvent((e, d) => events.push([e, d]));

    dm.ingest(makeDiscovery(), '192.168.1.100');
    dm.ingest(makeDiscovery({ action: DISCOVERY_ACTION.LOGOUT }), '192.168.1.100');

    expect(events.length).toBe(2);
    expect(events[1]?.[0]).toBe('removed');
    expect(dm.list().length).toBe(0);
  });

  test('ingest LOGOUT for unknown device is no-op', () => {
    const events: [DeviceEventType, StageLinqDevice][] = [];
    const dm = new DeviceManager();
    dm.onEvent((e, d) => events.push([e, d]));

    dm.ingest(makeDiscovery({ action: DISCOVERY_ACTION.LOGOUT }), '192.168.1.100');
    expect(events.length).toBe(0);
  });

  test('get by DeviceId', () => {
    const dm = new DeviceManager();
    const id = parseDeviceId('01234567-89ab-cdef-0123-456789abcdef');
    dm.ingest(makeDiscovery({ deviceId: id }), '10.0.0.1');

    const device = dm.get(id);
    expect(device).toBeDefined();
    expect(device?.model.name).toBe('SC6000');
  });

  test('get returns undefined for unknown DeviceId', () => {
    const dm = new DeviceManager();
    const id = parseDeviceId('ffffffff-ffff-ffff-ffff-ffffffffffff');
    expect(dm.get(id)).toBeUndefined();
  });

  test('clear emits "removed" for each device', () => {
    const events: [DeviceEventType, StageLinqDevice][] = [];
    const dm = new DeviceManager();
    dm.onEvent((e, d) => events.push([e, d]));

    dm.ingest(
      makeDiscovery({ deviceId: parseDeviceId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') }),
      '10.0.0.1',
    );
    dm.ingest(
      makeDiscovery({ deviceId: parseDeviceId('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') }),
      '10.0.0.2',
    );
    events.length = 0;

    dm.clear();
    expect(events.length).toBe(2);
    expect(events.every(([e]) => e === 'removed')).toBe(true);
    expect(dm.list().length).toBe(0);
  });

  test('unsubscribe stops delivering events', () => {
    const events: DeviceEventType[] = [];
    const dm = new DeviceManager();
    const unsub = dm.onEvent((e) => events.push(e));

    dm.ingest(makeDiscovery(), '10.0.0.1');
    expect(events.length).toBe(1);

    unsub();
    dm.ingest(makeDiscovery(), '10.0.0.1');
    expect(events.length).toBe(1); // No new event
  });

  test('staleness sweep removes old devices', () => {
    let clock = 1000;
    const events: [DeviceEventType, StageLinqDevice][] = [];
    const dm = new DeviceManager({
      stalenessMs: 3000,
      sweepIntervalMs: 100,
      now: () => clock,
    });
    dm.onEvent((e, d) => events.push([e, d]));

    dm.ingest(makeDiscovery(), '10.0.0.1');
    expect(dm.list().length).toBe(1);

    // Advance past staleness window
    clock = 5000;
    // Manually trigger sweep by starting + waiting
    dm.start();
    // Use a timer to check after sweep runs
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        dm.stop();
        expect(events.some(([e]) => e === 'removed')).toBe(true);
        expect(dm.list().length).toBe(0);
        resolve();
      }, 200);
    });
  });

  test('consumer error does not break device manager', () => {
    const dm = new DeviceManager();
    dm.onEvent(() => {
      throw new Error('consumer crash');
    });

    // Should not throw
    expect(() => dm.ingest(makeDiscovery(), '10.0.0.1')).not.toThrow();
    expect(dm.list().length).toBe(1);
  });
});
