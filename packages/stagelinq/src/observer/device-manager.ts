/**
 * Tracks discovered StageLinQ devices with add/update/remove lifecycle.
 *
 * Devices are identified by their 16-byte DeviceId. A device is "removed"
 * when it hasn't been seen for longer than the staleness timeout, or when
 * a DISCOVERER_EXIT_ message is received.
 */

import { type DeviceId, formatDeviceId } from '../protocol/device-id.js';
import { classifyDevice } from '../protocol/devices.js';
import type { DiscoveryMessage } from '../protocol/discovery.js';
import type { DeviceEventType, DeviceListener, StageLinqDevice } from './types.js';

export interface DeviceManagerOptions {
  /** How long (ms) before a device is considered stale and removed. Default: 5000. */
  readonly stalenessMs?: number;
  /** How often (ms) to sweep for stale devices. Default: 2000. */
  readonly sweepIntervalMs?: number;
  /** Clock function for testing. */
  readonly now?: () => number;
}

export class DeviceManager {
  private readonly devices = new Map<string, StageLinqDevice>();
  private readonly listeners = new Set<DeviceListener>();
  private readonly stalenessMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DeviceManagerOptions = {}) {
    this.stalenessMs = options.stalenessMs ?? 5000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 2000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Subscribe to device lifecycle events. Returns an unsubscribe function. */
  onEvent(listener: DeviceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Ingest a discovery message. Updates or adds the device, emits events. */
  ingest(msg: DiscoveryMessage, address: string): void {
    const key = formatDeviceId(msg.deviceId);

    if (msg.action === 'DISCOVERER_EXIT_') {
      const existing = this.devices.get(key);
      if (existing) {
        this.devices.delete(key);
        this.emit('removed', existing);
      }
      return;
    }

    const model = classifyDevice(msg.softwareName);
    const device: StageLinqDevice = {
      // Common Device fields (from @netbeat/core)
      id: `stagelinq:${formatDeviceId(msg.deviceId)}`,
      name: model.name,
      category: model.category,
      address,
      deckCount: model.deckCount,
      protocol: 'stagelinq',
      // StageLinQ-specific fields
      deviceId: msg.deviceId,
      source: msg.source,
      model,
      softwareVersion: msg.softwareVersion,
      directoryPort: msg.port,
      lastSeen: this.now(),
    };

    const existing = this.devices.get(key);
    this.devices.set(key, device);

    if (existing) {
      this.emit('updated', device);
    } else {
      this.emit('added', device);
    }
  }

  /** Look up a device by its DeviceId. */
  get(deviceId: DeviceId): StageLinqDevice | undefined {
    return this.devices.get(formatDeviceId(deviceId));
  }

  /** List all currently known devices. */
  list(): StageLinqDevice[] {
    return [...this.devices.values()];
  }

  /** Start the staleness sweep timer. */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
  }

  /** Stop the sweep timer and clear all devices. */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Remove all tracked devices (emitting 'removed' for each). */
  clear(): void {
    for (const device of this.devices.values()) {
      this.emit('removed', device);
    }
    this.devices.clear();
  }

  /** Remove devices that haven't been seen within the staleness window. */
  private sweep(): void {
    const cutoff = this.now() - this.stalenessMs;
    for (const [key, device] of this.devices) {
      if (device.lastSeen < cutoff) {
        this.devices.delete(key);
        this.emit('removed', device);
      }
    }
  }

  private emit(event: DeviceEventType, device: StageLinqDevice): void {
    for (const listener of this.listeners) {
      try {
        listener(event, device);
      } catch {
        // Consumer errors must not break the device manager.
      }
    }
  }
}
