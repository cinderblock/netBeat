/**
 * Shared runtime types that describe devices we observe on the network.
 *
 * The wire formats that produce these values live in sibling modules
 * (`keepalive.ts`, future `beat.ts`, `status.ts`). This file intentionally
 * has no parsing logic — just the value shapes we hand to library consumers.
 */

/**
 * High-level device category, derived from the device-type byte at packet
 * offset `0x34` of a keep-alive. Source:
 * `prolink-connect/src/types.ts::DeviceType` and
 * `dysentery/.../startup.adoc`.
 *
 * The byte value is preserved in `rawType` on the device so callers can
 * distinguish models if needed.
 */
export type DeviceType = 'cdj' | 'mixer' | 'rekordbox' | 'unknown';

/** Numeric device-type byte values observed on the wire. */
export const DEVICE_TYPE_BYTE = {
  CDJ: 0x01,
  MIXER: 0x02,
  /**
   * `0x03` and `0x04` have both been seen: prolink-connect labels `0x03`
   * Mixer and `0x04` Rekordbox, while dysentery's startup docs describe
   * `0x02` as the mixer. We keep both interpretations.
   */
  MIXER_ALT: 0x03,
  REKORDBOX: 0x04,
} as const;

/**
 * A device observed on the Pro DJ Link network.
 *
 * `id` is the player number broadcast by the device:
 *   - `1`..`4` — CDJ slots (standard)
 *   - `5`..`6` — additional CDJ slots (CDJ-3000 era)
 *   - `0x21` (33) — mixer
 *   - `0x11` (17) — commonly observed for rekordbox laptop (unconfirmed;
 *     prolink-connect treats rekordbox IDs generically)
 *
 * `ip` is dotted-quad. `mac` is the raw 6-byte hardware address, copied out
 * of the underlying packet buffer so it survives past the packet's lifetime.
 */
export interface Device {
  /** Player number (`D` in dysentery notation). */
  readonly id: number;
  /** NUL-trimmed ASCII device name, up to 20 chars. */
  readonly name: string;
  /** Dotted-quad IPv4 address. */
  readonly ip: string;
  /** 6-byte hardware address, independent copy of the packet bytes. */
  readonly mac: Uint8Array;
  /** Interpreted device type. */
  readonly type: DeviceType;
  /** Raw device-type byte (`0x34` of the keep-alive). */
  readonly rawType: number;
  /** Local timestamp at which we last received a keep-alive from this device. */
  readonly lastSeen: Date;
}

/**
 * Subset of `Device` used when announcing ourselves as a virtual CDJ. The
 * fields here are everything a keep-alive packet carries; `lastSeen` is
 * computed by the receiver.
 */
/**
 * A single beat event parsed from a beat packet (port 50001, kind `0x28`).
 *
 * Beat packets are emitted once per beat while a rekordbox-analyzed track is
 * playing. They carry the current BPM (before and after pitch adjustment),
 * the beat position within the bar (1..4), and countdown timers to upcoming
 * beats and downbeats.
 *
 * The `deviceId` field is the player number and is the primary key for
 * matching this beat to a device from the DeviceManager. The `deviceName`
 * field is a convenience parsed from the packet; on some hardware (XDJ-XZ)
 * it may be truncated by one character — always prefer `deviceId` for
 * identity.
 */
export interface Beat {
  /** Player number that emitted this beat (1–4 CDJ, 33 mixer). */
  readonly deviceId: number;
  /** Device name from the beat packet (may be truncated; use `deviceId` for identity). */
  readonly deviceName: string;
  /**
   * Track BPM as analyzed by rekordbox, before pitch adjustment.
   * `0xffff` raw (655.35) indicates no track is loaded.
   */
  readonly trackBpm: number;
  /** Effective BPM accounting for the pitch fader: `trackBpm × pitchMultiplier`. */
  readonly effectiveBpm: number;
  /**
   * Pitch fader position as a percentage (−100 to +100, 0 = normal).
   * Computed from the 24-bit pitch value at offset `0x55`.
   */
  readonly pitch: number;
  /** Beat position within the current bar (1..4). */
  readonly beatInBar: number;
  /**
   * Milliseconds until the next beat at normal tempo.
   * `0xffffffff` = track ends before that beat.
   *
   * All timing fields are at *normal* tempo; divide by `pitchMultiplier`
   * (i.e. `(100 + pitch) / 100`) to get wall-clock estimates.
   */
  readonly nextBeat: number;
  /** Milliseconds until the 2nd beat from now (normal tempo). */
  readonly secondBeat: number;
  /** Milliseconds until the next downbeat (beat 1 of next bar, normal tempo). */
  readonly nextBar: number;
  /** Milliseconds until the 4th beat from now (normal tempo). */
  readonly fourthBeat: number;
  /** Milliseconds until the 2nd downbeat from now (normal tempo). */
  readonly secondBar: number;
  /** Milliseconds until the 8th beat from now (normal tempo). */
  readonly eighthBeat: number;
  /** Local timestamp when this beat packet was received. */
  readonly timestamp: Date;
}

/**
 * Sentinel value in beat timing fields indicating the track ends before
 * that beat would be reached. Equal to `0xffffffff`.
 */
export const BEAT_TIMING_TRACK_ENDS = 0xffffffff;

/**
 * A CDJ status event parsed from a status packet (port 50002, kind `0x0a`).
 *
 * Status packets are unicast at ~200 ms cadence to endpoints that announced
 * keep-alives (observer mode). They carry the richest per-deck data:
 * play/pause, master/sync, BPM, pitch, track ID, beat counter, on-air state.
 *
 * Packet length varies by model (208–512 bytes). All offsets used here are
 * safe for packets ≥ 204 bytes (`STATUS_MIN_LENGTH`).
 */
export interface CdjStatus {
  /** Player number that emitted this status (1–4 CDJ, 33 mixer). */
  readonly deviceId: number;
  /** Device name from the packet (may be truncated on XDJ-XZ). */
  readonly deviceName: string;

  // ---- Track identification ----
  /** Source device for the loaded track. */
  readonly trackDeviceId: number;
  /** Media slot: 0 none, 1 CD, 2 SD, 3 USB, 4 rekordbox, etc. */
  readonly trackSlot: number;
  /** Track type: 0 none, 1 rekordbox, 2 unanalyzed, 5 CD-DA, 6 streaming. */
  readonly trackType: number;
  /** Rekordbox track ID (slot-relative). 0 = no track. */
  readonly trackId: number;

  // ---- State flags ----
  /** Detailed play state enum (0x03 playing, 0x05 paused, etc.). */
  readonly playState: number;
  /** True when the deck is actively playing audio (play state 0x03 or 0x04). */
  readonly isPlaying: boolean;
  /** True when this deck is the tempo master. */
  readonly isMaster: boolean;
  /** True when sync mode is engaged. */
  readonly isSync: boolean;
  /** True when the mixer reports this channel on-air (fader up, not crossfaded out). */
  readonly isOnAir: boolean;
  /** Raw status flags bitmask (0x89). Escape hatch for undocumented bits. */
  readonly statusFlags: number;

  // ---- Tempo ----
  /** Track BPM as analyzed by rekordbox, before pitch adjustment. */
  readonly trackBpm: number;
  /** Effective BPM after pitch adjustment. */
  readonly effectiveBpm: number;
  /** Applied pitch as a percentage (−100 to +100). */
  readonly pitch: number;

  // ---- Position ----
  /** Beat counter from start of track. `0xffffffff` = not available. */
  readonly beatCounter: number;
  /** Beat position within the bar (1–4). 0 = no track / no analysis. */
  readonly beatInBar: number;
  /** Beats remaining until next cue. `0x01ff` = none. */
  readonly beatsUntilCue: number;

  // ---- Meta ----
  /** Packet sequence counter. */
  readonly packetCounter: number;
  /** Master-handoff byte. `0xff` normally; otherwise the player taking over. */
  readonly masterHandoff: number;
  /** Local timestamp when this status was received. */
  readonly timestamp: Date;
}

/**
 * A mixer status event parsed from a mixer status packet (port 50002,
 * kind `0x29`). Sent by standalone DJM mixers at ~200 ms cadence.
 *
 * The mixer status carries the mixer's view of tempo (BPM) and whether
 * it is the tempo master. Unlike CDJ status, the mixer's pitch is always
 * 0 % (mixers don't have a pitch fader), and the beat-within-bar field is
 * unreliable (not aligned to the master deck's bar position).
 *
 * Combo units like the XDJ-XZ do not send mixer status packets — they
 * announce each deck as a separate CDJ with CDJ status instead.
 */
export interface MixerStatus {
  /** Device ID (usually 0x21 = 33 for DJM mixers). */
  readonly deviceId: number;
  /** Device name from the packet. */
  readonly deviceName: string;
  /** True when the mixer is the tempo master. */
  readonly isMaster: boolean;
  /** Raw status flags byte at offset 0x27. */
  readonly statusFlags: number;
  /** Master BPM reported by the mixer (already effective — no pitch adjustment). */
  readonly bpm: number;
  /** Beat-within-bar (1–4). Unreliable — not necessarily aligned with the master deck. */
  readonly beatInBar: number;
  /** Master-handoff byte. `0xff` = none; otherwise the player taking over. */
  readonly masterHandoff: number;
  /** Local timestamp when this packet was received. */
  readonly timestamp: Date;
}

export interface SelfIdentity {
  /** Player number to claim. Observer mode defaults are outside 1..4 to avoid remotedb contention. */
  readonly id: number;
  /** Human-readable name, ≤ 20 ASCII chars (truncated if longer). */
  readonly name: string;
  /** Dotted-quad IPv4 address of the interface we're announcing from. */
  readonly ip: string;
  /** 6-byte hardware address of the interface we're announcing from. */
  readonly mac: Uint8Array;
  /** Device-type byte to advertise. Defaults to `cdj` (`0x01`). */
  readonly rawType: number;
}
