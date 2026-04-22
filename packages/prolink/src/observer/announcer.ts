/**
 * Periodically broadcasts our keep-alive packet so peers on the network
 * treat us as a real participant and begin sending unicast status packets
 * to our open port-50002 socket.
 *
 * Cadence: `ANNOUNCE_INTERVAL_MS` = 1500 ms, matching real hardware and
 * prolink-connect's default (`ANNOUNCE_INTERVAL` in its `src/constants.ts`).
 *
 * **Observer mode specifically does NOT:**
 *   - Run the stage-1/2/3 claim choreography (kinds `0x0a`, `0x00`, `0x02`,
 *     `0x04`). prolink-connect skips it and it still works in the field;
 *     we follow the same pragmatic approach.
 *   - Send any sync, master-handoff, load-track, or fader-start packets.
 *   - Send kind-`0x0a` CDJ status packets. A richer "virtual CDJ" mode
 *     that does that can be built later on top of this announcer.
 *
 * The unit of work is the packet builder passed in — the announcer does not
 * know how to construct a keep-alive, so swapping the packet shape (e.g. for
 * a rekordbox laptop or an alternate device-type byte) is a one-liner.
 */

import type { UdpTransport } from '../transport/udp.js';

/** Real-hardware cadence for keep-alives: 1.5 s between broadcasts. */
export const ANNOUNCE_INTERVAL_MS = 1500;

export type PacketBuilder = () => Uint8Array;

export interface AnnouncerOptions {
  /**
   * Interval in ms between broadcasts. Default: `ANNOUNCE_INTERVAL_MS`
   * (1500). Lower values are valid for tests; real hardware may get cranky
   * if you go much faster than the 1.5 s cadence.
   */
  readonly intervalMs?: number;
  /**
   * Optional error sink — called whenever a broadcast fails (e.g. socket
   * closed during stop). Useful for logging; silence by default.
   */
  readonly onError?: (err: Error) => void;
}

/**
 * Drives periodic keep-alive broadcasts on the discovery socket. The
 * packet contents are rebuilt every tick by calling `buildPacket()` so
 * callers can update the payload between ticks (unusual, but harmless).
 *
 * Lifecycle:
 *   const announcer = new Announcer(transport, buildPacket);
 *   await announcer.start();
 *   ...
 *   await announcer.stop();
 */
export class Announcer {
  private readonly transport: UdpTransport;
  private readonly buildPacket: PacketBuilder;
  private readonly intervalMs: number;
  private readonly onError: (err: Error) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending = false;

  constructor(transport: UdpTransport, buildPacket: PacketBuilder, options: AnnouncerOptions = {}) {
    this.transport = transport;
    this.buildPacket = buildPacket;
    this.intervalMs = options.intervalMs ?? ANNOUNCE_INTERVAL_MS;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * Begin announcing. Sends one packet immediately so peers notice us
   * without waiting a full interval, then continues on the configured
   * cadence. Idempotent — calling `start()` twice is a no-op.
   */
  async start(): Promise<void> {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
    // Send one immediately so discovery doesn't wait for the first tick.
    await this.tick();
  }

  /** Stop announcing. Safe to call if never started. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    // Guard against overlapping sends if the network is slow. We don't
    // queue backlog — a dropped tick is fine, the next one covers it.
    if (this.sending) return;
    this.sending = true;
    try {
      const packet = this.buildPacket();
      await this.transport.broadcastFromDiscovery(packet);
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.sending = false;
    }
  }
}
