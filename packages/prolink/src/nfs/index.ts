/**
 * NFS media reader — implements MediaReader for reading files from
 * a CDJ's USB/SD export over the network via NFS.
 *
 * @example
 * ```ts
 * const reader = new NfsMediaReader('192.168.1.100');
 * await reader.connect();
 * const data = await reader.readFile('/PIONEER/rekordbox/export.pdb');
 * await reader.close();
 * ```
 */

import type { MediaReader } from '../metadata/media-reader.js';
import { NfsClient } from './nfs-client.js';

export { NfsClient } from './nfs-client.js';
export type { RpcReply } from './rpc.js';
export {
  buildRpcCall,
  parseRpcReply,
  RPC_HEADER_SIZE,
  RPC_REPLY_HEADER_SIZE,
  readU32BE,
  writeU32BE,
  xdrDecodeOpaque,
  xdrDecodeString,
  xdrEncodeOpaque,
  xdrEncodeString,
} from './rpc.js';

/**
 * NFS-based MediaReader for reading files from CDJ USB exports.
 *
 * Connects to a CDJ at the given IP address and mounts its USB export
 * via NFS (default export path `/C/` for USB, `/B/` for SD).
 */
export class NfsMediaReader implements MediaReader {
  private client: NfsClient;
  private connected = false;

  constructor(host: string, exportPath = '/C/') {
    this.client = new NfsClient(host, exportPath);
  }

  /** Connect to the CDJ (portmapper → mount → NFS). */
  async connect(): Promise<void> {
    await this.client.connect();
    this.connected = true;
  }

  async readFile(path: string): Promise<Uint8Array> {
    if (!this.connected) {
      await this.connect();
    }
    return this.client.readFile(path);
  }

  async close(): Promise<void> {
    this.client.close();
    this.connected = false;
  }
}
