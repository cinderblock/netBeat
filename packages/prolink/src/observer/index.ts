/**
 * `Observer` — the public entry point for observer mode.
 *
 * Observer mode poses as a CDJ on the network: it broadcasts keep-alive
 * packets every 1.5 s so peers send unicast status + beat traffic to us,
 * but it never emits sync, control, or load-track commands. That matches
 * the project's read-only posture (see `docs/research.md` §"Notes on
 * read-only ethics") while still unlocking the unicast-gated data we need
 * for a full picture of what the DJ is doing.
 *
 * The alternative — pure-passive mode, receiving broadcasts only — is a
 * strict subset; we'll expose it later as a flag that disables the
 * announcer.
 *
 * Consumer surface:
 *
 *   const observer = new Observer({
 *     identity: { id: 7, name: 'netbeat', ip, mac, rawType: 0x01 },
 *   });
 *   observer.onDevice((event, device) => console.log(event, device));
 *   observer.onPacket((kind, packet, remote, port) => ...);
 *   await observer.start();
 *   ...
 *   await observer.stop();
 *
 * Packet-level events are surfaced raw so later modules (beat parser,
 * status parser) can be layered on without changing this class.
 */

import type { RemoteInfo } from 'node:dgram';
import { buildKeepAlive, parseKeepAlive } from '../packets/keepalive.js';
import type { Device, SelfIdentity } from '../packets/types.js';
import { hasProlinkHeader, KIND_OFFSET } from '../protocol/header.js';
import { DiscoveryKind } from '../protocol/kinds.js';
import { PORTS, type Port } from '../protocol/ports.js';
import {
  type TransportErrorHandler,
  UdpTransport,
  type UdpTransportOptions,
} from '../transport/udp.js';
import { Announcer, type AnnouncerOptions } from './announcer.js';
import { type DeviceListener, DeviceManager, type DeviceManagerOptions } from './device-manager.js';

/**
 * Raw-packet handler. Called once per inbound UDP datagram that carries a
 * valid Pro DJ Link header; `kind` is the discriminator byte (same value
 * `readKind()` would return). Packets that fail the header check are
 * dropped silently.
 */
export type RawPacketHandler = (
  kind: number,
  packet: Uint8Array,
  remote: RemoteInfo,
  port: Port,
) => void;

export interface ObserverOptions {
  /**
   * Who we announce ourselves as. The `ip` and `mac` must match the local
   * network interface the announce socket will actually send from, or
   * peers will send their unicast replies to an unreachable destination.
   *
   * Convention for observer mode: pick an `id` outside 1..4 (e.g. 7) to
   * avoid contending with real CDJs. See `docs/research.md` §"four-players".
   */
  readonly identity: SelfIdentity;
  /** Optional transport configuration (bind address, broadcast address). */
  readonly transport?: UdpTransportOptions;
  /** Optional announcer tuning (interval, error sink). */
  readonly announcer?: AnnouncerOptions;
  /** Optional device-manager tuning (timeout, sweep interval, clock). */
  readonly deviceManager?: DeviceManagerOptions;
  /**
   * If true, skip the announcer — runs in pure-passive mode. We'll still
   * receive broadcasts (keep-alives, beats, absolute-position, on-air
   * flags) but no unicast status traffic. Useful for sniffing without
   * disturbing the network. Default: `false` (true observer mode).
   */
  readonly passive?: boolean;
}

/**
 * Observer mode orchestrator. Owns transport, device manager, announcer.
 */
export class Observer {
  private readonly identity: SelfIdentity;
  private readonly passive: boolean;
  private readonly transport: UdpTransport;
  private readonly deviceManager: DeviceManager;
  private readonly announcer: Announcer | null;
  private readonly rawPacketHandlers = new Set<RawPacketHandler>();
  private started = false;

  constructor(options: ObserverOptions) {
    this.identity = options.identity;
    this.passive = options.passive ?? false;

    this.transport = new UdpTransport(options.transport);
    this.deviceManager = new DeviceManager(options.deviceManager);
    this.announcer = this.passive
      ? null
      : new Announcer(this.transport, () => buildKeepAlive(this.identity), options.announcer);

    this.transport.onPacket((packet, remote, port) => {
      this.handlePacket(packet, remote, port);
    });
  }

  /** Subscribe to device add/update/remove events. Returns an unsubscribe fn. */
  onDevice(listener: DeviceListener): () => void {
    return this.deviceManager.onEvent(listener);
  }

  /** Subscribe to every validated inbound packet. Returns an unsubscribe fn. */
  onPacket(handler: RawPacketHandler): () => void {
    this.rawPacketHandlers.add(handler);
    return () => {
      this.rawPacketHandlers.delete(handler);
    };
  }

  /** Forward transport-level socket errors. */
  onTransportError(handler: TransportErrorHandler): void {
    this.transport.onError(handler);
  }

  /** Snapshot of currently known devices. */
  devices(): Device[] {
    return this.deviceManager.list();
  }

  /**
   * Bring the observer online. Order of operations:
   *   1. Bind the three UDP sockets.
   *   2. Start the device-manager sweep timer.
   *   3. Start the announcer (unless passive).
   *
   * The announcer sends one keep-alive immediately so peers start unicast-
   * ing to us as quickly as possible.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.transport.start();
      this.deviceManager.start();
      if (this.announcer) await this.announcer.start();
    } catch (err) {
      this.started = false;
      // Partial startup is worse than clean failure — tear down.
      await this.stop().catch(() => {});
      throw err;
    }
  }

  /** Take the observer offline. Safe to call even if already stopped. */
  async stop(): Promise<void> {
    this.announcer?.stop();
    this.deviceManager.stop();
    await this.transport.stop();
    this.deviceManager.clear();
    this.started = false;
  }

  private handlePacket(packet: Uint8Array, remote: RemoteInfo, port: Port): void {
    if (!hasProlinkHeader(packet)) return;
    const kind = packet[KIND_OFFSET] ?? -1;

    // Device discovery: promote keep-alives into DeviceManager.
    if (port === PORTS.DISCOVERY && kind === DiscoveryKind.KEEP_ALIVE) {
      const device = parseKeepAlive(packet);
      if (device) {
        // Ignore echoes of our own announcements. We can't compare on IP
        // alone (multiple peers share a subnet); the MAC+id pair is the
        // strongest identity signal we have for ourselves.
        if (!this.isSelf(device)) {
          this.deviceManager.ingest(device);
        }
      }
    }

    for (const handler of this.rawPacketHandlers) {
      try {
        handler(kind, packet, remote, port);
      } catch {
        // A faulty consumer handler must not break packet routing.
      }
    }
  }

  private isSelf(device: Device): boolean {
    if (device.id !== this.identity.id) return false;
    if (device.mac.length !== this.identity.mac.length) return false;
    for (let i = 0; i < device.mac.length; i++) {
      if (device.mac[i] !== this.identity.mac[i]) return false;
    }
    return true;
  }
}
