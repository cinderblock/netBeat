/**
 * Absolute-position packet (port 50001, kind `0x0b`).
 *
 * CDJ-3000 only. Broadcast every ~30 ms while a track is loaded (even
 * when paused). Gives the exact playhead position and track length
 * directly — no need to derive time-remaining from beat counts + beat
 * grids.
 *
 * Older CDJs (CDJ-2000nxs, XDJ-XZ, etc.) do **not** emit this packet.
 * The library treats it as per-device-capability data.
 *
 * prolink-connect does **not** parse these — this is a gap in
 * prolink-connect. We implement from spec:
 * `dysentery/doc/modules/ROOT/pages/beats.adoc` "Absolute Position Packets",
 * `docs/protocol-reference.md` §3e.
 *
 * Wire layout — estimated 52 bytes (`0x34`). Sources:
 * `docs/protocol-reference.md` §3e + §8 gotchas.
 *
 * | Offset       | Size | Meaning                                          |
 * |-------------:|-----:|--------------------------------------------------|
 * | `0x00`       |  10  | Pro DJ Link magic header                         |
 * | `0x0a`       |   1  | Kind byte `0x0b`                                 |
 * | `0x0b`       |   1  | Subtype                                          |
 * | `0x0c`       |  20  | Device name (ASCII, NUL-padded)                  |
 * | `0x20`       |   1  | Fixed marker                                     |
 * | `0x21`       |   1  | Device ID (player number)                        |
 * | `0x22..0x23` |   2  | `len_r` (bytes remaining)                        |
 * | `0x24..0x27` |   4  | TrackLength (u32 BE, seconds, integer)            |
 * | `0x28..0x2b` |   4  | Playhead (u32 BE, milliseconds from track start)  |
 * | `0x2c..0x2f` |   4  | Pitch (s32 BE, slider pct × 100)                 |
 * | `0x30..0x31` |   2  | BPM × 10 (u16 BE) — estimated offset             |
 *
 * **Pitch encoding:** This packet uses `value / 100` = percentage.
 * This is *not* the `0x100000`-based u24 scheme used in beat and CDJ
 * status packets. Do not share a decoder.
 *
 * **BPM encoding:** `value / 10` = decimal BPM. This is *not* the
 * `× 100` encoding used in beat and CDJ status packets.
 *
 * **BPM offset (0x30) is estimated** — the protocol reference documents
 * through offset 0x2f. The BPM × 10 field is confirmed to exist in the
 * packet (`docs/protocol-reference.md` §8) but its exact position needs
 * validation against real CDJ-3000 captures.
 */

import { KIND_OFFSET, PROLINK_HEADER } from '../protocol/header.js';
import { BeatKind } from '../protocol/kinds.js';

// ---- Packet lengths ----

/**
 * Estimated total length. The exact length is not documented; this is
 * the minimum to include all known fields through BPM.
 */
export const ABSOLUTE_POSITION_LENGTH = 0x34; // 52 bytes (builder target)

/**
 * Minimum length to parse all documented fields (through pitch at 0x2f).
 * BPM at 0x30 requires 2 additional bytes.
 */
export const ABSOLUTE_POSITION_MIN_LENGTH = 0x30; // 48 bytes

// ---- Field offsets ----

const OFFSET_NAME = 0x0c;
const NAME_LENGTH = 20;
const OFFSET_DEVICE_ID = 0x21;
const OFFSET_LEN_R = 0x22;
const OFFSET_TRACK_LENGTH = 0x24;
const OFFSET_PLAYHEAD = 0x28;
const OFFSET_PITCH = 0x2c;
/** Estimated offset — needs CDJ-3000 validation. */
const OFFSET_BPM = 0x30;

// ---- Type ----

/**
 * Parsed absolute-position from a CDJ-3000.
 *
 * This is the most direct way to know where the DJ is in a track —
 * no beat-grid computation required.
 */
export interface AbsolutePosition {
  /** Player number that emitted this position (1–4). */
  readonly deviceId: number;
  /** Device name from the packet. */
  readonly deviceName: string;
  /** Total track length in seconds (integer). */
  readonly trackLength: number;
  /** Current playhead position in milliseconds from track start. */
  readonly playhead: number;
  /**
   * Pitch fader position as a percentage (−100 to +100).
   * Note: this uses a different encoding than beat/status packets.
   */
  readonly pitch: number;
  /**
   * Track BPM as analyzed by rekordbox, before pitch adjustment.
   * Note: uses ×10 encoding on wire, not ×100 like beat/status packets.
   *
   * **The BPM field offset (0x30) is estimated and needs CDJ-3000
   * validation.** Returns 0 if the packet is too short to contain it.
   */
  readonly trackBpm: number;
  /** Local timestamp when this packet was received. */
  readonly timestamp: Date;
}

// ---- Byte helpers ----

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

function encodeDeviceName(name: string): Uint8Array {
  const out = new Uint8Array(NAME_LENGTH);
  const limit = Math.min(name.length, NAME_LENGTH);
  for (let i = 0; i < limit; i++) {
    const code = name.charCodeAt(i);
    out[i] = code >= 0x20 && code <= 0x7e ? code : 0x3f;
  }
  return out;
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] ?? 0) << 24) +
    ((buf[offset + 1] ?? 0) << 16) +
    ((buf[offset + 2] ?? 0) << 8) +
    (buf[offset + 3] ?? 0)
  );
}

/**
 * Read a signed 32-bit big-endian integer.
 * The pitch field in absolute-position packets is signed.
 */
function readS32BE(buf: Uint8Array, offset: number): number {
  const u = readU32BE(buf, offset);
  // Convert unsigned to signed (two's complement)
  return u > 0x7fffffff ? u - 0x100000000 : u;
}

function readU16BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset] ?? 0) << 8) + (buf[offset + 1] ?? 0);
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

// ---- Parser ----

/**
 * Attempt to parse a UDP payload as an absolute-position packet. Returns
 * `null` if the buffer doesn't match the expected format.
 *
 * If the packet is long enough to include the BPM field (≥ 50 bytes),
 * it will be parsed. Otherwise `trackBpm` will be 0.
 */
export function parseAbsolutePosition(
  buf: Uint8Array,
  now: Date = new Date(),
): AbsolutePosition | null {
  if (buf.length < ABSOLUTE_POSITION_MIN_LENGTH) return null;

  // Header magic
  for (let i = 0; i < PROLINK_HEADER.length; i++) {
    if (buf[i] !== PROLINK_HEADER[i]) return null;
  }
  if (buf[KIND_OFFSET] !== BeatKind.ABSOLUTE_POSITION) return null;

  const deviceId = buf[OFFSET_DEVICE_ID] ?? 0;
  const deviceName = decodeDeviceName(buf.subarray(OFFSET_NAME, OFFSET_NAME + NAME_LENGTH));

  const trackLength = readU32BE(buf, OFFSET_TRACK_LENGTH) >>> 0;
  const playhead = readU32BE(buf, OFFSET_PLAYHEAD) >>> 0;

  // Pitch: signed 32-bit × 100 → percentage
  const pitchRaw = readS32BE(buf, OFFSET_PITCH);
  const pitch = pitchRaw / 100;

  // BPM: u16 × 10 → decimal (only if packet is long enough)
  let trackBpm = 0;
  if (buf.length >= OFFSET_BPM + 2) {
    const bpmRaw = readU16BE(buf, OFFSET_BPM);
    trackBpm = bpmRaw / 10;
  }

  return {
    deviceId,
    deviceName,
    trackLength,
    playhead,
    pitch,
    trackBpm,
    timestamp: now,
  };
}

// ---- Builder (for round-trip testing) ----

/** Options for building a synthetic absolute-position packet. */
export interface BuildAbsolutePositionOptions {
  /** Player number (1–4). Default: 1. */
  deviceId?: number;
  /** Device name, ≤ 20 ASCII chars. Default: `'CDJ-3000'`. */
  deviceName?: string;
  /** Total track length in seconds. Default: 0. */
  trackLength?: number;
  /** Playhead position in milliseconds. Default: 0. */
  playhead?: number;
  /** Pitch as a percentage (−100 to +100). Default: 0. */
  pitch?: number;
  /** Track BPM (decimal). Default: 0. */
  trackBpm?: number;
}

/**
 * Build an absolute-position packet from the given options. Produces a
 * 52-byte buffer matching the estimated Pro DJ Link absolute-position format.
 */
export function buildAbsolutePosition(options: BuildAbsolutePositionOptions = {}): Uint8Array {
  const buf = new Uint8Array(ABSOLUTE_POSITION_LENGTH);

  // Header
  buf.set(PROLINK_HEADER, 0);
  buf[KIND_OFFSET] = BeatKind.ABSOLUTE_POSITION;

  // Subtype
  buf[0x0b] = 0x00;

  // Device name
  buf.set(encodeDeviceName(options.deviceName ?? 'CDJ-3000'), OFFSET_NAME);

  // Fixed marker
  buf[0x20] = 0x01;

  // Device ID
  buf[OFFSET_DEVICE_ID] = options.deviceId ?? 1;

  // len_r
  const lenR = ABSOLUTE_POSITION_LENGTH - (OFFSET_LEN_R + 2);
  writeU16BE(buf, OFFSET_LEN_R, lenR);

  // Track length (seconds)
  writeU32BE(buf, OFFSET_TRACK_LENGTH, options.trackLength ?? 0);

  // Playhead (milliseconds)
  writeU32BE(buf, OFFSET_PLAYHEAD, options.playhead ?? 0);

  // Pitch (signed × 100)
  const pitchRaw = Math.round((options.pitch ?? 0) * 100);
  writeU32BE(buf, OFFSET_PITCH, pitchRaw & 0xffffffff);

  // BPM × 10
  const bpmRaw = Math.round((options.trackBpm ?? 0) * 10);
  writeU16BE(buf, OFFSET_BPM, bpmRaw);

  return buf;
}
