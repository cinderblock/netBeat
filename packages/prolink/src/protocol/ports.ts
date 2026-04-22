/**
 * Well-known UDP ports used by Pioneer Pro DJ Link.
 *
 * Sources: `dysentery/doc/modules/ROOT/pages/packets.adoc` ("Port 50000
 * Packets" through "Port 50002 Packets") and `prolink-connect/src/constants.ts`
 * (`ANNOUNCE_PORT` / `BEAT_PORT` / `STATUS_PORT`).
 */
export const PORTS = {
  /** Device discovery, keep-alive announcements, player-number claim negotiation. */
  DISCOVERY: 50000,
  /** Beat packets, fader-start commands, channels-on-air flags, absolute-position (CDJ-3000). */
  BEAT: 50001,
  /** CDJ status, mixer status, media-slot queries, load-track commands. */
  STATUS: 50002,
} as const;

export type Port = (typeof PORTS)[keyof typeof PORTS];

/** All ports we need to bind sockets to for observer mode. */
export const ALL_PORTS: readonly Port[] = Object.freeze([
  PORTS.DISCOVERY,
  PORTS.BEAT,
  PORTS.STATUS,
]);
