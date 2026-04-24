/**
 * Mixer status packet (port 50002, kind `0x29`).
 *
 * Sent by standalone DJM mixers at ~200 ms cadence. Carries the mixer's
 * master BPM, master-authority flag, and a beat-within-bar byte (which
 * dysentery warns is unreliable — not aligned with the master deck).
 *
 * Combo units like the XDJ-XZ do **not** send mixer status packets — they
 * announce each deck individually via CDJ status (kind `0x0a`).
 *
 * prolink-connect does **not** parse mixer status. We implement from spec:
 * `dysentery/doc/modules/ROOT/pages/vcdj.adoc` lines 25-80.
 *
 * Wire layout — 56 bytes total (`0x38`). Sources:
 * `docs/protocol-reference.md` §3d.
 *
 * | Offset       | Size | Meaning                                          |
 * |-------------:|-----:|--------------------------------------------------|
 * | `0x00`       |  10  | Pro DJ Link magic header                         |
 * | `0x0a`       |   1  | Kind byte `0x29`                                 |
 * | `0x0b`       |   1  | Subtype (`0x00` DJM; `0x01` rekordbox laptop)    |
 * | `0x0c`       |  20  | Device name (ASCII, NUL-padded)                  |
 * | `0x20`       |   1  | Fixed marker                                     |
 * | `0x21`       |   1  | Device ID (usually `0x21` for DJM)               |
 * | `0x22..0x23` |   2  | `len_r` (bytes remaining, `0x0014`)              |
 * | `0x27`       |   1  | Status flags (`0xf0` master, `0xd0` not master)  |
 * | `0x28..0x2b` |   4  | Pitch (always `0x00100000` = 0 %)                |
 * | `0x2e..0x2f` |   2  | BPM × 100 (u16 BE)                               |
 * | `0x36`       |   1  | `M_h` master-handoff byte                        |
 * | `0x37`       |   1  | `B_b` beat-within-bar (unreliable)               |
 */

import { KIND_OFFSET, PROLINK_HEADER } from '../protocol/header.js';
import { StatusKind } from '../protocol/kinds.js';
import type { MixerStatus } from './types.js';

// ---- Packet lengths ----

/** Total length of a mixer status packet. */
export const MIXER_STATUS_LENGTH = 0x38; // 56 bytes

// ---- Field offsets ----

const OFFSET_NAME = 0x0c;
const NAME_LENGTH = 20;
const OFFSET_DEVICE_ID = 0x21;
const OFFSET_LEN_R = 0x22;
const OFFSET_STATUS_FLAGS = 0x27;
const OFFSET_BPM = 0x2e;
const OFFSET_MASTER_HANDOFF = 0x36;
const OFFSET_BEAT_IN_BAR = 0x37;

// ---- Status flag bits ----

/** Mixer is the tempo master. Same bit position as CDJ status. */
const FLAG_MASTER = 0x20;

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

function readU16BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset] ?? 0) << 8) + (buf[offset + 1] ?? 0);
}

function writeU16BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

// ---- Parser ----

/**
 * Attempt to parse a UDP payload as a mixer status packet. Returns `null`
 * if the buffer doesn't match the expected format.
 */
export function parseMixerStatus(buf: Uint8Array, now: Date = new Date()): MixerStatus | null {
  if (buf.length < MIXER_STATUS_LENGTH) return null;

  // Header magic
  for (let i = 0; i < PROLINK_HEADER.length; i++) {
    if (buf[i] !== PROLINK_HEADER[i]) return null;
  }
  if (buf[KIND_OFFSET] !== StatusKind.MIXER_STATUS) return null;

  const deviceId = buf[OFFSET_DEVICE_ID] ?? 0;
  const deviceName = decodeDeviceName(buf.subarray(OFFSET_NAME, OFFSET_NAME + NAME_LENGTH));

  const statusFlags = buf[OFFSET_STATUS_FLAGS] ?? 0;
  const isMaster = (statusFlags & FLAG_MASTER) !== 0;

  const bpmRaw = readU16BE(buf, OFFSET_BPM);
  const bpm = bpmRaw / 100;

  const masterHandoff = buf[OFFSET_MASTER_HANDOFF] ?? 0xff;
  const beatInBar = buf[OFFSET_BEAT_IN_BAR] ?? 0;

  return {
    deviceId,
    deviceName,
    isMaster,
    statusFlags,
    bpm,
    beatInBar,
    masterHandoff,
    timestamp: now,
  };
}

// ---- Builder (for round-trip testing) ----

/** Options for building a synthetic mixer status packet. */
export interface BuildMixerStatusOptions {
  /** Device ID. Default: `0x21` (33, standard DJM ID). */
  deviceId?: number;
  /** Device name, ≤ 20 ASCII chars. Default: `'DJM-900NXS2'`. */
  deviceName?: string;
  /** Is this mixer the tempo master? Default: false. */
  isMaster?: boolean;
  /**
   * Raw status flags byte. Default: computed from `isMaster`.
   * If set explicitly, the `isMaster` flag is ignored.
   */
  statusFlags?: number;
  /** Master BPM. Default: 0. */
  bpm?: number;
  /** Beat-within-bar (1–4). Default: 0. */
  beatInBar?: number;
  /** Master-handoff byte. Default: `0xff`. */
  masterHandoff?: number;
}

/**
 * Build a mixer status packet from the given options. Produces a 56-byte
 * buffer matching the Pro DJ Link mixer status format.
 */
export function buildMixerStatus(options: BuildMixerStatusOptions = {}): Uint8Array {
  const deviceId = options.deviceId ?? 0x21;

  const buf = new Uint8Array(MIXER_STATUS_LENGTH);

  // Header
  buf.set(PROLINK_HEADER, 0);
  buf[KIND_OFFSET] = StatusKind.MIXER_STATUS;

  // Subtype 0x00 (standard DJM)
  buf[0x0b] = 0x00;

  // Device name
  buf.set(encodeDeviceName(options.deviceName ?? 'DJM-900NXS2'), OFFSET_NAME);

  // Fixed marker
  buf[0x20] = 0x01;

  // Device ID
  buf[OFFSET_DEVICE_ID] = deviceId;

  // len_r: bytes remaining = 0x38 - 0x24 = 0x14
  const lenR = MIXER_STATUS_LENGTH - (OFFSET_LEN_R + 2);
  writeU16BE(buf, OFFSET_LEN_R, lenR);

  // Status flags
  let flags = options.statusFlags;
  if (flags === undefined) {
    // Base flags: 0xd0 when not master, 0xf0 when master
    flags = options.isMaster ? 0xf0 : 0xd0;
  }
  buf[OFFSET_STATUS_FLAGS] = flags;

  // Pitch — always 0x00100000 (0 %) for mixers
  writeU32BE(buf, 0x28, 0x00100000);

  // BPM × 100
  const bpmRaw = Math.round((options.bpm ?? 0) * 100);
  writeU16BE(buf, OFFSET_BPM, bpmRaw);

  // Master handoff
  buf[OFFSET_MASTER_HANDOFF] = options.masterHandoff ?? 0xff;

  // Beat-within-bar
  buf[OFFSET_BEAT_IN_BAR] = options.beatInBar ?? 0;

  return buf;
}
