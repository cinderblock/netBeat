/**
 * Channels-on-air packet (port 50001, kind `0x03`).
 *
 * Broadcast by standalone DJM mixers to report which channels have their
 * faders up. This is the authoritative source of on-air state — CDJ status
 * packets carry an on-air flag too, but it's only set when the mixer tells
 * the CDJ it's on-air via this mechanism.
 *
 * Two variants exist:
 *   - **4-channel** (subtype `0x00`): standard DJMs. Flags F1..F4.
 *   - **6-channel** (subtype `0x03`): DJM-V10. Flags F1..F6.
 *
 * Combo units (XDJ-XZ, XDJ-AZ) do **not** send this packet — they never
 * set on-air flags for their own decks.
 *
 * Wire layout — 40 bytes (`0x28`) for 4-channel, 42 bytes (`0x2a`) for
 * 6-channel. Sources: `dysentery/.../mixer_integration.adoc`,
 * `docs/protocol-reference.md` §3.
 *
 * | Offset       | Size | Meaning                                          |
 * |-------------:|-----:|--------------------------------------------------|
 * | `0x00`       |  10  | Pro DJ Link magic header                         |
 * | `0x0a`       |   1  | Kind byte `0x03`                                 |
 * | `0x0b`       |   1  | Subtype (`0x00` 4-ch, `0x03` 6-ch DJM-V10)      |
 * | `0x0c`       |  20  | Device name (ASCII, NUL-padded)                  |
 * | `0x20`       |   1  | Fixed marker                                     |
 * | `0x21`       |   1  | Device ID (usually `0x21` for DJM)               |
 * | `0x22..0x23` |   2  | `len_r` (bytes remaining)                        |
 * | `0x24`       |   1  | F1 — channel 1 on-air flag                       |
 * | `0x25`       |   1  | F2 — channel 2 on-air flag                       |
 * | `0x26`       |   1  | F3 — channel 3 on-air flag                       |
 * | `0x27`       |   1  | F4 — channel 4 on-air flag                       |
 * | `0x28`       |   1  | F5 — channel 5 (DJM-V10 only, subtype `0x03`)    |
 * | `0x29`       |   1  | F6 — channel 6 (DJM-V10 only, subtype `0x03`)    |
 *
 * Each flag byte: `0x00` = off-air, non-zero = on-air.
 */

import { KIND_OFFSET, PROLINK_HEADER } from '../protocol/header.js';
import { BeatKind } from '../protocol/kinds.js';

// ---- Packet lengths ----

/** Minimum length for a 4-channel on-air packet. */
export const ON_AIR_MIN_LENGTH = 0x28; // 40 bytes (header + 4 flags)
/** Length for a 6-channel on-air packet (DJM-V10). */
export const ON_AIR_6CH_LENGTH = 0x2a; // 42 bytes (header + 6 flags)

// ---- Field offsets ----

const OFFSET_SUBTYPE = 0x0b;
const OFFSET_NAME = 0x0c;
const NAME_LENGTH = 20;
const OFFSET_DEVICE_ID = 0x21;
const OFFSET_FLAGS_START = 0x24;

/** DJM-V10 6-channel subtype. */
const SUBTYPE_6CH = 0x03;

// ---- Type ----

/**
 * Parsed channels-on-air state from a DJM mixer.
 */
export interface ChannelsOnAir {
  /** Device ID of the mixer (usually 0x21 = 33). */
  readonly deviceId: number;
  /** Device name from the packet. */
  readonly deviceName: string;
  /**
   * Per-channel on-air flags. Index 0 = channel 1, index 3 = channel 4.
   * Length is 4 for standard DJMs, 6 for DJM-V10.
   */
  readonly channels: readonly boolean[];
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

function writeU16BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

// ---- Parser ----

/**
 * Attempt to parse a UDP payload as a channels-on-air packet. Returns
 * `null` if the buffer doesn't match the expected format.
 */
export function parseOnAir(buf: Uint8Array, now: Date = new Date()): ChannelsOnAir | null {
  if (buf.length < ON_AIR_MIN_LENGTH) return null;

  // Header magic
  for (let i = 0; i < PROLINK_HEADER.length; i++) {
    if (buf[i] !== PROLINK_HEADER[i]) return null;
  }
  if (buf[KIND_OFFSET] !== BeatKind.CHANNELS_ON_AIR) return null;

  const subtype = buf[OFFSET_SUBTYPE] ?? 0;
  const is6ch = subtype === SUBTYPE_6CH;

  // For 6-channel variant, require the longer packet.
  if (is6ch && buf.length < ON_AIR_6CH_LENGTH) return null;

  const deviceId = buf[OFFSET_DEVICE_ID] ?? 0;
  const deviceName = decodeDeviceName(buf.subarray(OFFSET_NAME, OFFSET_NAME + NAME_LENGTH));

  const channelCount = is6ch ? 6 : 4;
  const channels: boolean[] = [];
  for (let i = 0; i < channelCount; i++) {
    channels.push((buf[OFFSET_FLAGS_START + i] ?? 0) !== 0);
  }

  return {
    deviceId,
    deviceName,
    channels,
    timestamp: now,
  };
}

// ---- Builder (for round-trip testing) ----

/** Options for building a synthetic channels-on-air packet. */
export interface BuildOnAirOptions {
  /** Device ID. Default: `0x21` (33, standard DJM ID). */
  deviceId?: number;
  /** Device name, ≤ 20 ASCII chars. Default: `'DJM-900NXS2'`. */
  deviceName?: string;
  /**
   * Per-channel on-air flags. Length determines the subtype:
   * 4 = standard DJM (subtype 0x00), 6 = DJM-V10 (subtype 0x03).
   * Default: `[false, false, false, false]`.
   */
  channels?: boolean[];
}

/**
 * Build a channels-on-air packet from the given options.
 */
export function buildOnAir(options: BuildOnAirOptions = {}): Uint8Array {
  const deviceId = options.deviceId ?? 0x21;
  const channels = options.channels ?? [false, false, false, false];
  const is6ch = channels.length > 4;
  const packetLength = is6ch ? ON_AIR_6CH_LENGTH : ON_AIR_MIN_LENGTH;

  const buf = new Uint8Array(packetLength);

  // Header
  buf.set(PROLINK_HEADER, 0);
  buf[KIND_OFFSET] = BeatKind.CHANNELS_ON_AIR;

  // Subtype
  buf[OFFSET_SUBTYPE] = is6ch ? SUBTYPE_6CH : 0x00;

  // Device name
  buf.set(encodeDeviceName(options.deviceName ?? 'DJM-900NXS2'), OFFSET_NAME);

  // Fixed marker
  buf[0x20] = 0x01;

  // Device ID
  buf[OFFSET_DEVICE_ID] = deviceId;

  // len_r
  const lenR = packetLength - (0x22 + 2);
  writeU16BE(buf, 0x22, lenR);

  // Channel flags
  const limit = Math.min(channels.length, is6ch ? 6 : 4);
  for (let i = 0; i < limit; i++) {
    buf[OFFSET_FLAGS_START + i] = channels[i] ? 0x01 : 0x00;
  }

  return buf;
}
