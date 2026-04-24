/**
 * Packet-kind discriminator byte (packet[`0x0a`]) values, grouped by the
 * port they travel on. Same byte is reused across ports with different
 * meanings, so always pair a kind with its port before switching.
 *
 * Sources: `dysentery/.../packets.adoc` tables per port; cross-checked
 * against `prolink-connect/src/devices/utils.ts` and
 * `src/status/utils.ts` for the kinds those parsers accept.
 */

/** Kinds seen on port 50000 (device discovery / claim negotiation). */
export const DiscoveryKind = {
  /** Initial announcement — broadcast 3× during startup. */
  INITIAL_ANNOUNCE: 0x0a,
  /** Stage-1 channel-number claim — broadcast 3×. */
  CLAIM_STAGE_1: 0x00,
  /** Mixer channel-assignment intention (mixer→CDJ). */
  MIXER_ASSIGN_INTENT: 0x01,
  /** Stage-2 channel-number claim (has IP/MAC/claimed ID). */
  CLAIM_STAGE_2: 0x02,
  /** Mixer channel assignment (assigns ID) (mixer→CDJ). */
  MIXER_ASSIGN: 0x03,
  /** Stage-3 / final channel-number claim. */
  CLAIM_STAGE_3: 0x04,
  /** Mixer assignment finished. */
  MIXER_ASSIGN_DONE: 0x05,
  /**
   * Keep-alive packet — broadcast every ~1.5 s by every device while it is
   * on the network. Observed as the "device announce" for inventory purposes.
   */
  KEEP_ALIVE: 0x06,
  /** Channel conflict — another device already claims the same player number. */
  CHANNEL_CONFLICT: 0x08,
} as const;

export type DiscoveryKind = (typeof DiscoveryKind)[keyof typeof DiscoveryKind];

/** Kinds seen on port 50001 (beat / mixer realtime). */
export const BeatKind = {
  /** Per-player fader-start command (C1..C4). */
  FADER_START: 0x02,
  /** Channels-on-air flags (F1..F4, or F1..F6 on DJM-V10). */
  CHANNELS_ON_AIR: 0x03,
  /** Absolute-position packet (CDJ-3000 only, every 30 ms). */
  ABSOLUTE_POSITION: 0x0b,
  /** Master-handoff takeover request. */
  MASTER_HANDOFF_REQUEST: 0x26,
  /** Master-handoff takeover response. */
  MASTER_HANDOFF_RESPONSE: 0x27,
  /** Beat packet — 96 bytes (`0x60`), one per beat while playing. */
  BEAT: 0x28,
  /** Sync control (turn sync on/off, force master). */
  SYNC_CONTROL: 0x2a,
} as const;

export type BeatKind = (typeof BeatKind)[keyof typeof BeatKind];

/** Kinds seen on port 50002 (status / control). */
export const StatusKind = {
  /** Media-slot query — "what's in this slot?" (48 B). */
  MEDIA_SLOT_QUERY: 0x05,
  /** Media-slot response (~192 B). */
  MEDIA_SLOT_RESPONSE: 0x06,
  /** CDJ status packet (~every 200 ms). Length varies by model. */
  CDJ_STATUS: 0x0a,
  /** Load-track command (remote-load, 0x58 bytes). */
  LOAD_TRACK: 0x19,
  /** Load-track acknowledgment. */
  LOAD_TRACK_ACK: 0x1a,
  /** Mixer status packet (56 B). */
  MIXER_STATUS: 0x29,
  /** Load-settings command. */
  LOAD_SETTINGS: 0x34,
} as const;

export type StatusKind = (typeof StatusKind)[keyof typeof StatusKind];
