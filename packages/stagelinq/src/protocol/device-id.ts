/**
 * StageLinQ device identity — a 16-byte UUID.
 *
 * Devices identify themselves with a 128-bit UUID (16 raw bytes). The protocol
 * sends these on the wire as raw bytes, not as a formatted string. We store
 * them as `Uint8Array` and provide helpers for display and comparison.
 */

import type { ReadContext } from './read-context.js';
import type { WriteContext } from './write-context.js';

/** Raw 16-byte device identity. */
export type DeviceId = Uint8Array;

/** Byte length of a DeviceId on the wire. */
export const DEVICE_ID_LENGTH = 16;

/** Read a 16-byte DeviceId from a ReadContext. */
export function readDeviceId(ctx: ReadContext): DeviceId {
  return ctx.readBytes(DEVICE_ID_LENGTH);
}

/** Write a 16-byte DeviceId to a WriteContext. */
export function writeDeviceId(ctx: WriteContext, id: DeviceId): void {
  ctx.writeBytes(id);
}

/**
 * Format a DeviceId as a standard UUID string:
 * `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
 */
export function formatDeviceId(id: DeviceId): string {
  const hex = Array.from(id, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Parse a UUID string into a 16-byte DeviceId.
 * Accepts `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` or 32 hex chars without dashes.
 */
export function parseDeviceId(uuid: string): DeviceId {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new Error(`Invalid UUID string: expected 32 hex chars, got ${hex.length}`);
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Compare two DeviceIds for equality. */
export function deviceIdEquals(a: DeviceId, b: DeviceId): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Generate a random DeviceId. Used when we need a unique identity for
 * our observer on the network.
 */
export function randomDeviceId(): DeviceId {
  const id = new Uint8Array(16);
  crypto.getRandomValues(id);
  // Set version 4 (random) UUID bits per RFC 4122.
  id[6] = ((id[6] ?? 0) & 0x0f) | 0x40; // version = 4
  id[8] = ((id[8] ?? 0) & 0x3f) | 0x80; // variant = 10xx
  return id;
}

/**
 * Well-known device tokens used for identification. StageLinQ devices use the
 * token's MSB to decide whether to reply — tokens with MSB=1 are ignored by
 * source devices.
 *
 * The "Listen" token is a passive observer identity suitable for our use case.
 */
export const KNOWN_TOKENS = {
  /** SoundSwitch identity — used by Denon's own lighting software. */
  SOUND_SWITCH: parseDeviceId('53-6F-75-6E-64-53-77-69-74-63-68-00-00-00-00-00'),
  /** Resolume identity — used by Resolume Arena/Avenue. */
  RESOLUME: parseDeviceId('52-65-73-6F-6C-75-6D-65-00-00-00-00-00-00-00-00'),
  /** Generic listener identity — passive observer. */
  LISTEN: parseDeviceId('00-00-00-00-00-00-00-00-00-00-00-00-00-00-00-00'),
} as const;
