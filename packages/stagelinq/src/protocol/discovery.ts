/**
 * StageLinQ discovery message parser and builder.
 *
 * Discovery uses UDP broadcast on port 51337. Each message starts with the
 * 4-byte magic `"airD"`, followed by structured fields:
 *
 *   [4B magic "airD"]
 *   [16B DeviceId]
 *   [NetworkString source]
 *   [NetworkString action]
 *   [NetworkString softwareName]
 *   [NetworkString softwareVersion]
 *   [2B port (u16 BE)]
 */

import { type DeviceId, readDeviceId, writeDeviceId } from './device-id.js';
import { DISCOVERY_MAGIC, DISCOVERY_MAGIC_LENGTH } from './ports.js';
import { ReadContext } from './read-context.js';
import { WriteContext } from './write-context.js';

/** Discovery action strings. */
export const DISCOVERY_ACTION = {
  /** Device is announcing its presence on the network. */
  LOGIN: 'DISCOVERER_HOWDY_',
  /** Device is leaving the network. */
  LOGOUT: 'DISCOVERER_EXIT_',
} as const;

export type DiscoveryAction = (typeof DISCOVERY_ACTION)[keyof typeof DISCOVERY_ACTION];

/** Parsed discovery message. */
export interface DiscoveryMessage {
  /** 16-byte UUID identifying the device. */
  readonly deviceId: DeviceId;
  /** Source identifier (usually the device name or hostname). */
  readonly source: string;
  /** Action: login (HOWDY) or logout (EXIT). */
  readonly action: DiscoveryAction;
  /** Software name — often a model code like "JP13" for SC6000. */
  readonly softwareName: string;
  /** Software version string. */
  readonly softwareVersion: string;
  /** TCP port where the device's Directory service is listening. */
  readonly port: number;
}

/**
 * Validate that a buffer starts with the discovery magic `"airD"`.
 */
export function hasDiscoveryMagic(buf: Uint8Array): boolean {
  if (buf.length < DISCOVERY_MAGIC_LENGTH) return false;
  for (let i = 0; i < DISCOVERY_MAGIC_LENGTH; i++) {
    if (buf[i] !== DISCOVERY_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Parse a discovery message from raw UDP data.
 * Returns `null` if the buffer is malformed or too short.
 */
export function parseDiscovery(buf: Uint8Array): DiscoveryMessage | null {
  if (!hasDiscoveryMagic(buf)) return null;

  try {
    const ctx = new ReadContext(buf, DISCOVERY_MAGIC_LENGTH);
    const deviceId = readDeviceId(ctx);
    const source = ctx.readNetworkString();
    const action = ctx.readNetworkString();
    const softwareName = ctx.readNetworkString();
    const softwareVersion = ctx.readNetworkString();

    if (!ctx.hasBytes(2)) return null;
    const port = ctx.readUInt16();

    if (action !== DISCOVERY_ACTION.LOGIN && action !== DISCOVERY_ACTION.LOGOUT) {
      return null;
    }

    return { deviceId, source, action, softwareName, softwareVersion, port };
  } catch {
    return null;
  }
}

/** Options for building a discovery message. */
export interface BuildDiscoveryOptions {
  readonly deviceId: DeviceId;
  readonly source: string;
  readonly action: DiscoveryAction;
  readonly softwareName: string;
  readonly softwareVersion: string;
  readonly port: number;
}

/**
 * Build a discovery message as a `Uint8Array` ready for UDP broadcast.
 */
export function buildDiscovery(opts: BuildDiscoveryOptions): Uint8Array {
  const ctx = new WriteContext();
  ctx.writeBytes(DISCOVERY_MAGIC);
  writeDeviceId(ctx, opts.deviceId);
  ctx.writeNetworkString(opts.source);
  ctx.writeNetworkString(opts.action);
  ctx.writeNetworkString(opts.softwareName);
  ctx.writeNetworkString(opts.softwareVersion);
  ctx.writeUInt16(opts.port);
  return ctx.finish();
}
