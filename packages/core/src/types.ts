/**
 * Common types shared across all netBeat protocol implementations.
 *
 * Both `@netbeat/prolink` and `@netbeat/stagelinq` implement the `Observer`
 * interface defined here, making them interchangeable. Consumers who code
 * against these types can swap protocols — or observe both simultaneously
 * via `UnifiedObserver` — without changing their application code.
 */

/** Protocol identifier. */
export type Protocol = 'prolink' | 'stagelinq';

/** High-level device classification, shared across protocols. */
export type DeviceCategory = 'player' | 'controller' | 'mixer' | 'unknown';

/** Device lifecycle event type. */
export type DeviceEvent = 'added' | 'updated' | 'removed';

/**
 * A device observed on the network. Both Pioneer CDJs and Denon Prime
 * hardware are represented by this common shape.
 *
 * Protocol packages extend this with extra fields (e.g., `playerId` for
 * prolink, `deviceId` UUID for stagelinq). Thanks to structural typing,
 * the extended types satisfy this interface automatically.
 */
export interface Device {
  /** Opaque unique identifier. Format is protocol-specific, not meant to be parsed. */
  readonly id: string;
  /** Human-readable device name (e.g., "CDJ-3000", "SC6000", "PRIME 4"). */
  readonly name: string;
  /** High-level device classification. */
  readonly category: DeviceCategory;
  /** IP address of the device. */
  readonly address: string;
  /** Number of playback decks on this device (0 for standalone mixers). */
  readonly deckCount: number;
  /** Which protocol this device speaks. */
  readonly protocol: Protocol;
}

/**
 * Basic track metadata available from both protocols.
 *
 * Protocol packages may surface richer metadata (beat grid, cues, phrases
 * for prolink; track length, album for stagelinq) through their own types.
 */
export interface TrackInfo {
  readonly title: string | null;
  readonly artist: string | null;
}

/**
 * Interpolated beat/bar phase at a point in time.
 *
 * This is the primary type for beat-sync consumers. Poll `observer.phase`
 * in a render loop:
 *
 * ```ts
 * const p = observer.phase;
 * if (p) setIntensity(Math.sin(p.beat * 2 * Math.PI));
 * ```
 *
 * Values are computed on-demand using high-resolution monotonic time, so
 * they reflect the *current* moment — not when the last packet arrived.
 */
export interface PhaseState {
  /** Fraction through the current beat, [0, 1). 0 = on the beat. */
  readonly beat: number;
  /**
   * Fraction through the current bar (4 beats), [0, 1).
   * 0 = downbeat (beat 1), 0.25 = beat 2, 0.5 = beat 3, 0.75 = beat 4.
   */
  readonly bar: number;
  /** Which beat in the bar we're currently on (1–4). */
  readonly beatInBar: number;
  /** Effective BPM (pitch-adjusted). */
  readonly bpm: number;

  /** Seconds elapsed since the last beat. */
  readonly beatElapsed: number;
  /** Seconds remaining until the next beat. */
  readonly beatRemaining: number;
  /** Seconds elapsed since the last downbeat (beat 1). */
  readonly barElapsed: number;
  /** Seconds remaining until the next downbeat. */
  readonly barRemaining: number;
}

/**
 * Aggregated snapshot of a single deck at a point in time.
 *
 * This is the common shape returned by all three Observer implementations.
 * Protocol packages extend it with extras (e.g., `CdjStatus` for prolink,
 * `DeckBeatInfo` for stagelinq).
 */
export interface DeckState {
  /** Opaque deck ID, unique across all devices and protocols. */
  readonly id: string;
  /** The device this deck belongs to. */
  readonly device: Device;
  /** 1-based deck number on the device. Always 1 for single-deck devices (Pioneer CDJs). */
  readonly deckNumber: number;
  /** Whether the deck is actively playing audio. */
  readonly isPlaying: boolean;
  /** Effective BPM (0 if unknown). */
  readonly bpm: number;
  /** Interpolated beat/bar phase. `null` if no beat data available. */
  readonly phase: PhaseState | null;
  /** Whether this deck is the tempo master. */
  readonly isMaster: boolean;
  /** Whether this deck's channel is on-air (fader up). */
  readonly isOnAir: boolean;
  /** Basic track metadata. `null` if no track is loaded. */
  readonly track: TrackInfo | null;
}

// ── Event handler types ──────────────────────────────────────────────────

export type DeviceListener = (event: DeviceEvent, device: Device) => void;
export type DeckUpdateListener = (deck: DeckState) => void;

// ── Observer interface ───────────────────────────────────────────────────

/**
 * Common observer interface implemented by all three netBeat packages:
 *
 * - `@netbeat/prolink` — Pioneer Pro DJ Link
 * - `@netbeat/stagelinq` — Denon StageLinQ
 * - `@netbeat/core` — `UnifiedObserver` (runs both simultaneously)
 *
 * The interface is intentionally minimal: lifecycle, events, state queries,
 * and phase. Protocol-specific features (raw packets, mixer status, state
 * paths, file transfer) remain on each package's Observer class.
 */
export interface Observer {
  /** Bring the observer online (bind sockets, start discovery). */
  start(): Promise<void>;
  /** Take the observer offline (close connections, stop discovery). */
  stop(): Promise<void>;

  /**
   * Subscribe to device lifecycle events. Returns an unsubscribe function.
   * Fires when devices appear, update, or disappear from the network.
   */
  onDevice(listener: DeviceListener): () => void;

  /**
   * Subscribe to deck state changes. Returns an unsubscribe function.
   * Fires on meaningful state changes: play/pause, BPM, track load,
   * master/on-air toggle. Does NOT fire on every beat — poll `phase`
   * for smooth beat-sync instead.
   */
  onDeckUpdate(listener: DeckUpdateListener): () => void;

  /** All currently known devices. */
  devices(): Device[];

  /** Aggregated state for all decks with active devices. */
  decks(): DeckState[];

  /** State for a specific deck by its opaque ID. */
  getDeck(deckId: string): DeckState | null;

  /**
   * Best-available phase right now. Designed to be polled in a render loop.
   *
   * Resolution: master deck → sole active deck → lowest-ID active deck.
   * Returns `null` only when no deck is actively sending beat data.
   */
  readonly phase: PhaseState | null;

  /** Phase for a specific deck. `null` if no beat data or deck is stale. */
  getPhase(deckId: string): PhaseState | null;

  /** Phase for all non-stale decks. */
  phases(): PhaseState[];
}
