import { describe, expect, test } from 'bun:test';
import { type Device, type DeviceEvent, DeviceManager } from '../src/index.ts';

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 1,
    name: 'CDJ-3000',
    ip: '192.168.1.10',
    mac: new Uint8Array([1, 2, 3, 4, 5, 6]),
    type: 'cdj',
    rawType: 0x01,
    lastSeen: new Date('2026-04-21T15:00:00Z'),
    ...overrides,
  };
}

describe('DeviceManager', () => {
  test('emits "added" the first time it sees an ID', () => {
    const mgr = new DeviceManager();
    const events: [DeviceEvent, number][] = [];
    mgr.onEvent((evt, dev) => events.push([evt, dev.id]));
    mgr.ingest(makeDevice({ id: 1 }));
    expect(events).toEqual([['added', 1]]);
  });

  test('emits "updated" on subsequent ingests for the same ID', () => {
    const mgr = new DeviceManager();
    const events: DeviceEvent[] = [];
    mgr.onEvent((evt) => events.push(evt));
    mgr.ingest(makeDevice({ id: 1 }));
    mgr.ingest(makeDevice({ id: 1 }));
    mgr.ingest(makeDevice({ id: 1 }));
    expect(events).toEqual(['added', 'updated', 'updated']);
  });

  test('tracks multiple devices independently', () => {
    const mgr = new DeviceManager();
    const events: [DeviceEvent, number][] = [];
    mgr.onEvent((evt, dev) => events.push([evt, dev.id]));
    mgr.ingest(makeDevice({ id: 1 }));
    mgr.ingest(makeDevice({ id: 2 }));
    mgr.ingest(makeDevice({ id: 0x21, type: 'mixer' }));
    expect(events).toEqual([
      ['added', 1],
      ['added', 2],
      ['added', 0x21],
    ]);
    expect(mgr.list().map((d) => d.id)).toEqual([1, 2, 0x21]);
  });

  test('sweep evicts devices past timeout', () => {
    let virtualTime = new Date('2026-04-21T15:00:00Z').getTime();
    const mgr = new DeviceManager({
      timeoutMs: 1000,
      now: () => new Date(virtualTime),
    });
    const events: [DeviceEvent, number][] = [];
    mgr.onEvent((evt, dev) => events.push([evt, dev.id]));

    mgr.ingest(makeDevice({ id: 1, lastSeen: new Date(virtualTime) }));
    // 500 ms later — still fresh.
    virtualTime += 500;
    mgr.sweep();
    expect(mgr.get(1)).toBeDefined();

    // 1500 ms after ingest — past the 1000 ms timeout.
    virtualTime += 1000;
    mgr.sweep();
    expect(mgr.get(1)).toBeUndefined();
    expect(events).toEqual([
      ['added', 1],
      ['removed', 1],
    ]);
  });

  test('sweep is a no-op when no devices are stale', () => {
    const mgr = new DeviceManager({ timeoutMs: 1000 });
    const events: DeviceEvent[] = [];
    mgr.onEvent((evt) => events.push(evt));
    mgr.ingest(makeDevice({ id: 1, lastSeen: new Date() }));
    mgr.sweep();
    expect(events).toEqual(['added']);
  });

  test('unsubscribe via returned function stops future events', () => {
    const mgr = new DeviceManager();
    const events: DeviceEvent[] = [];
    const unsubscribe = mgr.onEvent((evt) => events.push(evt));
    mgr.ingest(makeDevice({ id: 1 }));
    unsubscribe();
    mgr.ingest(makeDevice({ id: 2 }));
    expect(events).toEqual(['added']);
  });

  test('listener exceptions do not break other listeners', () => {
    const mgr = new DeviceManager();
    const calls: string[] = [];
    mgr.onEvent(() => {
      calls.push('throwing');
      throw new Error('boom');
    });
    mgr.onEvent(() => {
      calls.push('ok');
    });
    mgr.ingest(makeDevice({ id: 1 }));
    expect(calls).toEqual(['throwing', 'ok']);
  });

  test('clear() forgets without emitting', () => {
    const mgr = new DeviceManager();
    const events: DeviceEvent[] = [];
    mgr.onEvent((evt) => events.push(evt));
    mgr.ingest(makeDevice({ id: 1 }));
    mgr.clear();
    expect(mgr.list()).toEqual([]);
    expect(events).toEqual(['added']); // only the ingest event
  });
});
