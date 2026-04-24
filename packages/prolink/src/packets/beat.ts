/**
 * Beat packet (port 50001, kind `0x28`).
 *
 * Emitted once per beat while a rekordbox-analyzed track is playing.
 * Carries BPM, pitch, beat-within-bar (1..4), and countdown timers to
 * upcoming beats/downbeats. This is the primary source of sub-beat phase
 * for lighting and show-control sync.
 *
 * Wire layout — 96 bytes total (`0x60`). Sources:
 * `dysentery/doc/modules/ROOT/pages/beats.adoc`,
 * `docs/protocol-reference.md` §3b, confirmed against real XDJ-XZ capture.
 *
 * | Offset       | Size | Meaning                                          |
 * |-------------:|-----:|--------------------------------------------------|
 * | `0x00`       |  10  | Pro DJ Link magic header                         |
 * | `0x0a`       |   1  | Kind byte, `0x28` for beat                       |
 * | `0x0b`       |   1  | Subtype (`0x00` on CDJ-2000nxs; first char of    |
 * |              |      | device name on XDJ-XZ — see note below)          |
 * | `0x0c`       |  20  | Device name (ASCII, NUL-padded)                  |
 * | `0x20`       |   1  | Fixed `0x01` (CDJ-2000nxs) / `0x00` (XDJ-XZ)    |
 * | `0x21`       |   1  | Device ID (player number)                        |
 * | `0x22..0x23` |   2  | `len_r` (bytes remaining after this field)       |
 * | `0x24..0x27` |   4  | nextBeat — ms to next beat (normal tempo)        |
 * | `0x28..0x2b` |   4  | secondBeat — ms to 2nd beat                      |
 * | `0x2c..0x2f` |   4  | nextBar — ms to next downbeat                    |
 * | `0x30..0x33` |   4  | fourthBeat — ms to 4th beat                      |
 * | `0x34..0x37` |   4  | secondBar — ms to 2nd downbeat                   |
 * | `0x38..0x3b` |   4  | eighthBeat — ms to 8th beat                      |
 * | `0x3c..0x53` |  24  | Padding (`0xff`)                                 |
 * | `0x54..0x57` |   4  | Pitch (u24 at `0x55..0x57`; see pitch encoding)  |
 * | `0x58..0x59` |   2  | Zeros                                            |
 * | `0x5a..0x5b` |   2  | BPM × 100 (u16 BE), `0xffff` = no track          |
 * | `0x5c`       |   1  | Beat-within-bar (1..4)                           |
 * | `0x5d..0x5e` |   2  | Zeros                                            |
 * | `0x5f`       |   1  | Device ID (repeated)                             |
 *
 * **Name field quirk:** On CDJ-2000nxs, offset `0x0b` is a subtype byte
 * (`0x00`) and the 20-byte name starts at `0x0c`. On XDJ-XZ, the name
 * starts one byte earlier at `0x0b`, so parsing from `0x0c` truncates the
 * first character (e.g. "DJ-XZ" instead of "XDJ-XZ"). Use `deviceId` for
 * identity, not the name. — per `docs/protocol-reference.md` §3b.
 *
 * **Pitch encoding:** `0x00000000` = −100 %, `0x00100000` = 0 %,
 * `0x00200000` = +100 %. `percent = ((u24 - 0x100000) / 0x100000) × 100`.
 * `pitchMultiplier = u24 / 0x100000`.
 * `effectiveBpm = trackBpm × pitchMultiplier`.
 */

import { KIND_OFFSET, PROLINK_HEADER } from '../protocol/header.js';
import { BeatKind } from '../protocol/kinds.js';
import type { Beat } from './types.js';

/** Total length of a beat packet in bytes. */
export const BEAT_LENGTH = 0x60;

/** Maximum length of the device-name field (NUL-padded ASCII). */
const DEVICE_NAME_LENGTH = 20;

// Field offsets.
const OFFSET_NAME = 0x0c;
const OFFSET_DEVICE_ID = 0x21;
const OFFSET_LEN_R = 0x22;
const OFFSET_NEXT_BEAT = 0x24;
const OFFSET_SECOND_BEAT = 0x28;
const OFFSET_NEXT_BAR = 0x2c;
const OFFSET_FOURTH_BEAT = 0x30;
const OFFSET_SECOND_BAR = 0x34;
const OFFSET_EIGHTH_BEAT = 0x38;
const OFFSET_PITCH = 0x55; // u24 BE (leading byte at 0x54 is always 0x00)
const OFFSET_BPM = 0x5a;
const OFFSET_BEAT_IN_BAR = 0x5c;
const OFFSET_DEVICE_ID_REPEAT = 0x5f;

/** Midpoint of the pitch range — represents 0 % (no pitch change). */
const PITCH_ZERO = 0x100000;

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

/**
 * Decode the 24-bit pitch value into a percentage (−100 to +100).
 * `0x000000` = −100 %, `0x100000` = 0 %, `0x200000` = +100 %.
 */
export function decodePitch(raw: number): number {
  return ((raw - PITCH_ZERO) / PITCH_ZERO) * 100;
}

/**
 * Encode a pitch percentage (−100 to +100) into the 24-bit raw value.
 */
export function encodePitch(percent: number): number {
  return Math.round((percent / 100) * PITCH_ZERO + PITCH_ZERO);
}

/**
 * Attempt to parse a UDP payload as a beat packet. Returns `null` if the
 * buffer doesn't match the expected format; returns a fully materialized
 * `Beat` if it does.
 *
 * `now` is injectable for tests and for freezing the timestamp to the
 * exact receive time the transport captured.
 */
export function parseBeat(buf: Uint8Array, now: Date = new Date()): Beat | null {
  if (buf.length < BEAT_LENGTH) return null;

  // Header magic
  for (let i = 0; i < PROLINK_HEADER.length; i++) {
    if (buf[i] !== PROLINK_HEADER[i]) return null;
  }
  if (buf[KIND_OFFSET] !== BeatKind.BEAT) return null;

  const deviceId = buf[OFFSET_DEVICE_ID] ?? 0;
  const deviceName = decodeDeviceName(buf.subarray(OFFSET_NAME, OFFSET_NAME + DEVICE_NAME_LENGTH));

  const nextBeat = readU32BE(buf, OFFSET_NEXT_BEAT) >>> 0;
  const secondBeat = readU32BE(buf, OFFSET_SECOND_BEAT) >>> 0;
  const nextBar = readU32BE(buf, OFFSET_NEXT_BAR) >>> 0;
  const fourthBeat = readU32BE(buf, OFFSET_FOURTH_BEAT) >>> 0;
  const secondBar = readU32BE(buf, OFFSET_SECOND_BAR) >>> 0;
  const eighthBeat = readU32BE(buf, OFFSET_EIGHTH_BEAT) >>> 0;

  const pitchRaw = readU24BE(buf, OFFSET_PITCH);
  const pitch = decodePitch(pitchRaw);

  const bpmRaw = readU16BE(buf, OFFSET_BPM);
  const trackBpm = bpmRaw / 100;

  const pitchMultiplier = pitchRaw / PITCH_ZERO;
  const effectiveBpm = trackBpm * pitchMultiplier;

  const beatInBar = buf[OFFSET_BEAT_IN_BAR] ?? 0;

  return {
    deviceId,
    deviceName,
    trackBpm,
    effectiveBpm,
    pitch,
    beatInBar,
    nextBeat,
    secondBeat,
    nextBar,
    fourthBeat,
    secondBar,
    eighthBeat,
    timestamp: now,
  };
}

/**
 * Options for building a synthetic beat packet (primarily for testing).
 */
export interface BuildBeatOptions {
  /** Player number (1–4 CDJ, 33 mixer). */
  deviceId: number;
  /** Device name, ≤ 20 ASCII chars. */
  deviceName: string;
  /** Track BPM (decimal, e.g. 128.5). */
  trackBpm: number;
  /** Beat position within the bar (1–4). */
  beatInBar: number;
  /** Pitch as a percentage (−100 to +100). Defaults to 0. */
  pitch?: number;
  /** ms to next beat. Defaults to computed from BPM. */
  nextBeat?: number;
  /** ms to 2nd beat. Defaults to computed from BPM. */
  secondBeat?: number;
  /** ms to next downbeat. Defaults to computed from BPM and beatInBar. */
  nextBar?: number;
  /** ms to 4th beat. Defaults to computed from BPM. */
  fourthBeat?: number;
  /** ms to 2nd downbeat. Defaults to computed from BPM. */
  secondBar?: number;
  /** ms to 8th beat. Defaults to computed from BPM. */
  eighthBeat?: number;
}

function encodeDeviceName(name: string): Uint8Array {
  const out = new Uint8Array(DEVICE_NAME_LENGTH);
  const limit = Math.min(name.length, DEVICE_NAME_LENGTH);
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

/**
 * Build a beat packet from the given options. Produces a 96-byte buffer
 * matching the Pro DJ Link beat format. Used for round-trip testing and
 * for the future `netbeat replay` subcommand.
 */
export function buildBeat(options: BuildBeatOptions): Uint8Array {
  if (!Number.isInteger(options.deviceId) || options.deviceId < 0 || options.deviceId > 0xff) {
    throw new Error(`deviceId must be a byte (0..255), got ${options.deviceId}`);
  }
  if (!Number.isInteger(options.beatInBar) || options.beatInBar < 1 || options.beatInBar > 4) {
    throw new Error(`beatInBar must be 1..4, got ${options.beatInBar}`);
  }

  const pitchPercent = options.pitch ?? 0;
  const beatMs = Math.round(60000 / options.trackBpm);
  const beatsUntilBar = 4 - options.beatInBar;

  const nextBeat = options.nextBeat ?? beatMs;
  const secondBeat = options.secondBeat ?? beatMs * 2;
  const nextBar = options.nextBar ?? beatMs * (beatsUntilBar || 4);
  const fourthBeat = options.fourthBeat ?? beatMs * 4;
  const secondBar = options.secondBar ?? beatMs * (beatsUntilBar + 4 || 8);
  const eighthBeat = options.eighthBeat ?? beatMs * 8;

  const buf = new Uint8Array(BEAT_LENGTH);

  // Header
  buf.set(PROLINK_HEADER, 0);
  buf[KIND_OFFSET] = BeatKind.BEAT;

  // Subtype byte at 0x0b — 0x00 for standard format
  buf[0x0b] = 0x00;

  // Device name at 0x0c
  buf.set(encodeDeviceName(options.deviceName), OFFSET_NAME);

  // Fixed marker
  buf[0x20] = 0x01;

  // Device ID
  buf[OFFSET_DEVICE_ID] = options.deviceId;

  // len_r: bytes remaining after this field = 0x60 - 0x24 = 0x3c
  const lenR = BEAT_LENGTH - (OFFSET_LEN_R + 2);
  writeU16BE(buf, OFFSET_LEN_R, lenR);

  // Beat timing intervals
  writeU32BE(buf, OFFSET_NEXT_BEAT, nextBeat);
  writeU32BE(buf, OFFSET_SECOND_BEAT, secondBeat);
  writeU32BE(buf, OFFSET_NEXT_BAR, nextBar);
  writeU32BE(buf, OFFSET_FOURTH_BEAT, fourthBeat);
  writeU32BE(buf, OFFSET_SECOND_BAR, secondBar);
  writeU32BE(buf, OFFSET_EIGHTH_BEAT, eighthBeat);

  // Padding 0x3c..0x53 = 0xff
  for (let i = 0x3c; i <= 0x53; i++) {
    buf[i] = 0xff;
  }

  // Pitch — u24 at 0x55, leading byte at 0x54 = 0x00
  const pitchRaw = encodePitch(pitchPercent);
  buf[0x54] = 0x00;
  buf[0x55] = (pitchRaw >>> 16) & 0xff;
  buf[0x56] = (pitchRaw >>> 8) & 0xff;
  buf[0x57] = pitchRaw & 0xff;

  // BPM × 100 at 0x5a
  const bpmRaw = Math.round(options.trackBpm * 100);
  writeU16BE(buf, OFFSET_BPM, bpmRaw);

  // Beat-within-bar
  buf[OFFSET_BEAT_IN_BAR] = options.beatInBar;

  // Device ID repeated
  buf[OFFSET_DEVICE_ID_REPEAT] = options.deviceId;

  return buf;
}
