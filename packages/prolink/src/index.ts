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

// Metadata — ANLZ + PDB parsers, media readers
export { parseAnlzFile, parseSectionHeader, SECTION_HEADER_SIZE } from './metadata/anlz.js';
export { parseBeatGrid } from './metadata/beat-grid.js';
export { parseCuesExtended, parseCuesLegacy } from './metadata/cues.js';
export {
  FilesystemMediaReader,
  type MediaReader,
  MetadataStore,
} from './metadata/media-reader.js';
export { anlzExtPath, type PdbDatabase, parsePdb } from './metadata/pdb.js';
export { parsePhrases } from './metadata/phrases.js';
export type {
  AnlzFile,
  BeatGridEntry,
  CuePoint,
  CueType,
  HighPhraseKind,
  LowPhraseKind,
  MidPhraseKind,
  Phrase,
  PhraseAnalysis,
  PhraseKind,
  TrackAnalysis,
  TrackBank,
  TrackMetadata,
  TrackMood,
} from './metadata/types.js';
// NFS — network file access to CDJ USB/SD exports
export { NfsClient, NfsMediaReader } from './nfs/index.js';
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
export {
  type AbsolutePositionHandler,
  type BeatHandler,
  type DeckState,
  type MixerStatusHandler,
  Observer,
  type ObserverOptions,
  type OnAirHandler,
  type RawPacketHandler,
  type StatusHandler,
  type TrackAnalysisHandler,
} from './observer/index.js';
export {
  type PhaseState,
  PhaseTracker,
  type PhaseTrackerOptions,
} from './observer/phase-tracker.js';
export {
  ABSOLUTE_POSITION_LENGTH,
  ABSOLUTE_POSITION_MIN_LENGTH,
  type AbsolutePosition,
  type BuildAbsolutePositionOptions,
  buildAbsolutePosition,
  parseAbsolutePosition,
} from './packets/absolute-position.js';
export {
  BEAT_LENGTH,
  type BuildBeatOptions,
  buildBeat,
  decodePitch,
  encodePitch,
  parseBeat,
} from './packets/beat.js';
export {
  buildKeepAlive,
  classifyDeviceType,
  DEVICE_NAME_MAX_LENGTH,
  KEEP_ALIVE_LENGTH,
  parseKeepAlive,
} from './packets/keepalive.js';
export {
  type BuildMixerStatusOptions,
  buildMixerStatus,
  MIXER_STATUS_LENGTH,
  parseMixerStatus,
} from './packets/mixer-status.js';
export {
  type BuildOnAirOptions,
  buildOnAir,
  type ChannelsOnAir,
  ON_AIR_6CH_LENGTH,
  ON_AIR_MIN_LENGTH,
  parseOnAir,
} from './packets/on-air.js';
export {
  type BuildStatusOptions,
  buildStatus,
  PlayState,
  parseStatus,
  STATUS_LENGTH,
  STATUS_MIN_LENGTH,
  TrackSlot,
  TrackType,
} from './packets/status.js';
// Packet types and parsing
export type {
  Beat,
  CdjStatus,
  Device,
  DeviceType,
  MixerStatus,
  SelfIdentity,
} from './packets/types.js';
export { BEAT_TIMING_TRACK_ENDS, DEVICE_TYPE_BYTE, deviceTypeToCategory } from './packets/types.js';
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
