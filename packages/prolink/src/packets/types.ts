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
