/**
 * Tracks devices we've seen on the network and emits add / update / remove
 * events so consumers can keep a live inventory without polling.
 *
 * The source of truth is "most recent keep-alive per player number". Real
 * hardware broadcasts every ~1.5 s, so after one full cycle we have a
 * complete picture. Devices that stop broadcasting are considered gone
 * after `timeoutMs` with no packet — the default (5 s) is roughly 3 missed
 * keep-alives.
 *
 * Two pieces of identity exist: `id` (player number, how the wire
 * identifies devices) and `mac` (how they physically identify themselves).
 * We key by `id` because that matches how every other packet references
 * devices, but surface `mac` so consumers can distinguish a physical
 * device that briefly re-announced under a different ID.
 */

import type { Device } from '../packets/types.js';

export type DeviceEvent = 'added' | 'updated' | 'removed';

export type DeviceListener = (event: DeviceEvent, device: Device) => void;

export interface DeviceManagerOptions {
  /**
   * How long (ms) without a keep-alive before we declare a device gone.
   * Default: 5000 ms (≈3 missed broadcasts at the 1.5 s cadence).
   */
  readonly timeoutMs?: number;
  /**
   * How often (ms) to scan for timed-out devices. Default: 1000 ms.
   * Lower = faster eviction, higher cost.
   */
  readonly sweepIntervalMs?: number;
  /**
   * Injectable clock for tests. Defaults to `() => new Date()`.
   */
  readonly now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_SWEEP_INTERVAL_MS = 1000;

/**
 * Stateful registry of devices keyed by player number.
 *
 * Lifecycle:
 *   const mgr = new DeviceManager();
 *   mgr.start();           // begins the eviction sweep
 *   mgr.onEvent(cb);
 *   mgr.ingest(device);    // call for each parsed keep-alive
 *   ...
 *   mgr.stop();            // stops the sweep; listeners are kept so a
 *                          // restart is a no-op
 */
export class DeviceManager {
  private readonly devices = new Map<number, Device>();
  private readonly listeners = new Set<DeviceListener>();
  private readonly timeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => Date;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DeviceManagerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** Subscribe to add/update/remove events. Returns an unsubscribe function. */
  onEvent(listener: DeviceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot of currently known devices, ordered by player number. */
  list(): Device[] {
    return [...this.devices.values()].sort((a, b) => a.id - b.id);
  }

  /** Look up a device by player number, or `undefined` if unknown. */
  get(id: number): Device | undefined {
    return this.devices.get(id);
  }

  /**
   * Ingest a freshly parsed keep-alive. Emits `'added'` the first time we
   * see an ID, and `'updated'` for every subsequent keep-alive (even if
   * nothing about the device changed — `lastSeen` always moves forward,
   * and consumers may care about the liveness heartbeat).
   */
  ingest(device: Device): void {
    const existing = this.devices.get(device.id);
    this.devices.set(device.id, device);
    this.emit(existing ? 'updated' : 'added', device);
  }

  /** Begin periodic timeout sweeps. Idempotent. */
  start(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    // Don't keep the Node process alive just for the sweep timer.
    this.sweepTimer.unref?.();
  }

  /** Stop the sweep timer. Listeners and device state are preserved. */
  stop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Explicitly trigger a timeout pass. Useful in tests that advance a
   * virtual clock without waiting for the interval.
   */
  sweep(): void {
    const cutoff = this.now().getTime() - this.timeoutMs;
    for (const [id, device] of this.devices) {
      if (device.lastSeen.getTime() < cutoff) {
        this.devices.delete(id);
        this.emit('removed', device);
      }
    }
  }

  /** Forget everything without emitting events. Intended for teardown. */
  clear(): void {
    this.devices.clear();
  }

  private emit(event: DeviceEvent, device: Device): void {
    for (const listener of this.listeners) {
      try {
        listener(event, device);
      } catch {
        // Listener errors must not break the ingest path or starve other
        // listeners. Surface via onError on Observer if needed later.
      }
    }
  }
}
