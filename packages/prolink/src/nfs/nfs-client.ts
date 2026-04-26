/**
 * NFS v2 client for reading files from CDJ USB/SD exports.
 *
 * Implements the minimum NFS v2 subset needed to read rekordbox
 * analysis files (PDB + ANLZ) from a Pioneer CDJ over the network.
 *
 * **Protocol stack (all UDP):**
 * 1. Portmapper (port 111) → GETPORT for Mount and NFS programs
 * 2. Mount protocol → MNT("/C/") → root file handle (32 bytes)
 * 3. NFS v2 → LOOKUP chain → file handle
 * 4. NFS v2 → READ(fh, offset, count) → data
 *
 * **Export paths:** `/B/` = SD slot, `/C/` = USB slot.
 *
 * Sources: RFC 1094 (NFS v2), RFC 1057 (RPC/portmap),
 * prolink-connect/src/nfs/.
 */

import { createSocket, type Socket } from 'node:dgram';
import {
  buildRpcCall,
  parseRpcReply,
  readU32BE,
  writeU32BE,
  xdrDecodeOpaque,
  xdrEncodeString,
} from './rpc.js';

// ---- Program numbers ----

const PORTMAPPER_PROG = 100000;
const PORTMAPPER_VERS = 2;
const PORTMAPPER_PORT = 111;

const MOUNT_PROG = 100005;
const MOUNT_VERS = 1;

const NFS_PROG = 100003;
const NFS_VERS = 2;

// ---- Procedure numbers ----

const PORTMAP_GETPORT = 3;
const MOUNT_MNT = 1;
const NFS_LOOKUP = 4;
const NFS_READ = 6;

// ---- NFS v2 constants ----

/** NFS v2 file handle size. */
const FHSIZE = 32;

/** Maximum read size per NFS READ call (CDJs typically support 8KB). */
const NFS_READ_SIZE = 8192;

/** NFS status: OK. */
const NFS_OK = 0;

// ---- UDP RPC transport ----

interface PendingRequest {
  resolve: (buf: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Low-level UDP RPC transport. Sends RPC calls and matches replies
 * by XID.
 */
class UdpRpcTransport {
  private socket: Socket;
  private pending = new Map<number, PendingRequest>();
  private closed = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 5000,
  ) {
    this.socket = createSocket('udp4');
    this.socket.on('message', (msg: Buffer) => {
      const xid = readU32BE(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength), 0);
      const req = this.pending.get(xid);
      if (req) {
        this.pending.delete(xid);
        clearTimeout(req.timer);
        req.resolve(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
      }
    });
  }

  /**
   * Send an RPC call and wait for the matching reply.
   */
  call(
    program: number,
    version: number,
    procedure: number,
    payload: Uint8Array = new Uint8Array(0),
  ): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error('Transport closed'));

    const { message, xid } = buildRpcCall(program, version, procedure, payload);

    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(xid);
        reject(new Error(`RPC timeout (xid=${xid}, proc=${procedure})`));
      }, this.timeoutMs);

      this.pending.set(xid, { resolve, reject, timer });

      this.socket.send(
        Buffer.from(message.buffer, message.byteOffset, message.byteLength),
        this.port,
        this.host,
        (err) => {
          if (err) {
            this.pending.delete(xid);
            clearTimeout(timer);
            reject(err);
          }
        },
      );
    });
  }

  close(): void {
    this.closed = true;
    for (const [xid, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('Transport closed'));
      this.pending.delete(xid);
    }
    this.socket.close();
  }
}

// ---- Portmapper ----

/**
 * Query portmapper for a program's port number.
 */
async function getPort(
  host: string,
  program: number,
  version: number,
  protocol: number = 17, // UDP
): Promise<number> {
  const transport = new UdpRpcTransport(host, PORTMAPPER_PORT);
  try {
    // GETPORT args: program(u32), version(u32), protocol(u32), port(u32)
    const payload = new Uint8Array(16);
    writeU32BE(payload, 0, program);
    writeU32BE(payload, 4, version);
    writeU32BE(payload, 8, protocol);
    writeU32BE(payload, 12, 0); // port = 0 (server fills in)

    const raw = await transport.call(PORTMAPPER_PROG, PORTMAPPER_VERS, PORTMAP_GETPORT, payload);
    const reply = parseRpcReply(raw);
    if (!reply?.accepted || reply.body.length < 4) {
      throw new Error('Portmapper GETPORT failed');
    }
    return readU32BE(reply.body, 0);
  } finally {
    transport.close();
  }
}

// ---- NFS client ----

export class NfsClient {
  private nfsTransport: UdpRpcTransport | null = null;
  private rootHandle: Uint8Array | null = null;
  private host: string;
  private exportPath: string;

  constructor(host: string, exportPath = '/C/') {
    this.host = host;
    this.exportPath = exportPath;
  }

  /**
   * Connect: resolve ports via portmapper, mount the export.
   */
  async connect(): Promise<void> {
    // 1. Get mount port.
    const mountPort = await getPort(this.host, MOUNT_PROG, MOUNT_VERS);

    // 2. Get NFS port.
    const nfsPort = await getPort(this.host, NFS_PROG, NFS_VERS);

    // 3. Mount the export path → root file handle.
    const mountTransport = new UdpRpcTransport(this.host, mountPort);
    try {
      const mountPayload = xdrEncodeString(this.exportPath);
      const raw = await mountTransport.call(MOUNT_PROG, MOUNT_VERS, MOUNT_MNT, mountPayload);
      const reply = parseRpcReply(raw);
      if (!reply?.accepted || reply.body.length < 4) {
        throw new Error('Mount MNT failed');
      }
      const status = readU32BE(reply.body, 0);
      if (status !== 0) {
        throw new Error(`Mount MNT error: status ${status}`);
      }
      // File handle follows the status word (32 bytes, opaque).
      if (reply.body.length < 4 + FHSIZE) {
        throw new Error('Mount MNT: truncated file handle');
      }
      this.rootHandle = reply.body.subarray(4, 4 + FHSIZE);
    } finally {
      mountTransport.close();
    }

    // 4. Open NFS transport.
    this.nfsTransport = new UdpRpcTransport(this.host, nfsPort);
  }

  /**
   * Look up a file by path, returning its NFS file handle.
   * Walks each path component with NFS LOOKUP.
   */
  async lookup(path: string): Promise<Uint8Array> {
    if (!this.nfsTransport || !this.rootHandle) {
      throw new Error('Not connected');
    }

    const components = path.split('/').filter((c) => c.length > 0);
    let currentFh = this.rootHandle;

    for (const name of components) {
      // LOOKUP args: dir_fh(32 bytes) + filename(XDR string)
      const nameXdr = xdrEncodeString(name);
      const payload = new Uint8Array(FHSIZE + nameXdr.length);
      payload.set(currentFh, 0);
      payload.set(nameXdr, FHSIZE);

      const raw = await this.nfsTransport.call(NFS_PROG, NFS_VERS, NFS_LOOKUP, payload);
      const reply = parseRpcReply(raw);
      if (!reply?.accepted || reply.body.length < 4) {
        throw new Error(`NFS LOOKUP failed for "${name}"`);
      }
      const status = readU32BE(reply.body, 0);
      if (status !== NFS_OK) {
        throw new Error(`NFS LOOKUP error for "${name}": status ${status}`);
      }
      if (reply.body.length < 4 + FHSIZE) {
        throw new Error(`NFS LOOKUP truncated for "${name}"`);
      }
      currentFh = reply.body.subarray(4, 4 + FHSIZE);
    }

    return currentFh;
  }

  /**
   * Read a file by path. Reassembles multi-chunk reads.
   */
  async readFile(path: string): Promise<Uint8Array> {
    const fh = await this.lookup(path);
    return this.readFileHandle(fh);
  }

  /**
   * Read a file by its NFS file handle. Reassembles from multiple
   * READ calls if the file exceeds NFS_READ_SIZE.
   */
  async readFileHandle(fh: Uint8Array): Promise<Uint8Array> {
    if (!this.nfsTransport) throw new Error('Not connected');

    const chunks: Uint8Array[] = [];
    let offset = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // READ args: fh(32) + offset(u32) + count(u32) + totalcount(u32)
      const payload = new Uint8Array(FHSIZE + 12);
      payload.set(fh, 0);
      writeU32BE(payload, FHSIZE, offset);
      writeU32BE(payload, FHSIZE + 4, NFS_READ_SIZE);
      writeU32BE(payload, FHSIZE + 8, 0); // totalcount (unused)

      const raw = await this.nfsTransport.call(NFS_PROG, NFS_VERS, NFS_READ, payload);
      const reply = parseRpcReply(raw);
      if (!reply?.accepted || reply.body.length < 4) {
        throw new Error(`NFS READ failed at offset ${offset}`);
      }
      const status = readU32BE(reply.body, 0);
      if (status !== NFS_OK) {
        throw new Error(`NFS READ error at offset ${offset}: status ${status}`);
      }

      // After status: fattr (68 bytes for NFS v2), then data (XDR opaque).
      const FATTR_SIZE = 68;
      const dataResult = xdrDecodeOpaque(reply.body, 4 + FATTR_SIZE);
      if (!dataResult || dataResult.data.length === 0) break;

      chunks.push(new Uint8Array(dataResult.data));
      offset += dataResult.data.length;

      // If we got less than requested, we've hit EOF.
      if (dataResult.data.length < NFS_READ_SIZE) break;
    }

    // Concatenate chunks.
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const result = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of chunks) {
      result.set(c, pos);
      pos += c.length;
    }
    return result;
  }

  close(): void {
    this.nfsTransport?.close();
    this.nfsTransport = null;
    this.rootHandle = null;
  }
}
