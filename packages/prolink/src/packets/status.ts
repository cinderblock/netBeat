/**
 * CDJ status packet (port 50002, kind `0x0a`).
 *
 * The richest per-deck data source: play state, master/sync/on-air flags,
 * BPM, pitch, track ID, beat counter. Unicast to endpoints that announced
 * keep-alives (observer mode only — passive listeners never see these).
 *
 * Wire layout — variable length by model:
 *   - CDJ-2000 (legacy): 208 bytes (`0xd0`)
 *   - CDJ-2000nxs: 212 bytes (`0xd4`)
 *   - CDJ-2000nxs2 / XDJ-1000 / XDJ-XZ: 292 bytes (`0x124`)
 *   - CDJ-3000: 512 bytes (`0x200`)
 *
 * All offsets below are valid for packets ≥ 204 bytes. Sources:
 * `dysentery/doc/modules/ROOT/pages/vcdj.adoc`,
 * `docs/protocol-reference.md` §3c, confirmed against real XDJ-XZ capture.
 *
 * | Offset       | Size | Meaning                                           |
 * |-------------:|-----:|---------------------------------------------------|
 * | `0x00`       |  10  | Pro DJ Link magic header                          |
 * | `0x0a`       |   1  | Kind byte `0x0a`                                  |
 * | `0x0c`       |  20  | Device name (ASCII, NUL-padded)                   |
 * | `0x21`       |   1  | Device ID (player number)                         |
 * | `0x22..0x23` |   2  | `len_r` (bytes remaining)                         |
 * | `0x28`       |   1  | Track source device ID                            |
 * | `0x29`       |   1  | Track slot (SD, USB, CD, rekordbox, …)            |
 * | `0x2a`       |   1  | Track type (rekordbox, unanalyzed, CD-DA, …)      |
 * | `0x2c..0x2f` |   4  | Track ID (rekordbox slot-relative)                |
 * | `0x7b`       |   1  | Play state enum                                   |
 * | `0x89`       |   1  | Status flags bitmask (on-air, sync, master, play) |
 * | `0x8d..0x8f` |   3  | Pitch_1 — actually applied (u24 BE)               |
 * | `0x92..0x93` |   2  | Track BPM × 100 (u16 BE)                          |
 * | `0x99..0x9b` |   3  | Pitch_2 — fader position (u24 BE)                 |
 * | `0x9f`       |   1  | Master-handoff byte (`0xff` = none)               |
 * | `0xa0..0xa3` |   4  | Beat counter from start of track                  |
 * | `0xa4..0xa5` |   2  | Beats until next cue (`0x01ff` = none)            |
 * | `0xa6`       |   1  | Beat-within-bar (1–4, 0 = no track)               |
 * | `0xc8..0xcb` |   4  | Packet sequence counter                           |
 *
 * **Pitch fields:** dysentery names `Pitch_1` (0x8d) as the *actually
 * applied* pitch, and `Pitch_2` (0x99) as what the fader *shows*.
 * prolink-connect swaps these names — do NOT copy their labels.
 * See `docs/protocol-reference.md` §3c and plan §"Things not to do".
 *
 * **Status flags at 0x89:**
 * ```
 * 0x08 = On-Air (channel active on mixer)
 * 0x10 = Sync (sync mode enabled)
 * 0x20 = Master (this deck is tempo master)
 * 0x40 = Playing (analysis-dependent; use playState for robust check)
 * ```
 * Note: on XDJ-XZ, 0x80 and 0x04 are always set (undocumented).
 * The Playing bit (0x40) is only set for rekordbox-analyzed tracks;
 * use the `playState` enum at 0x7b for a model-independent check.
 */

import { KIND_OFFSET, PROLINK_HEADER } from '../protocol/header.js';
import { StatusKind } from '../protocol/kinds.js';
import { decodePitch, encodePitch } from './beat.js';
import type { CdjStatus } from './types.js';

// ---- Packet lengths ----

/** Standard status packet length for Nexus2 / XDJ (the builder target). */
export const STATUS_LENGTH = 0x124; // 292 bytes

/** Minimum length to read all fields this parser uses. */
export const STATUS_MIN_LENGTH = 0xcc; // 204 bytes

// ---- Field offsets ----

const OFFSET_NAME = 0x0c;
const NAME_LENGTH = 20;
const OFFSET_DEVICE_ID = 0x21;
const OFFSET_LEN_R = 0x22;
const OFFSET_TRACK_DEVICE_ID = 0x28;
const OFFSET_TRACK_SLOT = 0x29;
const OFFSET_TRACK_TYPE = 0x2a;
const OFFSET_TRACK_ID = 0x2c;
const OFFSET_PLAY_STATE = 0x7b;
const OFFSET_STATUS_FLAGS = 0x89;
const OFFSET_PITCH_APPLIED = 0x8d; // Pitch_1, u24 BE (3 bytes)
const OFFSET_BPM = 0x92; // u16 BE
const OFFSET_PITCH_FADER = 0x99; // Pitch_2, u24 BE (3 bytes)
const OFFSET_MASTER_HANDOFF = 0x9f;
const OFFSET_BEAT_COUNTER = 0xa0;
const OFFSET_BEATS_UNTIL_CUE = 0xa4;
const OFFSET_BEAT_IN_BAR = 0xa6;
const OFFSET_PACKET_COUNTER = 0xc8;

// ---- Status flag bits ----

const FLAG_ON_AIR = 0x08;
const FLAG_SYNC = 0x10;
const FLAG_MASTER = 0x20;

// ---- Play-state enum values ----

/** CDJ play state values (byte at offset `0x7b`). */
export const PlayState = {
  /** No track loaded. */
  EMPTY: 0x00,
  /** Track is loading. */
  LOADING: 0x02,
  /** Normal playback. */
  PLAYING: 0x03,
  /** Playback inside a loop. */
  LOOPING: 0x04,
  /** Playback paused. */
  PAUSED: 0x05,
  /** Track is cued (at cue point, stopped). */
  CUED: 0x06,
  /** Cue-play (holding cue button). */
  CUING: 0x07,
  /** Platter held by hand. */
  PLATTER_HELD: 0x08,
  /** Jog search / scratch. */
  SEARCHING: 0x09,
  /** Platter spun down (reached end or error). */
  SPUN_DOWN: 0x0e,
  /** Track ended. */
  ENDED: 0x11,
} as const;

/** Track media slot values (byte at offset `0x29`). */
export const TrackSlot = {
  NONE: 0x00,
  CD: 0x01,
  SD: 0x02,
  USB: 0x03,
  REKORDBOX: 0x04,
  USB_2: 0x07,
} as const;

/** Track type values (byte at offset `0x2a`). */
export const TrackType = {
  NONE: 0x00,
  REKORDBOX: 0x01,
  UNANALYZED: 0x02,
  CD_DA: 0x05,
} as const;

// ---- Byte helpers (same as beat.ts — tiny, no shared module needed) ----

function decodeDeviceName(buf: Uint8Array): string {
  let end = buf.length;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x00) {
      end = i;
      break;
    }
  }
  let name = '';
  for (let i = 0; i < end; i++) {
    const byte = buf[i] ?? 0;
    name += String.fromCharCode(byte & 0x7f);
  }
  return name.replace(/\s+$/u, '');
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] ?? 0) << 24) +
    ((buf[offset + 1] ?? 0) << 16) +
    ((buf[offset + 2] ?? 0) << 8) +
    (buf[offset + 3] ?? 0)
  );
}

function readU24BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset] ?? 0) << 16) + ((buf[offset + 1] ?? 0) << 8) + (buf[offset + 2] ?? 0);
}

function readU16BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset] ?? 0) << 8) + (buf[offset + 1] ?? 0);
}

function encodeDeviceName(name: string): Uint8Array {
  const out = new Uint8Array(NAME_LENGTH);
  const limit = Math.min(name.length, NAME_LENGTH);
  for (let i = 0; i < limit; i++) {
    const code = name.charCodeAt(i);
    out[i] = code >= 0x20 && code <= 0x7e ? code : 0x3f;
  }
  return out;
}

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function writeU16BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

function writeU24BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 16) & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = value & 0xff;
}

// ---- Pitch midpoint (same constant as beat.ts) ----

const PITCH_ZERO = 0x100000;

// ---- Parser ----

/**
 * Attempt to parse a UDP payload as a CDJ status packet. Returns `null`
 * if the buffer doesn't match. Returns a fully materialized `CdjStatus`
 * if it does.
 *
 * `now` is injectable for tests and for freezing the timestamp to the
 * exact receive time the transport captured.
 */
export function parseStatus(buf: Uint8Array, now: Date = new Date()): CdjStatus | null {
  if (buf.length < STATUS_MIN_LENGTH) return null;

  // Header magic
  for (let i = 0; i < PROLINK_HEADER.length; i++) {
    if (buf[i] !== PROLINK_HEADER[i]) return null;
  }
  if (buf[KIND_OFFSET] !== StatusKind.CDJ_STATUS) return null;

  const deviceId = buf[OFFSET_DEVICE_ID] ?? 0;
  const deviceName = decodeDeviceName(buf.subarray(OFFSET_NAME, OFFSET_NAME + NAME_LENGTH));

  // Track identification
  const trackDeviceId = buf[OFFSET_TRACK_DEVICE_ID] ?? 0;
  const trackSlot = buf[OFFSET_TRACK_SLOT] ?? 0;
  const trackType = buf[OFFSET_TRACK_TYPE] ?? 0;
  const trackId = readU32BE(buf, OFFSET_TRACK_ID) >>> 0;

  // State
  const playState = buf[OFFSET_PLAY_STATE] ?? 0;
  const isPlaying = playState === PlayState.PLAYING || playState === PlayState.LOOPING;

  const statusFlags = buf[OFFSET_STATUS_FLAGS] ?? 0;
  const isMaster = (statusFlags & FLAG_MASTER) !== 0;
  const isSync = (statusFlags & FLAG_SYNC) !== 0;
  const isOnAir = (statusFlags & FLAG_ON_AIR) !== 0;

  // Tempo — use Pitch_1 (actually-applied) for effectiveBpm
  const pitchRaw = readU24BE(buf, OFFSET_PITCH_APPLIED);
  const pitch = decodePitch(pitchRaw);

  const bpmRaw = readU16BE(buf, OFFSET_BPM);
  const trackBpm = bpmRaw / 100;

  const pitchMultiplier = pitchRaw / PITCH_ZERO;
  const effectiveBpm = trackBpm * pitchMultiplier;

  // Position
  const beatCounter = readU32BE(buf, OFFSET_BEAT_COUNTER) >>> 0;
  const beatInBar = buf[OFFSET_BEAT_IN_BAR] ?? 0;
  const beatsUntilCue = readU16BE(buf, OFFSET_BEATS_UNTIL_CUE);

  // Meta
  const packetCounter = readU32BE(buf, OFFSET_PACKET_COUNTER) >>> 0;
  const masterHandoff = buf[OFFSET_MASTER_HANDOFF] ?? 0xff;

  return {
    deviceId,
    deviceName,
    trackDeviceId,
    trackSlot,
    trackType,
    trackId,
    playState,
    isPlaying,
    isMaster,
    isSync,
    isOnAir,
    statusFlags,
    trackBpm,
    effectiveBpm,
    pitch,
    beatCounter,
    beatInBar,
    beatsUntilCue,
    packetCounter,
    masterHandoff,
    timestamp: now,
  };
}

// ---- Builder (for round-trip testing) ----

/**
 * Options for building a synthetic CDJ status packet.
 */
export interface BuildStatusOptions {
  /** Player number (1–4 CDJ, 33 mixer). */
  deviceId: number;
  /** Device name, ≤ 20 ASCII chars. */
  deviceName: string;
  /** Track media slot. Default: `TrackSlot.NONE`. */
  trackSlot?: number;
  /** Track type. Default: `TrackType.NONE`. */
  trackType?: number;
  /** Track source device ID. Defaults to `deviceId`. */
  trackDeviceId?: number;
  /** Rekordbox track ID. Default: 0. */
  trackId?: number;
  /** Play state enum value. Default: `PlayState.EMPTY`. */
  playState?: number;
  /**
   * Status flags bitmask. Default: computed from the boolean flags below.
   * If set explicitly, boolean flags are ignored.
   */
  statusFlags?: number;
  /** Is this deck the master? Default: false. */
  isMaster?: boolean;
  /** Is sync engaged? Default: false. */
  isSync?: boolean;
  /** Is this channel on-air? Default: false. */
  isOnAir?: boolean;
  /** Track BPM (decimal). Default: 0. */
  trackBpm?: number;
  /** Applied pitch as a percentage. Default: 0. */
  pitch?: number;
  /** Beat counter. Default: `0xffffffff` (n/a). */
  beatCounter?: number;
  /** Beat-within-bar (1–4). Default: 0 (no track). */
  beatInBar?: number;
  /** Beats until next cue. Default: `0x01ff` (none). */
  beatsUntilCue?: number;
  /** Packet sequence counter. Default: 0. */
  packetCounter?: number;
  /** Master-handoff byte. Default: `0xff`. */
  masterHandoff?: number;
}

/**
 * Build a status packet from the given options. Produces a 292-byte buffer
 * matching the Nexus2 / XDJ CDJ status format. Used for round-trip testing.
 */
export function buildStatus(options: BuildStatusOptions): Uint8Array {
  if (!Number.isInteger(options.deviceId) || options.deviceId < 0 || options.deviceId > 0xff) {
    throw new Error(`deviceId must be a byte (0..255), got ${options.deviceId}`);
  }

  const buf = new Uint8Array(STATUS_LENGTH);

  // Header
  buf.set(PROLINK_HEADER, 0);
  buf[KIND_OFFSET] = StatusKind.CDJ_STATUS;

  // Device name
  buf.set(encodeDeviceName(options.deviceName), OFFSET_NAME);

  // Device ID
  buf[OFFSET_DEVICE_ID] = options.deviceId;

  // len_r
  const lenR = STATUS_LENGTH - (OFFSET_LEN_R + 2);
  writeU16BE(buf, OFFSET_LEN_R, lenR);

  // Track identification
  buf[OFFSET_TRACK_DEVICE_ID] = options.trackDeviceId ?? options.deviceId;
  buf[OFFSET_TRACK_SLOT] = options.trackSlot ?? TrackSlot.NONE;
  buf[OFFSET_TRACK_TYPE] = options.trackType ?? TrackType.NONE;
  writeU32BE(buf, OFFSET_TRACK_ID, options.trackId ?? 0);

  // Play state
  buf[OFFSET_PLAY_STATE] = options.playState ?? PlayState.EMPTY;

  // Status flags
  let flags = options.statusFlags;
  if (flags === undefined) {
    flags = 0;
    if (options.isMaster) flags |= FLAG_MASTER;
    if (options.isSync) flags |= FLAG_SYNC;
    if (options.isOnAir) flags |= FLAG_ON_AIR;
  }
  buf[OFFSET_STATUS_FLAGS] = flags;

  // Pitch (applied) — write to both Pitch_1 and Pitch_2 positions
  const pitchRaw = encodePitch(options.pitch ?? 0);
  writeU24BE(buf, OFFSET_PITCH_APPLIED, pitchRaw);
  writeU24BE(buf, OFFSET_PITCH_FADER, pitchRaw);

  // BPM
  const bpmRaw = Math.round((options.trackBpm ?? 0) * 100);
  writeU16BE(buf, OFFSET_BPM, bpmRaw);

  // Position
  writeU32BE(buf, OFFSET_BEAT_COUNTER, options.beatCounter ?? 0xffffffff);
  buf[OFFSET_BEAT_IN_BAR] = options.beatInBar ?? 0;
  writeU16BE(buf, OFFSET_BEATS_UNTIL_CUE, options.beatsUntilCue ?? 0x01ff);

  // Meta
  writeU32BE(buf, OFFSET_PACKET_COUNTER, options.packetCounter ?? 0);
  buf[OFFSET_MASTER_HANDOFF] = options.masterHandoff ?? 0xff;

  return buf;
}
