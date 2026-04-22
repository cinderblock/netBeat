/**
 * Thin wrapper around Node's `dgram` that binds the three Pro DJ Link UDP
 * ports, delivers inbound packets as labeled events, and exposes a single
 * `send()` for broadcasting keep-alives.
 *
 * Design notes:
 *
 * - **All three ports are always bound.** Even in pure-passive mode we want
 *   port 50002 open so we'd receive unicast status packets the moment any
 *   peer decides to send them to us. Leaving a port closed would mean
 *   silently dropping them.
 * - **Broadcast sends go through the 50000 socket** because keep-alives
 *   originate from port 50000 on real hardware; peers use the source port
 *   to correlate the announcer with its announce traffic.
 * - **Per-port handlers** so the `Observer` can route by port+kind without
 *   re-reading the destination port on every packet. The only way to
 *   recover the destination port once Node delivers the packet is to know
 *   which socket fired the `message` event.
 */

import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { PORTS, type Port } from '../protocol/ports.js';

/** Callback fired for each UDP datagram received on a bound port. */
export type PacketHandler = (packet: Uint8Array, remote: RemoteInfo, port: Port) => void;

/** Callback fired when any of the underlying sockets emits an error. */
export type TransportErrorHandler = (err: Error, port: Port) => void;

export interface UdpTransportOptions {
  /**
   * Local IPv4 address to bind each socket to. Defaults to `0.0.0.0` so we
   * accept traffic from every interface; supply the DJ-network interface
   * address if the host has multiple NICs and you want to constrain which
   * one sees the announce traffic.
   */
  readonly bindAddress?: string;
  /** Global broadcast address to send keep-alives to. Defaults to `255.255.255.255`. */
  readonly broadcastAddress?: string;
}

/**
 * Binds all three Pro DJ Link ports on construction. The class is intentionally
 * dumb — it does not interpret packets. Callers attach a `PacketHandler`
 * that demultiplexes by port and kind.
 */
export class UdpTransport {
  private readonly sockets = new Map<Port, Socket>();
  private readonly bindAddress: string;
  private readonly broadcastAddress: string;
  private started = false;
  private handler: PacketHandler | null = null;
  private errorHandler: TransportErrorHandler | null = null;

  constructor(options: UdpTransportOptions = {}) {
    this.bindAddress = options.bindAddress ?? '0.0.0.0';
    this.broadcastAddress = options.broadcastAddress ?? '255.255.255.255';
  }

  /** Register the per-packet handler. Replaces any prior handler. */
  onPacket(handler: PacketHandler): void {
    this.handler = handler;
  }

  /** Register the error handler. Replaces any prior handler. */
  onError(handler: TransportErrorHandler): void {
    this.errorHandler = handler;
  }

  /** Bind all three UDP sockets and enable broadcast on the announce socket. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // We must bind all three sockets to receive everything.
    const tasks: Promise<void>[] = [];
    for (const port of [PORTS.DISCOVERY, PORTS.BEAT, PORTS.STATUS] as const) {
      tasks.push(this.bindSocket(port));
    }
    try {
      await Promise.all(tasks);
    } catch (err) {
      // If any bind fails, tear down whatever succeeded so we don't leak.
      await this.stop().catch(() => {});
      throw err;
    }
  }

  private bindSocket(port: Port): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: true });
      let settled = false;

      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        this.errorHandler?.(err, port);
      });

      socket.on('message', (msg, remote) => {
        // Convert Node `Buffer` (a subclass of Uint8Array) to a plain
        // `Uint8Array` view so downstream code doesn't depend on `Buffer`.
        const packet = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
        this.handler?.(packet, remote, port);
      });

      socket.on('listening', () => {
        if (port === PORTS.DISCOVERY) {
          // Only the announce socket needs to emit broadcasts.
          try {
            socket.setBroadcast(true);
          } catch (err) {
            if (!settled) {
              settled = true;
              reject(err);
              return;
            }
          }
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      this.sockets.set(port, socket);
      socket.bind({ port, address: this.bindAddress, exclusive: false });
    });
  }

  /**
   * Broadcast a packet from the discovery (50000) socket to the configured
   * broadcast address, port 50000. This is the exact path a keep-alive
   * takes on real hardware.
   */
  broadcastFromDiscovery(packet: Uint8Array): Promise<void> {
    const socket = this.sockets.get(PORTS.DISCOVERY);
    if (!socket) {
      return Promise.reject(
        new Error('UdpTransport: discovery socket not bound; call start() first'),
      );
    }
    return new Promise((resolve, reject) => {
      socket.send(packet, 0, packet.length, PORTS.DISCOVERY, this.broadcastAddress, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Close all sockets. Safe to call more than once. */
  async stop(): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const socket of this.sockets.values()) {
      closes.push(
        new Promise<void>((resolve) => {
          socket.close(() => resolve());
        }),
      );
    }
    this.sockets.clear();
    this.started = false;
    await Promise.all(closes);
  }
}
