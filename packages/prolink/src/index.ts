/**
 * `@netbeat/prolink` — read-only observer for Pioneer Pro DJ Link.
 *
 * Two read-only modes are planned:
 *   - **Passive mode**: receive broadcasts only. Gets keep-alives, beats,
 *     on-air flags, CDJ-3000 absolute-position. No unicast status — peers
 *     only unicast to endpoints that announced themselves.
 *   - **Observer mode**: announce ourselves as a virtual CDJ so peers
 *     unicast their status packets to us. Still never sends sync, control,
 *     or load-track commands.
 *
 * This release exposes observer mode as the primary entry point. Passive
 * mode is reachable via `new Observer({ ..., passive: true })`.
 *
 * See `docs/protocol-reference.md` §7 and `docs/research.md` §"Notes on
 * read-only ethics" for the design rationale.
 */

/** Protocol identifier this package implements. */
export const PROTOCOL = 'pro-dj-link' as const;

export { ANNOUNCE_INTERVAL_MS, Announcer, type AnnouncerOptions } from './observer/announcer.js';
export {
  type DeviceEvent,
  type DeviceListener,
  DeviceManager,
  type DeviceManagerOptions,
} from './observer/device-manager.js';
export {
  type BuildIdentityOptions,
  buildIdentity,
  DEFAULT_OBSERVER_ID,
  DEFAULT_OBSERVER_NAME,
  listInterfaces,
  type NetworkInterfaceInfo,
} from './observer/identity.js';
// Observer
export { Observer, type ObserverOptions, type RawPacketHandler } from './observer/index.js';
export {
  buildKeepAlive,
  classifyDeviceType,
  DEVICE_NAME_MAX_LENGTH,
  KEEP_ALIVE_LENGTH,
  parseKeepAlive,
} from './packets/keepalive.js';
// Packet types and parsing
export type { Device, DeviceType, SelfIdentity } from './packets/types.js';
export { DEVICE_TYPE_BYTE } from './packets/types.js';
export {
  hasProlinkHeader,
  KIND_OFFSET,
  MIN_PACKET_LENGTH,
  PROLINK_HEADER,
  readKind,
} from './protocol/header.js';
export { BeatKind, DiscoveryKind, StatusKind } from './protocol/kinds.js';
// Protocol primitives
export { ALL_PORTS, PORTS, type Port } from './protocol/ports.js';

// Transport (exported for advanced users who want to plug in a custom observer)
export { type PacketHandler, UdpTransport, type UdpTransportOptions } from './transport/udp.js';
