/**
 * `Observer` — the public entry point for StageLinQ observer mode.
 *
 * Discovers Denon Prime-series devices on the network, connects to their
 * Directory/StateMap/BeatInfo services, and surfaces real-time deck state
 * to consumers. Read-only: never sends control or sync commands.
 *
 * Consumer surface:
 *
 *   const observer = new Observer({ name: 'netbeat' });
 *   observer.onDevice((event, device) => console.log(event, device));
 *   observer.onStateChange((device, path, value) => ...);
 *   observer.onBeatInfo((device, decks, clock) => ...);
 *   await observer.start();
 *   ...
 *   await observer.stop();
 *
 * The observer handles:
 *   1. UDP discovery (port 51337) — find devices, announce ourselves
 *   2. TCP Directory — learn which services each device offers
 *   3. StateMap — subscribe to deck state paths, receive updates
 *   4. BeatInfo — receive beat/BPM/phase data per deck
 */

import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { connect, createServer, type Server, type Socket as TcpSocket } from 'node:net';
import {
  type DeviceId,
  deviceIdEquals,
  formatDeviceId,
  randomDeviceId,
} from '../protocol/device-id.js';
import {
  buildServiceHandshake,
  DIRECTORY_MSG,
  parseDirectoryMessage,
  type ServiceEntry,
} from '../protocol/directory.js';
import { buildDiscovery, DISCOVERY_ACTION, parseDiscovery } from '../protocol/discovery.js';
import { DISCOVERY_PORT } from '../protocol/ports.js';
import { SERVICE_NAME } from '../protocol/services.js';
import { frameMessage, MessageFramer } from '../protocol/tcp-framing.js';
import { buildBeatInfoSubscription, parseBeatInfoMessage } from '../services/beat-info.js';
import {
  buildStateMapSubscribe,
  parseStateMapMessage,
  parseStateValue,
} from '../services/state-map.js';
import { defaultStatePaths } from '../services/state-paths.js';
import { DeviceManager, type DeviceManagerOptions } from './device-manager.js';
import type {
  BeatInfoHandler,
  DeckState,
  DeviceListener,
  DeviceState,
  StageLinqDevice,
  StateChangeHandler,
} from './types.js';

export interface ObserverOptions {
  /** Display name for our observer on the network. Default: "netbeat". */
  readonly name?: string;
  /** Software version string to advertise. Default: "0.0.0". */
  readonly version?: string;
  /** Network interface to bind to (IP address). Default: "0.0.0.0" (all). */
  readonly bindAddress?: string;
  /** Broadcast address for discovery. Default: "255.255.255.255". */
  readonly broadcastAddress?: string;
  /** Discovery broadcast interval in ms. Default: 1000. */
  readonly discoveryIntervalMs?: number;
  /** Device manager options (staleness, sweep interval). */
  readonly deviceManager?: DeviceManagerOptions;
  /**
   * State paths to subscribe to on each device. Default: the curated set
   * from `defaultStatePaths()`. Pass an empty array to skip StateMap entirely.
   */
  readonly statePaths?: readonly string[];
  /**
   * Whether to subscribe to BeatInfo on discovered devices. Default: true.
   */
  readonly beatInfo?: boolean;
}

/** Internal tracking for a connected device's services. */
interface DeviceConnection {
  readonly device: StageLinqDevice;
  readonly sockets: TcpSocket[];
  /** Raw state values from StateMap, keyed by path. */
  readonly stateValues: Map<string, unknown>;
  /** Latest beat info per deck. */
  readonly beatInfoDecks: Map<number, import('../services/beat-info.js').DeckBeatInfo>;
  /** Latest beat info clock. */
  beatInfoClock: bigint;
}

/**
 * Observer mode orchestrator for StageLinQ. Owns discovery, device manager,
 * and per-device service connections.
 */
export class Observer {
  private readonly name: string;
  private readonly version: string;
  private readonly bindAddress: string;
  private readonly broadcastAddress: string;
  private readonly discoveryIntervalMs: number;
  private readonly deviceId: DeviceId;
  private readonly deviceManager: DeviceManager;
  private readonly statePaths: readonly string[];
  private readonly subscribeBeatInfo: boolean;

  private readonly deviceListeners = new Set<DeviceListener>();
  private readonly stateChangeHandlers = new Set<StateChangeHandler>();
  private readonly beatInfoHandlers = new Set<BeatInfoHandler>();

  /** Active connections to discovered devices, keyed by formatted DeviceId. */
  private readonly connections = new Map<string, DeviceConnection>();

  private udpSocket: UdpSocket | null = null;
  private directoryServer: Server | null = null;
  private directoryPort = 0;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(options: ObserverOptions = {}) {
    this.name = options.name ?? 'netbeat';
    this.version = options.version ?? '0.0.0';
    this.bindAddress = options.bindAddress ?? '0.0.0.0';
    this.broadcastAddress = options.broadcastAddress ?? '255.255.255.255';
    this.discoveryIntervalMs = options.discoveryIntervalMs ?? 1000;
    this.deviceId = randomDeviceId();
    this.subscribeBeatInfo = options.beatInfo ?? true;

    this.deviceManager = new DeviceManager(options.deviceManager);

    // Determine state paths: use provided, or generate defaults based on
    // discovered device deck count (we'll use 4 as default for subscriptions
    // since we subscribe per-device and adjust later if needed).
    this.statePaths = options.statePaths ?? defaultStatePaths(4);

    // When a new device appears, connect to its services.
    this.deviceManager.onEvent((event, device) => {
      if (event === 'added') {
        this.connectToDevice(device);
      } else if (event === 'removed') {
        this.disconnectDevice(device);
      }

      // Forward to user listeners.
      for (const listener of this.deviceListeners) {
        try {
          listener(event, device);
        } catch {
          // Consumer errors must not break the observer.
        }
      }
    });
  }

  /** Subscribe to device add/update/remove events. Returns an unsubscribe fn. */
  onDevice(listener: DeviceListener): () => void {
    this.deviceListeners.add(listener);
    return () => {
      this.deviceListeners.delete(listener);
    };
  }

  /** Subscribe to state change events. Returns an unsubscribe fn. */
  onStateChange(handler: StateChangeHandler): () => void {
    this.stateChangeHandlers.add(handler);
    return () => {
      this.stateChangeHandlers.delete(handler);
    };
  }

  /** Subscribe to beat info events. Returns an unsubscribe fn. */
  onBeatInfo(handler: BeatInfoHandler): () => void {
    this.beatInfoHandlers.add(handler);
    return () => {
      this.beatInfoHandlers.delete(handler);
    };
  }

  /** List all currently known devices. */
  devices(): StageLinqDevice[] {
    return this.deviceManager.list();
  }

  /**
   * Get aggregated state for a specific device.
   * Returns `null` if the device is not connected.
   */
  getDeviceState(deviceId: DeviceId): DeviceState | null {
    const key = formatDeviceId(deviceId);
    const conn = this.connections.get(key);
    if (!conn) return null;
    return this.buildDeviceState(conn);
  }

  /**
   * Get aggregated state for all connected devices.
   */
  allDeviceStates(): DeviceState[] {
    return [...this.connections.values()].map((conn) => this.buildDeviceState(conn));
  }

  /**
   * Get the deck state for a specific deck on a specific device.
   * Returns `null` if the device or deck is not found.
   */
  getDeck(deviceId: DeviceId, deckNumber: number): DeckState | null {
    const state = this.getDeviceState(deviceId);
    if (!state) return null;
    return state.decks.find((d) => d.deckNumber === deckNumber) ?? null;
  }

  /**
   * Bring the observer online:
   *   1. Start a TCP server for our Directory service (so devices can connect to us)
   *   2. Bind the UDP discovery socket
   *   3. Start the discovery announcer
   *   4. Start the device manager sweep timer
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      // Start our Directory TCP server on an OS-assigned port.
      await this.startDirectoryServer();

      // Bind UDP discovery socket.
      await this.startDiscovery();

      // Start device staleness sweeping.
      this.deviceManager.start();
    } catch (err) {
      this.started = false;
      await this.stop().catch(() => {});
      throw err;
    }
  }

  /** Take the observer offline. Safe to call even if already stopped. */
  async stop(): Promise<void> {
    // Stop discovery broadcasts.
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }

    // Send logout discovery.
    if (this.udpSocket) {
      try {
        const logout = buildDiscovery({
          deviceId: this.deviceId,
          source: this.name,
          action: DISCOVERY_ACTION.LOGOUT,
          softwareName: this.name,
          softwareVersion: this.version,
          port: this.directoryPort,
        });
        this.udpSocket.send(logout, DISCOVERY_PORT, this.broadcastAddress);
      } catch {
        // Best-effort logout.
      }
    }

    // Close all device connections.
    for (const conn of this.connections.values()) {
      for (const sock of conn.sockets) {
        sock.destroy();
      }
    }
    this.connections.clear();

    // Stop device manager.
    this.deviceManager.stop();
    this.deviceManager.clear();

    // Close UDP socket.
    if (this.udpSocket) {
      const socket = this.udpSocket;
      this.udpSocket = null;
      await new Promise<void>((resolve) => {
        socket.close(() => resolve());
      });
    }

    // Close Directory server.
    if (this.directoryServer) {
      const server = this.directoryServer;
      this.directoryServer = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    this.directoryPort = 0;
    this.started = false;
  }

  // ─── Discovery ──────────────────────────────────────────────────────

  private startDiscovery(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: true });

      socket.on('error', (err) => {
        if (!this.started) {
          reject(err);
          return;
        }
        // Runtime errors — log but don't crash.
      });

      socket.on('message', (msg, rinfo) => {
        const discovery = parseDiscovery(new Uint8Array(msg));
        if (!discovery) return;

        // Ignore our own broadcasts.
        if (deviceIdEquals(discovery.deviceId, this.deviceId)) return;

        this.deviceManager.ingest(discovery, rinfo.address);
      });

      socket.bind(DISCOVERY_PORT, this.bindAddress, () => {
        socket.setBroadcast(true);
        this.udpSocket = socket;

        // Send initial discovery broadcast.
        this.sendDiscoveryBroadcast();

        // Start periodic broadcasts.
        this.discoveryTimer = setInterval(
          () => this.sendDiscoveryBroadcast(),
          this.discoveryIntervalMs,
        );

        resolve();
      });
    });
  }

  private sendDiscoveryBroadcast(): void {
    if (!this.udpSocket) return;

    const msg = buildDiscovery({
      deviceId: this.deviceId,
      source: this.name,
      action: DISCOVERY_ACTION.LOGIN,
      softwareName: this.name,
      softwareVersion: this.version,
      port: this.directoryPort,
    });

    this.udpSocket.send(msg, DISCOVERY_PORT, this.broadcastAddress, (err) => {
      if (err) {
        // Broadcast failure — not fatal, will retry on next interval.
      }
    });
  }

  // ─── Directory Server ───────────────���───────────────────────────────

  private startDirectoryServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        // Inbound TCP connection from a device wanting to use our services.
        // For now we just handle the handshake — we're a listener, not a
        // service provider.
        socket.on('error', () => {
          socket.destroy();
        });
      });

      server.on('error', reject);

      server.listen(0, this.bindAddress, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this.directoryPort = addr.port;
        }
        this.directoryServer = server;
        resolve();
      });
    });
  }

  // ─── Per-Device Connection ──────────────────────────────────────────

  private connectToDevice(device: StageLinqDevice): void {
    const key = formatDeviceId(device.deviceId);
    if (this.connections.has(key)) return;

    const conn: DeviceConnection = {
      device,
      sockets: [],
      stateValues: new Map(),
      beatInfoDecks: new Map(),
      beatInfoClock: 0n,
    };
    this.connections.set(key, conn);

    // Connect to the device's Directory to discover available services.
    this.connectDirectory(conn);
  }

  private disconnectDevice(device: StageLinqDevice): void {
    const key = formatDeviceId(device.deviceId);
    const conn = this.connections.get(key);
    if (!conn) return;

    for (const sock of conn.sockets) {
      sock.destroy();
    }
    this.connections.delete(key);
  }

  private connectDirectory(conn: DeviceConnection): void {
    const socket = connect(conn.device.directoryPort, conn.device.address, () => {
      // Send our service request to learn about the device's services.
      // We request nothing specific from the Directory — we just wait for
      // the device's ServicesAnnouncement, then connect to what we need.
    });

    conn.sockets.push(socket);

    // Directory uses its own framing — message ID prefix, not length-prefixed.
    // Accumulate data and parse directory messages.
    let buffer = new Uint8Array(0);

    socket.on('data', (chunk: Buffer) => {
      const data = new Uint8Array(chunk);
      const combined = new Uint8Array(buffer.length + data.length);
      combined.set(buffer);
      combined.set(data, buffer.length);
      buffer = combined;

      // Try to parse directory messages from the accumulated buffer.
      // Directory messages have no length prefix, so we try to parse from
      // the start and consume as much as we can.
      this.handleDirectoryData(conn, buffer);
    });

    socket.on('error', () => {
      socket.destroy();
    });

    socket.on('close', () => {
      const idx = conn.sockets.indexOf(socket);
      if (idx >= 0) conn.sockets.splice(idx, 1);
    });
  }

  private handleDirectoryData(conn: DeviceConnection, data: Uint8Array): void {
    // Directory messages start with a 4-byte messageId + 16-byte deviceId,
    // then variable-length content. We attempt to parse and connect to
    // announced services.
    const msg = parseDirectoryMessage(data);
    if (!msg) return;

    if (msg.type === DIRECTORY_MSG.SERVICES_ANNOUNCEMENT) {
      for (const service of msg.services) {
        if (service.name === SERVICE_NAME.STATE_MAP && this.statePaths.length > 0) {
          this.connectStateMap(conn, service);
        } else if (service.name === SERVICE_NAME.BEAT_INFO && this.subscribeBeatInfo) {
          this.connectBeatInfo(conn, service);
        }
      }
    }
  }

  // ─── StateMap Connection ──────���─────────────────────────────────────

  private connectStateMap(conn: DeviceConnection, service: ServiceEntry): void {
    const socket = connect(service.port, conn.device.address, () => {
      // Send service handshake.
      const handshake = buildServiceHandshake(this.deviceId, SERVICE_NAME.STATE_MAP);
      socket.write(frameMessage(handshake));

      // Subscribe to all configured state paths.
      for (const path of this.statePaths) {
        const sub = buildStateMapSubscribe(path);
        socket.write(frameMessage(sub));
      }
    });

    conn.sockets.push(socket);

    const framer = new MessageFramer((payload) => {
      const update = parseStateMapMessage(payload);
      if (!update) return;

      const value = parseStateValue(update.jsonValue);
      conn.stateValues.set(update.path, value);

      // Emit to consumers.
      for (const handler of this.stateChangeHandlers) {
        try {
          handler(conn.device, update.path, value);
        } catch {
          // Consumer errors must not break the observer.
        }
      }
    });

    socket.on('data', (chunk: Buffer) => {
      framer.ingest(new Uint8Array(chunk));
    });

    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      const idx = conn.sockets.indexOf(socket);
      if (idx >= 0) conn.sockets.splice(idx, 1);
    });
  }

  // ─── BeatInfo Connection ────────────────────────────────────────────

  private connectBeatInfo(conn: DeviceConnection, service: ServiceEntry): void {
    const socket = connect(service.port, conn.device.address, () => {
      // Send service handshake.
      const handshake = buildServiceHandshake(this.deviceId, SERVICE_NAME.BEAT_INFO);
      socket.write(frameMessage(handshake));

      // Send subscription request.
      const sub = buildBeatInfoSubscription();
      socket.write(frameMessage(sub));
    });

    conn.sockets.push(socket);

    const framer = new MessageFramer((payload) => {
      const beatInfo = parseBeatInfoMessage(payload);
      if (!beatInfo) return;

      // Update per-deck beat state.
      conn.beatInfoClock = beatInfo.clock;
      for (let i = 0; i < beatInfo.decks.length; i++) {
        const deck = beatInfo.decks[i];
        if (deck) {
          conn.beatInfoDecks.set(i + 1, deck); // 1-based deck numbering
        }
      }

      // Emit to consumers.
      for (const handler of this.beatInfoHandlers) {
        try {
          handler(conn.device, beatInfo.decks, beatInfo.clock);
        } catch {
          // Consumer errors must not break the observer.
        }
      }
    });

    socket.on('data', (chunk: Buffer) => {
      framer.ingest(new Uint8Array(chunk));
    });

    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      const idx = conn.sockets.indexOf(socket);
      if (idx >= 0) conn.sockets.splice(idx, 1);
    });
  }

  // ─── State Aggregation ──────���───────────────────────────────────────

  private buildDeviceState(conn: DeviceConnection): DeviceState {
    const deckCount = conn.device.model.deckCount || 2;
    const decks: DeckState[] = [];

    for (let d = 1; d <= deckCount; d++) {
      decks.push(this.buildDeckState(conn, d));
    }

    // Mixer state.
    const crossfader = conn.stateValues.get('/Mixer/CrossfaderPosition');
    const channelFaders = new Map<number, number>();
    for (let ch = 1; ch <= 4; ch++) {
      const fader = conn.stateValues.get(`/Mixer/CH${ch}faderPosition`);
      if (typeof fader === 'number') {
        channelFaders.set(ch, fader);
      }
    }

    return {
      device: conn.device,
      decks,
      crossfaderPosition: typeof crossfader === 'number' ? crossfader : null,
      channelFaders,
    };
  }

  private buildDeckState(conn: DeviceConnection, deckNumber: number): DeckState {
    const prefix = `/Engine/Deck${deckNumber}`;

    const play = conn.stateValues.get(`${prefix}/Play`);
    const bpm = conn.stateValues.get(`${prefix}/CurrentBPM`);
    const speed = conn.stateValues.get(`${prefix}/Speed`);
    const songName = conn.stateValues.get(`${prefix}/Track/SongName`);
    const artistName = conn.stateValues.get(`${prefix}/Track/ArtistName`);
    const trackLength = conn.stateValues.get(`${prefix}/Track/TrackLength`);
    const songLoaded = conn.stateValues.get(`${prefix}/Track/SongLoaded`);
    const syncMode = conn.stateValues.get(`${prefix}/Track/SyncMode`);

    const beatInfo = conn.beatInfoDecks.get(deckNumber) ?? null;

    return {
      deckNumber,
      isPlaying: play === true || play === 1,
      bpm: typeof bpm === 'number' ? bpm : (beatInfo?.bpm ?? 0),
      speed: typeof speed === 'number' ? speed : 1,
      trackName: typeof songName === 'string' ? songName : null,
      artistName: typeof artistName === 'string' ? artistName : null,
      trackLength: typeof trackLength === 'number' ? trackLength : 0,
      trackLoaded: songLoaded === true || songLoaded === 1,
      syncMode: typeof syncMode === 'string' ? syncMode : null,
      beatInfo,
    };
  }
}
