import { describe, expect, test } from 'bun:test';
import { frameMessage, MessageFramer } from '../../src/protocol/tcp-framing.js';

describe('TCP framing', () => {
  test('frameMessage wraps payload with 4-byte length prefix', () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03]);
    const framed = frameMessage(payload);
    expect(framed.length).toBe(7);
    // Length prefix: 3 in big-endian u32
    expect(framed[0]).toBe(0);
    expect(framed[1]).toBe(0);
    expect(framed[2]).toBe(0);
    expect(framed[3]).toBe(3);
    // Payload
    expect(framed[4]).toBe(0x01);
    expect(framed[5]).toBe(0x02);
    expect(framed[6]).toBe(0x03);
  });

  test('frameMessage empty payload', () => {
    const framed = frameMessage(new Uint8Array(0));
    expect(framed).toEqual(new Uint8Array([0, 0, 0, 0]));
  });
});

describe('MessageFramer', () => {
  test('emits complete message from single chunk', () => {
    const received: Uint8Array[] = [];
    const framer = new MessageFramer((payload) => received.push(payload));

    const framed = frameMessage(new Uint8Array([0xaa, 0xbb]));
    framer.ingest(framed);

    expect(received.length).toBe(1);
    expect(received[0]).toEqual(new Uint8Array([0xaa, 0xbb]));
  });

  test('accumulates fragmented chunks', () => {
    const received: Uint8Array[] = [];
    const framer = new MessageFramer((payload) => received.push(payload));

    const framed = frameMessage(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    // Split in the middle of the payload
    framer.ingest(framed.slice(0, 3));
    expect(received.length).toBe(0);
    framer.ingest(framed.slice(3));
    expect(received.length).toBe(1);
    expect(received[0]).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
  });

  test('extracts multiple messages from one chunk', () => {
    const received: Uint8Array[] = [];
    const framer = new MessageFramer((payload) => received.push(payload));

    const msg1 = frameMessage(new Uint8Array([0x0a]));
    const msg2 = frameMessage(new Uint8Array([0x0b, 0x0c]));

    const combined = new Uint8Array(msg1.length + msg2.length);
    combined.set(msg1);
    combined.set(msg2, msg1.length);

    framer.ingest(combined);
    expect(received.length).toBe(2);
    expect(received[0]).toEqual(new Uint8Array([0x0a]));
    expect(received[1]).toEqual(new Uint8Array([0x0b, 0x0c]));
  });

  test('handles partial header', () => {
    const received: Uint8Array[] = [];
    const framer = new MessageFramer((payload) => received.push(payload));

    // Send just 2 bytes of the 4-byte length header
    framer.ingest(new Uint8Array([0x00, 0x00]));
    expect(received.length).toBe(0);
    // Send rest of header + payload
    framer.ingest(new Uint8Array([0x00, 0x01, 0xff]));
    expect(received.length).toBe(1);
    expect(received[0]).toEqual(new Uint8Array([0xff]));
  });

  test('reset discards partial data', () => {
    const received: Uint8Array[] = [];
    const framer = new MessageFramer((payload) => received.push(payload));

    framer.ingest(new Uint8Array([0x00, 0x00]));
    framer.reset();

    // Now send a complete message ��� should not include stale data
    const framed = frameMessage(new Uint8Array([0xdd]));
    framer.ingest(framed);
    expect(received.length).toBe(1);
    expect(received[0]).toEqual(new Uint8Array([0xdd]));
  });
});
