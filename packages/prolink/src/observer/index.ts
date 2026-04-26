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
import type { Observer as CoreObserver, DeckUpdateListener, TrackInfo } from '@netbeat/core';
import type { MetadataStore } from '../metadata/media-reader.js';
import type { TrackAnalysis } from '../metadata/types.js';
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
 * Track analysis handler. Called when a track's metadata + analysis data
 * has been fetched (or re-fetched) from the media. The `playerId` identifies
 * which deck loaded the track.
 */
export type TrackAnalysisHandler = (playerId: number, analysis: TrackAnalysis) => void;

/**
 * Aggregated snapshot of everything known about a single deck (or mixer)
 * at a point in time.
 *
 * Extends the common `DeckState` from `@netbeat/core` with prolink-specific
 * data: raw CDJ status, absolute position (CDJ-3000), and full track analysis
 * (beat grid, cues, phrases).
 *
 * ```ts
 * const deck = observer.getDeck('prolink:1:1');
 * if (deck?.isPlaying && deck.phase) {
 *   setLightIntensity(Math.sin(deck.phase.beat * 2 * Math.PI));
 * }
 * ```
 */
export interface DeckState {
  // ── Common fields (from @netbeat/core DeckState) ──

  /** Opaque deck ID: `"prolink:{playerId}:1"`. */
  readonly id: string;
  /** Device identity from keep-alive packets. */
  readonly device: Device;
  /** Always 1 for prolink (each CDJ is a single-deck device). */
  readonly deckNumber: number;
  /** Whether the deck is actively playing audio. */
  readonly isPlaying: boolean;
  /** Effective BPM (pitch-adjusted). 0 if unknown. */
  readonly bpm: number;
  /** Interpolated phase right now. `null` if no beats received or player is stale. */
  readonly phase: PhaseState | null;
  /** Whether this deck is the tempo master. */
  readonly isMaster: boolean;
  /** Whether this deck's channel is on-air (fader up). */
  readonly isOnAir: boolean;
  /** Basic track info (title, artist). `null` if no metadata available. */
  readonly track: TrackInfo | null;

  // ── Prolink-specific fields ──

  /** Player number (1–4 CDJ, 33 mixer). */
  readonly playerId: number;
  /** Latest CDJ status. `null` if no status received (passive mode, mixer, or pre-first-status). */
  readonly status: CdjStatus | null;
  /** Latest absolute-position (CDJ-3000 only). `null` if device doesn't support it. */
  readonly position: AbsolutePosition | null;
  /** Track analysis (metadata + beat grid + cues + phrases). `null` if no metadata store configured or track not yet fetched. */
  readonly trackAnalysis: TrackAnalysis | null;
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
  /**
   * Optional MetadataStore for auto-fetching track analysis when a
   * player loads a new track. The store must be loaded (call
   * `store.loadDatabase()`) before passing it here.
   */
  readonly metadataStore?: MetadataStore;
}

/**
 * Observer mode orchestrator. Owns transport, device manager, announcer.
 *
 * Implements the common `Observer` interface from `@netbeat/core`, making it
 * interchangeable with `@netbeat/stagelinq`'s Observer and `UnifiedObserver`.
 */
export class Observer implements CoreObserver {
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
  private readonly trackAnalysisHandlers = new Set<TrackAnalysisHandler>();
  private readonly deckUpdateListeners = new Set<DeckUpdateListener>();
  /** Latest absolute-position per player (CDJ-3000 only). */
  private readonly positions = new Map<number, AbsolutePosition>();
  /** Latest CDJ status per player. */
  private readonly lastStatus = new Map<number, CdjStatus>();
  /** Last known track ID per player (for change detection). */
  private readonly lastTrackId = new Map<number, number>();
  /** Cached track analysis per player. */
  private readonly trackAnalysisMap = new Map<number, TrackAnalysis>();
  /** Optional metadata store for auto-fetching track analysis. */
  private readonly metadataStore: MetadataStore | null;
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
    this.metadataStore = options.metadataStore ?? null;

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

  /**
   * Subscribe to track analysis events. Called when a new track's metadata
   * has been auto-fetched from the metadata store. Requires a `metadataStore`
   * in the observer options. Returns an unsubscribe fn.
   */
  onTrackAnalysis(handler: TrackAnalysisHandler): () => void {
    this.trackAnalysisHandlers.add(handler);
    return () => {
      this.trackAnalysisHandlers.delete(handler);
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
   * Interpolated phase for a specific deck by its string ID.
   * Returns `null` if no beats have been received or the deck is stale.
   *
   * Prefer the `phase` getter unless you need a specific deck.
   */
  getPhase(deckId: string): PhaseState | null {
    const playerId = parseProlinkDeckId(deckId);
    if (playerId === null) return null;
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
   * Subscribe to deck state changes (common interface). Returns an
   * unsubscribe function. Fires on CDJ status updates and track analysis
   * loads — not on every beat (poll `phase` for smooth beat-sync).
   */
  onDeckUpdate(listener: DeckUpdateListener): () => void {
    this.deckUpdateListeners.add(listener);
    return () => {
      this.deckUpdateListeners.delete(listener);
    };
  }

  /**
   * Aggregated state for a single deck by its string ID.
   * Format: `"prolink:{playerId}:1"` or just `"prolink:{playerId}"`.
   * Returns `null` if the device has not been seen.
   *
   * The `phase` field is computed on-demand via the PhaseTracker, so it
   * reflects the current time, not the time the last packet arrived.
   */
  getDeck(deckId: string): DeckState | null {
    const playerId = parseProlinkDeckId(deckId);
    if (playerId === null) return null;
    return this.buildDeckState(playerId);
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
      const deck = this.buildDeckState(device.playerId);
      if (deck) result.push(deck);
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
    this.lastTrackId.clear();
    this.trackAnalysisMap.clear();
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

        // Detect track changes and auto-fetch metadata.
        if (this.metadataStore && status.trackId > 0) {
          const prevTrackId = this.lastTrackId.get(status.deviceId);
          if (prevTrackId !== status.trackId) {
            this.lastTrackId.set(status.deviceId, status.trackId);
            this.fetchTrackAnalysis(status.deviceId, status.trackId);
          }
        }

        for (const handler of this.statusHandlers) {
          try {
            handler(status);
          } catch {
            // A faulty consumer handler must not break packet routing.
          }
        }

        // Emit deck update for the common interface.
        this.emitDeckUpdate(status.deviceId);
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

  /**
   * Asynchronously fetch track analysis from the metadata store.
   * Fire-and-forget — errors are swallowed to avoid disrupting
   * the packet-handling loop.
   */
  private fetchTrackAnalysis(playerId: number, trackId: number): void {
    if (!this.metadataStore) return;
    const store = this.metadataStore;

    store
      .getTrackAnalysis(trackId)
      .then((analysis) => {
        if (!analysis) return;
        this.trackAnalysisMap.set(playerId, analysis);
        for (const handler of this.trackAnalysisHandlers) {
          try {
            handler(playerId, analysis);
          } catch {
            // A faulty consumer handler must not break the observer.
          }
        }
        // Emit deck update with new track info.
        this.emitDeckUpdate(playerId);
      })
      .catch(() => {
        // Metadata fetch failed — silently continue.
      });
  }

  /**
   * Build the aggregated DeckState for a given player number.
   * Returns `null` if the device has not been seen.
   */
  private buildDeckState(playerId: number): DeckState | null {
    const device = this.deviceManager.get(playerId);
    if (!device) return null;

    const status = this.lastStatus.get(playerId) ?? null;
    const trackAnalysis = this.trackAnalysisMap.get(playerId) ?? null;
    const metadata = trackAnalysis?.metadata ?? null;
    const track: TrackInfo | null = metadata
      ? { title: metadata.title, artist: metadata.artist }
      : null;

    return {
      // Common DeckState fields
      id: `prolink:${playerId}:1`,
      device,
      deckNumber: 1,
      isPlaying: status?.isPlaying ?? false,
      bpm: status?.effectiveBpm ?? 0,
      phase: this.phaseTracker.getPhase(playerId),
      isMaster: status?.isMaster ?? false,
      isOnAir: status?.isOnAir ?? false,
      track,
      // Prolink-specific fields
      playerId,
      status,
      position: this.positions.get(playerId) ?? null,
      trackAnalysis,
    };
  }

  /** Emit onDeckUpdate to all listeners. Swallows consumer errors. */
  private emitDeckUpdate(playerId: number): void {
    if (this.deckUpdateListeners.size === 0) return;
    const deck = this.buildDeckState(playerId);
    if (!deck) return;
    for (const listener of this.deckUpdateListeners) {
      try {
        listener(deck);
      } catch {
        // Consumer errors must not break the observer.
      }
    }
  }

  private isSelf(device: Device): boolean {
    if (device.playerId !== this.identity.id) return false;
    if (device.mac.length !== this.identity.mac.length) return false;
    for (let i = 0; i < device.mac.length; i++) {
      if (device.mac[i] !== this.identity.mac[i]) return false;
    }
    return true;
  }
}

/**
 * Parse a common deck ID string into a prolink player number.
 * Accepts `"prolink:{playerId}"` or `"prolink:{playerId}:1"`.
 * Returns `null` for unrecognized formats.
 */
function parseProlinkDeckId(deckId: string): number | null {
  const match = /^prolink:(\d+)(?::1)?$/u.exec(deckId);
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 10);
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
