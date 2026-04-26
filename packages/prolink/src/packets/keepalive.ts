/**
 * Keep-alive packet (port 50000, kind `0x06`).
 *
 * Every Pro DJ Link device broadcasts one of these roughly every 1.5 s for
 * as long as it is on the network. Receiving them gives us a live inventory
 * of players, mixers, and rekordbox laptops plus the data we need to reach
 * them for deeper queries (IP, MAC, player number).
 *
 * Wire layout — 54 bytes total (`0x36`). Sources:
 * `prolink-connect/src/devices/utils.ts::deviceFromPacket` (authoritative
 * offsets), `dysentery/doc/modules/ROOT/pages/startup.adoc` "CDJ keep-alive
 * packets" / "Mixer keep-alive packets".
 *
 * | Offset     | Size | Meaning                                           |
 * |-----------:|-----:|---------------------------------------------------|
 * | `0x00`     |  10  | Pro DJ Link magic header                          |
 * | `0x0a`     |   1  | Kind byte, `0x06` for keep-alive                  |
 * | `0x0b`     |   1  | Sub-kind (observed `0x00..0x02`; not interpreted) |
 * | `0x0c`     |  20  | Device name (ASCII, NUL-padded)                   |
 * | `0x20`     |   2  | Fixed `0x01 0x02` (protocol version)              |
 * | `0x22..23` |   2  | `len_r` (bytes remaining after this field)        |
 * | `0x24`     |   1  | Device ID (player number)                         |
 * | `0x25`     |   1  | Unused / `0x01`                                   |
 * | `0x26..2b` |   6  | MAC address                                       |
 * | `0x2c..2f` |   4  | IPv4 address (big-endian u32)                     |
 * | `0x30..33` |   4  | Unknown (observed zero; see upstream comments)    |
 * | `0x34`     |   1  | Device type byte                                  |
 * | `0x35`     |   1  | Unused / padding                                  |
 */

import { KIND_OFFSET, PROLINK_HEADER } from '../protocol/header.js';
import { DiscoveryKind } from '../protocol/kinds.js';
import type { Device, SelfIdentity } from './types.js';
import { DEVICE_TYPE_BYTE, type DeviceType, deviceTypeToCategory } from './types.js';

/** Total length of a keep-alive packet in bytes. */
export const KEEP_ALIVE_LENGTH = 0x36;

/** Maximum length of the device-name field (NUL-padded ASCII). */
export const DEVICE_NAME_MAX_LENGTH = 20;

// Field offsets.
const OFFSET_SUB_KIND = 0x0b;
const OFFSET_NAME = 0x0c;
const OFFSET_PROTO_MARKER = 0x20;
const OFFSET_LEN_R = 0x22;
const OFFSET_DEVICE_ID = 0x24;
const OFFSET_MAC = 0x26;
const OFFSET_IP = 0x2c;
const OFFSET_DEVICE_TYPE = 0x34;

const MAC_LENGTH = 6;
const IP_LENGTH = 4;

/**
 * Classify the raw device-type byte into a coarse `DeviceType`. Unknown
 * values fall through to `'unknown'` so we surface hardware we haven't
 * catalogued yet without dropping the device from our inventory.
 */
export function classifyDeviceType(rawType: number): DeviceType {
  switch (rawType) {
    case DEVICE_TYPE_BYTE.CDJ:
      return 'cdj';
    case DEVICE_TYPE_BYTE.MIXER:
    case DEVICE_TYPE_BYTE.MIXER_ALT:
      return 'mixer';
    case DEVICE_TYPE_BYTE.REKORDBOX:
      return 'rekordbox';
    default:
      return 'unknown';
  }
}

function decodeDeviceName(buf: Uint8Array): string {
  // NUL-padded ASCII in a 20-byte window. Stop at the first NUL, then trim
  // trailing whitespace for tolerance of devices that pad with spaces.
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
    // Stay ASCII-safe; a stray high byte shouldn't poison the name.
    name += String.fromCharCode(byte & 0x7f);
  }
  return name.replace(/\s+$/u, '');
}

function formatIp(buf: Uint8Array): string {
  // `noUncheckedIndexedAccess` — coerce each octet defensively.
  const a = buf[0] ?? 0;
  const b = buf[1] ?? 0;
  const c = buf[2] ?? 0;
  const d = buf[3] ?? 0;
  return `${a}.${b}.${c}.${d}`;
}

/**
 * Attempt to parse a UDP payload as a keep-alive packet. Returns `null` if
 * the buffer doesn't look like one; returns a fully materialized `Device`
 * (with `lastSeen` set to `now`) if it does.
 *
 * `now` is injectable for tests and for freezing the "last seen" moment to
 * the exact receive time the transport captured.
 */
export function parseKeepAlive(buf: Uint8Array, now: Date = new Date()): Device | null {
  if (buf.length < KEEP_ALIVE_LENGTH) return null;

  // Header magic
  for (let i = 0; i < PROLINK_HEADER.length; i++) {
    if (buf[i] !== PROLINK_HEADER[i]) return null;
  }
  if (buf[KIND_OFFSET] !== DiscoveryKind.KEEP_ALIVE) return null;

  const rawType = buf[OFFSET_DEVICE_TYPE] ?? 0;
  const playerId = buf[OFFSET_DEVICE_ID] ?? 0;

  const name = decodeDeviceName(buf.subarray(OFFSET_NAME, OFFSET_NAME + DEVICE_NAME_MAX_LENGTH));
  const mac = new Uint8Array(buf.subarray(OFFSET_MAC, OFFSET_MAC + MAC_LENGTH));
  const ip = formatIp(buf.subarray(OFFSET_IP, OFFSET_IP + IP_LENGTH));
  const type = classifyDeviceType(rawType);

  return {
    // Common Device fields (from @netbeat/core)
    id: `prolink:${playerId}`,
    name,
    category: deviceTypeToCategory(type),
    address: ip,
    deckCount: type === 'cdj' ? 1 : 0,
    protocol: 'prolink' as const,
    // Prolink-specific fields
    playerId,
    ip,
    mac,
    type,
    rawType,
    lastSeen: now,
  };
}

/**
 * Parse a dotted-quad IPv4 string into 4 bytes. Throws if the string is
 * malformed — the caller is responsible for passing an interface address
 * that was already validated (typically from `os.networkInterfaces()`).
 */
function parseIp(ip: string): Uint8Array {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`Invalid IPv4 address: ${ip}`);
  const out = new Uint8Array(IP_LENGTH);
  for (let i = 0; i < IP_LENGTH; i++) {
    const raw = parts[i];
    if (raw === undefined) throw new Error(`Invalid IPv4 address: ${ip}`);
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error(`Invalid IPv4 address: ${ip}`);
    }
    out[i] = n;
  }
  return out;
}

function encodeDeviceName(name: string): Uint8Array {
  const out = new Uint8Array(DEVICE_NAME_MAX_LENGTH); // zero-filled
  const limit = Math.min(name.length, DEVICE_NAME_MAX_LENGTH);
  for (let i = 0; i < limit; i++) {
    // Restrict to ASCII; anything above 0x7e is replaced with `?`.
    const code = name.charCodeAt(i);
    out[i] = code >= 0x20 && code <= 0x7e ? code : 0x3f;
  }
  return out;
}

/**
 * Build a keep-alive packet we can broadcast as our own announcement. The
 * resulting buffer mirrors the 54-byte layout CDJs and mixers emit; the
 * device-type byte is drawn from `self.rawType` so callers can pose as a
 * CDJ (default), a rekordbox laptop, or anything else the spec names.
 *
 * This is the only thing observer mode emits on the wire — no stage-1/2/3
 * claim choreography, no sync or control packets. Kind `0x06` only.
 */
export function buildKeepAlive(self: SelfIdentity): Uint8Array {
  if (self.mac.length !== MAC_LENGTH) {
    throw new Error(`SelfIdentity.mac must be ${MAC_LENGTH} bytes, got ${self.mac.length}`);
  }
  if (!Number.isInteger(self.id) || self.id < 0 || self.id > 0xff) {
    throw new Error(`SelfIdentity.id must be a byte (0..255), got ${self.id}`);
  }
  if (!Number.isInteger(self.rawType) || self.rawType < 0 || self.rawType > 0xff) {
    throw new Error(`SelfIdentity.rawType must be a byte (0..255), got ${self.rawType}`);
  }

  const buf = new Uint8Array(KEEP_ALIVE_LENGTH); // zero-filled

  buf.set(PROLINK_HEADER, 0);
  buf[KIND_OFFSET] = DiscoveryKind.KEEP_ALIVE;
  buf[OFFSET_SUB_KIND] = 0x00;

  buf.set(encodeDeviceName(self.name), OFFSET_NAME);

  // Protocol-version marker, observed constant across captures.
  buf[OFFSET_PROTO_MARKER] = 0x01;
  buf[OFFSET_PROTO_MARKER + 1] = 0x02;

  // `len_r` = bytes remaining after this field = 0x36 - (0x22 + 2) = 0x12.
  const lenR = KEEP_ALIVE_LENGTH - (OFFSET_LEN_R + 2);
  buf[OFFSET_LEN_R] = (lenR >>> 8) & 0xff;
  buf[OFFSET_LEN_R + 1] = lenR & 0xff;

  buf[OFFSET_DEVICE_ID] = self.id;
  buf[OFFSET_DEVICE_ID + 1] = 0x01; // observed constant; keep-alive "auto" flag

  buf.set(self.mac, OFFSET_MAC);
  buf.set(parseIp(self.ip), OFFSET_IP);

  buf[OFFSET_DEVICE_TYPE] = self.rawType;

  return buf;
}
