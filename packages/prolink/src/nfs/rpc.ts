/**
 * Sun RPC (ONC RPC) message framing — XDR encoding/decoding.
 *
 * Used by Portmapper, Mount, and NFS protocols. All CDJ NFS
 * communication is UDP-based (no TCP record marking needed).
 *
 * **RPC call message layout (XDR, all u32 BE):**
 *
 * | Field          | Value                                       |
 * |:---------------|:--------------------------------------------|
 * | xid            | transaction ID (echo'd in reply)            |
 * | msg_type       | 0 = CALL                                    |
 * | rpc_version    | 2                                           |
 * | program        | e.g. 100003 (NFS), 100005 (MOUNT)           |
 * | prog_version   | e.g. 2 (NFS v2)                             |
 * | procedure      | procedure number                            |
 * | auth_flavor    | 0 = AUTH_NULL                                |
 * | auth_length    | 0                                           |
 * | verf_flavor    | 0 = AUTH_NULL                                |
 * | verf_length    | 0                                           |
 * | ...            | procedure-specific payload                  |
 *
 * **RPC reply message layout:**
 *
 * | Field          | Value                                       |
 * |:---------------|:--------------------------------------------|
 * | xid            | echoed from call                            |
 * | msg_type       | 1 = REPLY                                   |
 * | reply_stat     | 0 = MSG_ACCEPTED                            |
 * | verf_flavor    | 0                                           |
 * | verf_length    | 0                                           |
 * | accept_stat    | 0 = SUCCESS                                 |
 * | ...            | procedure-specific results                  |
 *
 * Sources: RFC 5531 (RPC v2), RFC 4506 (XDR).
 */

// ---- Constants ----

const RPC_VERSION = 2;
const MSG_TYPE_CALL = 0;
const MSG_TYPE_REPLY = 1;
const AUTH_NULL = 0;

/** RPC call header size (10 × u32 = 40 bytes). */
export const RPC_HEADER_SIZE = 40;

/** RPC reply header size (xid + msg_type + reply_stat + verf + accept_stat = 6 × u32 = 24 bytes). */
export const RPC_REPLY_HEADER_SIZE = 24;

// ---- XDR helpers ----

export function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

export function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    (((buf[offset] ?? 0) << 24) |
      ((buf[offset + 1] ?? 0) << 16) |
      ((buf[offset + 2] ?? 0) << 8) |
      (buf[offset + 3] ?? 0)) >>>
    0
  );
}

/**
 * Encode an XDR opaque (variable-length bytes). Layout:
 * u32 length, then data, then 0–3 padding bytes to align to 4.
 */
export function xdrEncodeOpaque(data: Uint8Array): Uint8Array {
  const padLen = (4 - (data.length % 4)) % 4;
  const buf = new Uint8Array(4 + data.length + padLen);
  writeU32BE(buf, 0, data.length);
  buf.set(data, 4);
  return buf;
}

/**
 * Decode an XDR opaque at the given offset. Returns the data and the
 * next offset after the padded opaque.
 */
export function xdrDecodeOpaque(
  buf: Uint8Array,
  offset: number,
): { data: Uint8Array; nextOffset: number } | null {
  if (offset + 4 > buf.length) return null;
  const len = readU32BE(buf, offset);
  const dataStart = offset + 4;
  if (dataStart + len > buf.length) return null;
  const data = buf.subarray(dataStart, dataStart + len);
  const padLen = (4 - (len % 4)) % 4;
  return { data, nextOffset: dataStart + len + padLen };
}

/**
 * Encode an XDR string (same as opaque but ASCII content).
 */
export function xdrEncodeString(str: string): Uint8Array {
  const encoded = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    encoded[i] = str.charCodeAt(i);
  }
  return xdrEncodeOpaque(encoded);
}

/**
 * Decode an XDR string at the given offset.
 */
export function xdrDecodeString(
  buf: Uint8Array,
  offset: number,
): { value: string; nextOffset: number } | null {
  const result = xdrDecodeOpaque(buf, offset);
  if (!result) return null;
  let str = '';
  for (const byte of result.data) {
    if (byte === 0) break;
    str += String.fromCharCode(byte);
  }
  return { value: str, nextOffset: result.nextOffset };
}

// ---- XID generation ----

let xidCounter = (Math.random() * 0x7fffffff) >>> 0;

/** Generate a unique transaction ID. */
export function nextXid(): number {
  xidCounter = (xidCounter + 1) >>> 0;
  return xidCounter;
}

// ---- RPC call building ----

/**
 * Build an RPC CALL message.
 *
 * @param program — RPC program number
 * @param version — program version
 * @param procedure — procedure number
 * @param payload — procedure-specific XDR-encoded payload
 * @returns the complete RPC message and its XID
 */
export function buildRpcCall(
  program: number,
  version: number,
  procedure: number,
  payload: Uint8Array = new Uint8Array(0),
): { message: Uint8Array; xid: number } {
  const xid = nextXid();
  const buf = new Uint8Array(RPC_HEADER_SIZE + payload.length);

  writeU32BE(buf, 0, xid);
  writeU32BE(buf, 4, MSG_TYPE_CALL);
  writeU32BE(buf, 8, RPC_VERSION);
  writeU32BE(buf, 12, program);
  writeU32BE(buf, 16, version);
  writeU32BE(buf, 20, procedure);
  // Auth: AUTH_NULL (flavor=0, length=0).
  writeU32BE(buf, 24, AUTH_NULL);
  writeU32BE(buf, 28, 0);
  // Verifier: AUTH_NULL.
  writeU32BE(buf, 32, AUTH_NULL);
  writeU32BE(buf, 36, 0);

  if (payload.length > 0) {
    buf.set(payload, RPC_HEADER_SIZE);
  }

  return { message: buf, xid };
}

// ---- RPC reply parsing ----

export interface RpcReply {
  xid: number;
  accepted: boolean;
  /** Payload body (after the reply header), only if accepted. */
  body: Uint8Array;
}

/**
 * Parse an RPC reply message.
 * Returns null if the message is too short or not a reply.
 */
export function parseRpcReply(buf: Uint8Array): RpcReply | null {
  if (buf.length < RPC_REPLY_HEADER_SIZE) return null;

  const xid = readU32BE(buf, 0);
  const msgType = readU32BE(buf, 4);
  if (msgType !== MSG_TYPE_REPLY) return null;

  const replyStat = readU32BE(buf, 8);
  if (replyStat !== 0) {
    // MSG_DENIED
    return { xid, accepted: false, body: new Uint8Array(0) };
  }

  // Accepted reply: verf_flavor(4) + verf_length(4) + accept_stat(4)
  const acceptStat = readU32BE(buf, 20);
  if (acceptStat !== 0) {
    return { xid, accepted: false, body: new Uint8Array(0) };
  }

  return {
    xid,
    accepted: true,
    body: buf.subarray(RPC_REPLY_HEADER_SIZE),
  };
}
