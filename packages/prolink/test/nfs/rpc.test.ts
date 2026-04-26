import { describe, expect, test } from 'bun:test';
import {
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
} from '../../src/nfs/rpc.ts';

describe('XDR helpers', () => {
  test('writeU32BE / readU32BE round-trip', () => {
    const buf = new Uint8Array(4);
    writeU32BE(buf, 0, 0xdeadbeef);
    expect(readU32BE(buf, 0)).toBe(0xdeadbeef);
  });

  test('readU32BE handles zero', () => {
    const buf = new Uint8Array(4);
    expect(readU32BE(buf, 0)).toBe(0);
  });

  test('readU32BE handles max', () => {
    const buf = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    expect(readU32BE(buf, 0)).toBe(0xffffffff);
  });
});

describe('xdrEncodeOpaque / xdrDecodeOpaque', () => {
  test('round-trip: empty data', () => {
    const encoded = xdrEncodeOpaque(new Uint8Array(0));
    expect(encoded.length).toBe(4); // Just the length field.
    const decoded = xdrDecodeOpaque(encoded, 0);
    expect(decoded).not.toBeNull();
    expect(decoded?.data.length).toBe(0);
    expect(decoded?.nextOffset).toBe(4);
  });

  test('round-trip: 4-byte aligned data', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const encoded = xdrEncodeOpaque(data);
    expect(encoded.length).toBe(8); // 4 (len) + 4 (data)
    const decoded = xdrDecodeOpaque(encoded, 0);
    expect(decoded?.data).toEqual(data);
    expect(decoded?.nextOffset).toBe(8);
  });

  test('round-trip: non-aligned data (padding added)', () => {
    const data = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const encoded = xdrEncodeOpaque(data);
    // 4 (len) + 3 (data) + 1 (pad) = 8
    expect(encoded.length).toBe(8);
    const decoded = xdrDecodeOpaque(encoded, 0);
    expect(decoded?.data).toEqual(data);
    expect(decoded?.nextOffset).toBe(8);
  });

  test('round-trip: 1-byte data', () => {
    const data = new Uint8Array([0x42]);
    const encoded = xdrEncodeOpaque(data);
    expect(encoded.length).toBe(8); // 4 + 1 + 3 padding
    const decoded = xdrDecodeOpaque(encoded, 0);
    expect(decoded?.data).toEqual(data);
  });

  test('returns null for truncated buffer', () => {
    expect(xdrDecodeOpaque(new Uint8Array(2), 0)).toBeNull();
  });

  test('returns null when length exceeds buffer', () => {
    const buf = new Uint8Array(8);
    writeU32BE(buf, 0, 100); // Claims 100 bytes but only 4 available.
    expect(xdrDecodeOpaque(buf, 0)).toBeNull();
  });
});

describe('xdrEncodeString / xdrDecodeString', () => {
  test('round-trip: simple ASCII string', () => {
    const encoded = xdrEncodeString('hello');
    const decoded = xdrDecodeString(encoded, 0);
    expect(decoded?.value).toBe('hello');
  });

  test('round-trip: empty string', () => {
    const encoded = xdrEncodeString('');
    const decoded = xdrDecodeString(encoded, 0);
    expect(decoded?.value).toBe('');
  });

  test('round-trip: path string', () => {
    const encoded = xdrEncodeString('/C/');
    const decoded = xdrDecodeString(encoded, 0);
    expect(decoded?.value).toBe('/C/');
  });
});

describe('buildRpcCall', () => {
  test('produces correct header size', () => {
    const { message } = buildRpcCall(100003, 2, 6);
    expect(message.length).toBe(RPC_HEADER_SIZE);
  });

  test('includes payload after header', () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const { message } = buildRpcCall(100003, 2, 6, payload);
    expect(message.length).toBe(RPC_HEADER_SIZE + 4);
    expect(message[RPC_HEADER_SIZE]).toBe(0x01);
    expect(message[RPC_HEADER_SIZE + 3]).toBe(0x04);
  });

  test('sets msg_type to CALL (0)', () => {
    const { message } = buildRpcCall(100003, 2, 4);
    expect(readU32BE(message, 4)).toBe(0); // CALL
  });

  test('sets RPC version to 2', () => {
    const { message } = buildRpcCall(100003, 2, 4);
    expect(readU32BE(message, 8)).toBe(2);
  });

  test('sets program, version, procedure', () => {
    const { message } = buildRpcCall(100003, 2, 6);
    expect(readU32BE(message, 12)).toBe(100003); // program
    expect(readU32BE(message, 16)).toBe(2); // version
    expect(readU32BE(message, 20)).toBe(6); // procedure
  });

  test('uses AUTH_NULL credentials', () => {
    const { message } = buildRpcCall(100003, 2, 4);
    expect(readU32BE(message, 24)).toBe(0); // auth flavor = NULL
    expect(readU32BE(message, 28)).toBe(0); // auth length = 0
    expect(readU32BE(message, 32)).toBe(0); // verf flavor = NULL
    expect(readU32BE(message, 36)).toBe(0); // verf length = 0
  });

  test('generates unique XIDs', () => {
    const { xid: xid1 } = buildRpcCall(1, 1, 1);
    const { xid: xid2 } = buildRpcCall(1, 1, 1);
    expect(xid1).not.toBe(xid2);
  });
});

describe('parseRpcReply', () => {
  /** Build a minimal accepted reply. */
  function buildReply(xid: number, body: Uint8Array = new Uint8Array(0)): Uint8Array {
    const buf = new Uint8Array(RPC_REPLY_HEADER_SIZE + body.length);
    writeU32BE(buf, 0, xid);
    writeU32BE(buf, 4, 1); // REPLY
    writeU32BE(buf, 8, 0); // MSG_ACCEPTED
    writeU32BE(buf, 12, 0); // verf flavor
    writeU32BE(buf, 16, 0); // verf length
    writeU32BE(buf, 20, 0); // accept_stat = SUCCESS
    if (body.length > 0) buf.set(body, RPC_REPLY_HEADER_SIZE);
    return buf;
  }

  test('returns null for too-short buffer', () => {
    expect(parseRpcReply(new Uint8Array(8))).toBeNull();
  });

  test('returns null for non-reply message type', () => {
    const buf = new Uint8Array(RPC_REPLY_HEADER_SIZE);
    writeU32BE(buf, 4, 0); // CALL, not REPLY
    expect(parseRpcReply(buf)).toBeNull();
  });

  test('parses accepted reply with XID', () => {
    const reply = parseRpcReply(buildReply(0x12345678));
    expect(reply).not.toBeNull();
    expect(reply?.xid).toBe(0x12345678);
    expect(reply?.accepted).toBe(true);
  });

  test('accepted reply has body', () => {
    const body = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const reply = parseRpcReply(buildReply(1, body));
    expect(reply?.accepted).toBe(true);
    expect(reply?.body).toEqual(body);
  });

  test('denied reply (reply_stat != 0)', () => {
    const buf = new Uint8Array(RPC_REPLY_HEADER_SIZE);
    writeU32BE(buf, 0, 42);
    writeU32BE(buf, 4, 1); // REPLY
    writeU32BE(buf, 8, 1); // MSG_DENIED
    const reply = parseRpcReply(buf);
    expect(reply?.accepted).toBe(false);
  });

  test('rejected reply (accept_stat != 0)', () => {
    const buf = new Uint8Array(RPC_REPLY_HEADER_SIZE);
    writeU32BE(buf, 0, 42);
    writeU32BE(buf, 4, 1); // REPLY
    writeU32BE(buf, 8, 0); // MSG_ACCEPTED
    writeU32BE(buf, 12, 0); // verf flavor
    writeU32BE(buf, 16, 0); // verf length
    writeU32BE(buf, 20, 2); // accept_stat = PROG_UNAVAIL
    const reply = parseRpcReply(buf);
    expect(reply?.accepted).toBe(false);
  });

  test('round-trip: build call, parse matching reply', () => {
    const { xid } = buildRpcCall(100003, 2, 6);
    const replyBuf = buildReply(xid, new Uint8Array([0x00, 0x00, 0x00, 0x00]));
    const reply = parseRpcReply(replyBuf);
    expect(reply?.xid).toBe(xid);
    expect(reply?.accepted).toBe(true);
  });
});
