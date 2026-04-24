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
import { type AbsolutePosition, parseAbsolutePosition } from '../packets/absolute-position.js';
import { parseBeat } from '../packets/beat.js';
import { buildKeepAlive, parseKeepAlive } from '../packets/keepalive.js';
import { parseMixerStatus } from '../packets/mixer-status.js';
import { type ChannelsOnAir, parseOnAir } from '../packets/on-air.js';
import { parseStatus } from '../packets/status.js';
import type { Beat, CdjStatus, Device, MixerStatus, SelfIdentity } from '../packets/types.js';
import { hasProlinkHeader, KIND_OFFSET } from '../protocol/header.js';
import { BeatKind, DiscoveryKind, StatusKind } from '../protocol/kinds.js';
import { PORTS, type Port } from '../protocol/ports.js';
import {
  type TransportErrorHandler,
  UdpTransport,
  type UdpTransportOptions,
} from '../transport/udp.js';
import { Announcer, type AnnouncerOptions } from './announcer.js';
import { type DeviceListener, DeviceManager, type DeviceManagerOptions } from './device-manager.js';
import { type PhaseState, PhaseTracker, type PhaseTrackerOptions } from './phase-tracker.js';

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

/**
 * Beat-event handler. Called once per beat while a rekordbox-analyzed track
 * is playing. The `beat` carries BPM, pitch, beat-within-bar, and timing
 * intervals for sub-beat interpolation.
 */
export type BeatHandler = (beat: Beat) => void;

/**
 * CDJ status handler. Called once per inbound status packet (port 50002,
 * kind `0x0a`). Status packets arrive at ~200 ms cadence per player in
 * observer mode.
 */
export type StatusHandler = (status: CdjStatus) => void;

/**
 * Mixer status handler. Called once per inbound mixer status packet
 * (port 50002, kind `0x29`). Only fired when a standalone DJM mixer
 * is on the network — combo units like the XDJ-XZ send CDJ status
 * for each deck instead.
 */
export type MixerStatusHandler = (status: MixerStatus) => void;

/**
 * Channels-on-air handler. Called once per inbound on-air packet
 * (port 50001, kind `0x03`). Broadcast by standalone DJM mixers to
 * report which channels have their faders up.
 */
export type OnAirHandler = (onAir: ChannelsOnAir) => void;

/**
 * Absolute-position handler. Called once per inbound absolute-position
 * packet (port 50001, kind `0x0b`, every ~30 ms). CDJ-3000 only —
 * older hardware does not emit these.
 */
export type AbsolutePositionHandler = (position: AbsolutePosition) => void;

/**
 * Aggregated snapshot of everything known about a single deck (or mixer)
 * at a point in time. Composes data from multiple packet sources:
 *
 * - `device` — from keep-alive packets (always present)
 * - `status` — from CDJ status packets (observer mode only; null in
 *   passive mode or for non-CDJ devices)
 * - `phase` — interpolated from beat packets (null if no beats received
 *   or player is stale)
 * - `position` — from absolute-position packets (CDJ-3000 only)
 *
 * ```ts
 * const deck = observer.getDeck(1);
 * if (deck?.status?.isPlaying && deck.phase) {
 *   setLightIntensity(Math.sin(deck.phase.beat * 2 * Math.PI));
 * }
 * ```
 */
export interface DeckState {
  /** Player number (1–4 CDJ, 33 mixer). */
  readonly playerId: number;
  /** Device identity from keep-alive packets. */
  readonly device: Device;
  /** Latest CDJ status. `null` if no status received (passive mode, mixer, or pre-first-status). */
  readonly status: CdjStatus | null;
  /** Interpolated phase right now. `null` if no beats received or player is stale. */
  readonly phase: PhaseState | null;
  /** Latest absolute-position (CDJ-3000 only). `null` if device doesn't support it. */
  readonly position: AbsolutePosition | null;
}

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
  /** Optional phase-tracker tuning (staleness threshold, clock). */
  readonly phaseTracker?: PhaseTrackerOptions;
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
  private readonly phaseTracker: PhaseTracker;
  private readonly announcer: Announcer | null;
  private readonly rawPacketHandlers = new Set<RawPacketHandler>();
  private readonly beatHandlers = new Set<BeatHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly mixerStatusHandlers = new Set<MixerStatusHandler>();
  private readonly onAirHandlers = new Set<OnAirHandler>();
  private readonly absolutePositionHandlers = new Set<AbsolutePositionHandler>();
  /** Latest absolute-position per player (CDJ-3000 only). */
  private readonly positions = new Map<number, AbsolutePosition>();
  /** Latest CDJ status per player. */
  private readonly lastStatus = new Map<number, CdjStatus>();
  /**
   * Per-player dedup for beat packets. The XDJ-XZ (and possibly other combo
   * units) sends each beat packet twice, ~40–110 ms apart, with identical
   * payload. We store the timing-field bytes (offsets `0x24..0x3b`, 24 bytes)
   * of the last emitted beat per player and suppress duplicates.
   */
  private readonly lastBeatTiming = new Map<number, Uint8Array>();
  /** Player ID of the current tempo master, derived from status flags. */
  private masterId: number | null = null;
  /** Set of player IDs whose mixer channels are currently on-air. */
  private readonly onAirIds = new Set<number>();
  private started = false;

  constructor(options: ObserverOptions) {
    this.identity = options.identity;
    this.passive = options.passive ?? false;

    this.transport = new UdpTransport(options.transport);
    this.deviceManager = new DeviceManager(options.deviceManager);
    this.phaseTracker = new PhaseTracker(options.phaseTracker);
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

  /** Subscribe to beat events. Returns an unsubscribe fn. */
  onBeat(handler: BeatHandler): () => void {
    this.beatHandlers.add(handler);
    return () => {
      this.beatHandlers.delete(handler);
    };
  }

  /** Subscribe to CDJ status events. Returns an unsubscribe fn. */
  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  /** Subscribe to mixer status events. Returns an unsubscribe fn. */
  onMixerStatus(handler: MixerStatusHandler): () => void {
    this.mixerStatusHandlers.add(handler);
    return () => {
      this.mixerStatusHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to channels-on-air events. Returns an unsubscribe fn.
   *
   * These arrive from standalone DJM mixers only. Combo units (XDJ-XZ)
   * do not send them.
   */
  onOnAir(handler: OnAirHandler): () => void {
    this.onAirHandlers.add(handler);
    return () => {
      this.onAirHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to absolute-position events (CDJ-3000 only, ~30 ms).
   * Returns an unsubscribe fn.
   */
  onAbsolutePosition(handler: AbsolutePositionHandler): () => void {
    this.absolutePositionHandlers.add(handler);
    return () => {
      this.absolutePositionHandlers.delete(handler);
    };
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
   * The best-available phase right now. This is the primary API for
   * consumers who just want to sync to whatever the DJ is doing.
   *
   * Resolution order:
   *   1. Master deck (if known from status packets and actively beating).
   *   2. The only active player (if exactly one is sending beats).
   *   3. The active player with the lowest ID (deterministic tie-break).
   *
   * Returns `null` only when no player is sending beats at all.
   *
   * ```ts
   * const p = observer.phase;
   * if (p) setLightIntensity(Math.sin(p.beat * 2 * Math.PI));
   * ```
   */
  get phase(): PhaseState | null {
    return resolveBestPhase(this.masterId, this.phaseTracker);
  }

  /**
   * Interpolated phase for a specific player. Returns `null` if no
   * beats have been received for that player or it has gone stale.
   *
   * Prefer the `phase` getter unless you need a specific deck.
   */
  getPhase(playerId: number): PhaseState | null {
    return this.phaseTracker.getPhase(playerId);
  }

  /** Phase for all known, non-stale players. */
  phases(): PhaseState[] {
    return this.phaseTracker.all();
  }

  /**
   * Interpolated phase of the current tempo master. Returns `null` if
   * no master has been identified yet (no status packets received) or
   * if the master's phase is stale.
   */
  getMasterPhase(): PhaseState | null {
    if (this.masterId === null) return null;
    return this.phaseTracker.getPhase(this.masterId);
  }

  /** Player ID of the current tempo master, or `null` if unknown. */
  getMasterId(): number | null {
    return this.masterId;
  }

  /**
   * Phases of all players whose mixer channels are currently on-air.
   * During a transition this may include multiple players. Returns an
   * empty array if no on-air data is available (e.g. XDJ-XZ combo unit
   * doesn't set on-air for its own decks).
   */
  getOnAirPhases(): PhaseState[] {
    const result: PhaseState[] = [];
    for (const id of this.onAirIds) {
      const phase = this.phaseTracker.getPhase(id);
      if (phase) result.push(phase);
    }
    return result;
  }

  /**
   * Latest absolute-position for a specific player (CDJ-3000 only).
   * Returns `null` if no absolute-position packets have been received
   * from that player.
   */
  getPosition(playerId: number): AbsolutePosition | null {
    return this.positions.get(playerId) ?? null;
  }

  /**
   * Latest absolute-position for all players that have sent them.
   * Only CDJ-3000 and newer emit these packets.
   */
  getPositions(): AbsolutePosition[] {
    return [...this.positions.values()];
  }

  /**
   * Aggregated state for a single deck, combining data from all sources.
   * Returns `null` if the device has not been seen (no keep-alive received).
   *
   * The `phase` field is computed on-demand via the PhaseTracker, so it
   * reflects the current time, not the time the last packet arrived.
   */
  getDeck(playerId: number): DeckState | null {
    const device = this.deviceManager.get(playerId);
    if (!device) return null;
    return {
      playerId,
      device,
      status: this.lastStatus.get(playerId) ?? null,
      phase: this.phaseTracker.getPhase(playerId),
      position: this.positions.get(playerId) ?? null,
    };
  }

  /**
   * Aggregated state for all known devices. Each entry is a snapshot
   * composed from keep-alive, status, beat, and absolute-position data.
   *
   * This is the primary "give me everything you know" API for consumers
   * who need per-deck detail beyond the simple `phase` getter.
   */
  decks(): DeckState[] {
    const result: DeckState[] = [];
    for (const device of this.deviceManager.list()) {
      result.push({
        playerId: device.id,
        device,
        status: this.lastStatus.get(device.id) ?? null,
        phase: this.phaseTracker.getPhase(device.id),
        position: this.positions.get(device.id) ?? null,
      });
    }
    return result;
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
    this.phaseTracker.clear();
    this.masterId = null;
    this.onAirIds.clear();
    this.positions.clear();
    this.lastStatus.clear();
    this.started = false;
  }

  private handlePacket(packet: Uint8Array, remote: RemoteInfo, port: Port): void {
    // Capture high-resolution time early for accurate phase interpolation.
    const hrTime = performance.now();

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

    // Channels-on-air: update on-air set from authoritative mixer source.
    if (port === PORTS.BEAT && kind === BeatKind.CHANNELS_ON_AIR) {
      const onAir = parseOnAir(packet);
      if (onAir) {
        // Authoritative on-air state from the mixer. Update the set
        // for all channels the mixer reports on (typically 1–4).
        for (let i = 0; i < onAir.channels.length; i++) {
          const channelId = i + 1; // Channels are 1-based
          if (onAir.channels[i]) {
            this.onAirIds.add(channelId);
          } else {
            this.onAirIds.delete(channelId);
          }
        }

        for (const handler of this.onAirHandlers) {
          try {
            handler(onAir);
          } catch {
            // A faulty consumer handler must not break packet routing.
          }
        }
      }
    }

    // Absolute position: CDJ-3000 only, every ~30 ms.
    if (port === PORTS.BEAT && kind === BeatKind.ABSOLUTE_POSITION) {
      const pos = parseAbsolutePosition(packet);
      if (pos) {
        this.positions.set(pos.deviceId, pos);
        for (const handler of this.absolutePositionHandlers) {
          try {
            handler(pos);
          } catch {
            // A faulty consumer handler must not break packet routing.
          }
        }
      }
    }

    // Beat events: parse, deduplicate, feed phase tracker, dispatch handlers.
    if (port === PORTS.BEAT && kind === BeatKind.BEAT) {
      const beat = parseBeat(packet);
      if (beat && !this.isDuplicateBeat(beat.deviceId, packet)) {
        this.phaseTracker.ingest(beat, hrTime);
        for (const handler of this.beatHandlers) {
          try {
            handler(beat);
          } catch {
            // A faulty consumer handler must not break packet routing.
          }
        }
      }
    }

    // Mixer status: parse, update master tracking, dispatch handlers.
    if (port === PORTS.STATUS && kind === StatusKind.MIXER_STATUS) {
      const mixerStatus = parseMixerStatus(packet);
      if (mixerStatus) {
        // Track master — mixer can be the tempo master.
        if (mixerStatus.isMaster) {
          this.masterId = mixerStatus.deviceId;
        } else if (this.masterId === mixerStatus.deviceId) {
          this.masterId = null;
        }

        for (const handler of this.mixerStatusHandlers) {
          try {
            handler(mixerStatus);
          } catch {
            // A faulty consumer handler must not break packet routing.
          }
        }
      }
    }

    // CDJ status: parse, store, update master/on-air tracking, dispatch handlers.
    if (port === PORTS.STATUS && kind === StatusKind.CDJ_STATUS) {
      const status = parseStatus(packet);
      if (status) {
        this.lastStatus.set(status.deviceId, status);

        // Track master player.
        if (status.isMaster) {
          this.masterId = status.deviceId;
        } else if (this.masterId === status.deviceId) {
          // This player was master but no longer is.
          this.masterId = null;
        }

        // Track on-air state.
        if (status.isOnAir) {
          this.onAirIds.add(status.deviceId);
        } else {
          this.onAirIds.delete(status.deviceId);
        }

        for (const handler of this.statusHandlers) {
          try {
            handler(status);
          } catch {
            // A faulty consumer handler must not break packet routing.
          }
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

  /**
   * Detect duplicate beat packets by comparing the 24-byte timing-field
   * region (`0x24..0x3b`) against the last beat from the same player.
   * Updates the cache and returns `true` if this is a duplicate.
   */
  private isDuplicateBeat(deviceId: number, packet: Uint8Array): boolean {
    const TIMING_START = 0x24;
    const TIMING_END = 0x3c; // exclusive
    const timing = packet.subarray(TIMING_START, TIMING_END);

    const last = this.lastBeatTiming.get(deviceId);
    if (last && last.length === timing.length) {
      let same = true;
      for (let i = 0; i < timing.length; i++) {
        if (timing[i] !== last[i]) {
          same = false;
          break;
        }
      }
      if (same) return true;
    }

    // Store a copy — the packet buffer may be reused.
    this.lastBeatTiming.set(deviceId, new Uint8Array(timing));
    return false;
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

/**
 * Pick the best phase from available players. Pure function, exported
 * for testing without constructing a full Observer.
 *
 * Fallback chain:
 *   1. Master (if known and active).
 *   2. Sole active player.
 *   3. Active player with lowest ID (deterministic tie-break).
 */
export function resolveBestPhase(
  masterId: number | null,
  tracker: PhaseTracker,
): PhaseState | null {
  // 1. Master known and actively beating.
  if (masterId !== null) {
    const p = tracker.getPhase(masterId);
    if (p) return p;
  }

  // 2–3. All non-stale players, pick sole or lowest ID.
  const active = tracker.all();
  if (active.length === 0) return null;
  if (active.length === 1) return active[0] ?? null;
  return active.reduce((a, b) => (a.playerId < b.playerId ? a : b));
}
