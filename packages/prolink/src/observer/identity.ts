/**
 * Helpers for turning the host's network interface list into a valid
 * `SelfIdentity`. Getting the IP and MAC right is the most error-prone part
 * of configuring observer mode — a mismatched IP makes every peer's
 * unicast reply land in the wrong place — so these helpers centralize the
 * lookup and validate the result.
 */

import { networkInterfaces } from 'node:os';
import type { SelfIdentity } from '../packets/types.js';
import { DEVICE_TYPE_BYTE } from '../packets/types.js';

export interface NetworkInterfaceInfo {
  /** Interface name as reported by the OS (e.g. `'Ethernet'`, `'en0'`). */
  readonly name: string;
  /** Dotted-quad IPv4 address. */
  readonly ip: string;
  /** 6-byte hardware address copied from the OS record. */
  readonly mac: Uint8Array;
  /** IPv4 subnet mask (for later use — not currently read by this module). */
  readonly netmask: string;
  /** CIDR like `192.168.1.42/24`, if the OS provided one. */
  readonly cidr: string | null;
}

/**
 * Enumerate every non-loopback, non-internal IPv4 interface on the host
 * that has a usable MAC address. The result is consumable directly by
 * `buildIdentity()`.
 */
export function listInterfaces(): NetworkInterfaceInfo[] {
  const out: NetworkInterfaceInfo[] = [];
  const all = networkInterfaces();
  for (const [name, addrs] of Object.entries(all)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4') continue;
      if (addr.internal) continue;
      const mac = parseMacString(addr.mac);
      if (!mac) continue;
      out.push({
        name,
        ip: addr.address,
        mac,
        netmask: addr.netmask,
        cidr: addr.cidr,
      });
    }
  }
  return out;
}

/** Parse an `aa:bb:cc:dd:ee:ff` MAC string into 6 bytes. Returns null on failure. */
function parseMacString(mac: string): Uint8Array | null {
  const parts = mac.split(':');
  if (parts.length !== 6) return null;
  const out = new Uint8Array(6);
  for (let i = 0; i < 6; i++) {
    const raw = parts[i];
    if (raw === undefined || raw.length === 0) return null;
    const n = Number.parseInt(raw, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xff) return null;
    out[i] = n;
  }
  // Many OSes report `00:00:00:00:00:00` for virtual/unusable interfaces.
  // Those are useless for announce traffic.
  if (out.every((b) => b === 0)) return null;
  return out;
}

export interface BuildIdentityOptions {
  /** Player number to claim. Observer mode defaults to `7` (outside 1..4). */
  readonly id?: number;
  /**
   * Human-readable name to broadcast. ≤ 20 ASCII chars. Defaults to
   * `'netbeat'`.
   */
  readonly name?: string;
  /**
   * Interface selection. Either a name (`'Ethernet'`) or an explicit IP
   * (`'192.168.1.42'`). If omitted we pick the first non-loopback IPv4
   * interface — deterministic but rarely what you want on a multi-NIC
   * machine, so prefer to specify.
   */
  readonly interface?: string;
  /**
   * Raw device-type byte to advertise. Defaults to CDJ (`0x01`). Passing
   * `DEVICE_TYPE_BYTE.REKORDBOX` poses as a rekordbox laptop instead,
   * which slightly changes what peers are willing to send us.
   */
  readonly rawType?: number;
}

/** Default observer player number. Outside 1..4 to avoid CDJ contention. */
export const DEFAULT_OBSERVER_ID = 7;
/** Default observer display name. Under the 20-char limit with headroom. */
export const DEFAULT_OBSERVER_NAME = 'netbeat';

/**
 * Resolve a `SelfIdentity` by inspecting the host's network interfaces.
 *
 * Throws if no usable interface is found, or if the caller specified an
 * interface name/IP that doesn't exist — both are unrecoverable configuration
 * errors, so failing loudly beats a silent misconfiguration that drops
 * traffic into the void.
 */
export function buildIdentity(options: BuildIdentityOptions = {}): SelfIdentity {
  const id = options.id ?? DEFAULT_OBSERVER_ID;
  const name = options.name ?? DEFAULT_OBSERVER_NAME;
  const rawType = options.rawType ?? DEVICE_TYPE_BYTE.CDJ;

  const interfaces = listInterfaces();
  if (interfaces.length === 0) {
    throw new Error(
      'netbeat: no usable IPv4 interfaces found (none with a non-zero MAC). ' +
        'Cannot announce ourselves on the Pro DJ Link network.',
    );
  }

  let chosen: NetworkInterfaceInfo | undefined;
  if (options.interface !== undefined) {
    const sel = options.interface;
    chosen = interfaces.find((i) => i.name === sel || i.ip === sel);
    if (!chosen) {
      const available = interfaces.map((i) => `${i.name} (${i.ip})`).join(', ');
      throw new Error(
        `netbeat: interface ${JSON.stringify(sel)} not found. Available: ${available}`,
      );
    }
  } else {
    chosen = interfaces[0];
  }

  // TypeScript `noUncheckedIndexedAccess` guard — we've proven `chosen` is
  // defined by this point, but the compiler wants the narrowing explicit.
  if (!chosen) {
    throw new Error('netbeat: interface selection failed');
  }

  return {
    id,
    name,
    ip: chosen.ip,
    mac: chosen.mac,
    rawType,
  };
}
