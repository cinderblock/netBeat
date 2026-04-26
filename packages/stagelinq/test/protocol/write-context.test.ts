import { describe, expect, test } from 'bun:test';
import { ReadContext } from '../../src/protocol/read-context.js';
import { WriteContext } from '../../src/protocol/write-context.js';

describe('WriteContext', () => {
  test('writeUInt8', () => {
    const w = new WriteContext();
    w.writeUInt8(0xff);
    w.writeUInt8(0x00);
    expect(w.finish()).toEqual(new Uint8Array([0xff, 0x00]));
  });

  test('writeUInt16 big-endian', () => {
    const w = new WriteContext();
    w.writeUInt16(0x0102);
    expect(w.finish()).toEqual(new Uint8Array([0x01, 0x02]));
  });

  test('writeInt32 big-endian negative', () => {
    const w = new WriteContext();
    w.writeInt32(-1);
    expect(w.finish()).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  });

  test('writeUInt32 big-endian', () => {
    const w = new WriteContext();
    w.writeUInt32(65536);
    expect(w.finish()).toEqual(new Uint8Array([0x00, 0x01, 0x00, 0x00]));
  });

  test('writeUInt64 big-endian', () => {
    const w = new WriteContext();
    w.writeUInt64(256n);
    expect(w.finish()).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00]));
  });

  test('writeFloat64 big-endian', () => {
    const w = new WriteContext();
    w.writeFloat64(120.5);
    const result = w.finish();
    // Read it back
    const ctx = new ReadContext(result);
    expect(ctx.readFloat64()).toBe(120.5);
  });

  test('writeBytes', () => {
    const w = new WriteContext();
    w.writeBytes(new Uint8Array([0x0a, 0x0b, 0x0c]));
    expect(w.finish()).toEqual(new Uint8Array([0x0a, 0x0b, 0x0c]));
  });

  test('writeFixedString null-pads', () => {
    const w = new WriteContext();
    w.writeFixedString('Hi', 5);
    expect(w.finish()).toEqual(new Uint8Array([0x48, 0x69, 0x00, 0x00, 0x00]));
  });

  test('writeNetworkString encodes UTF-16BE', () => {
    const w = new WriteContext();
    w.writeNetworkString('Hi');
    expect(w.finish()).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x00, 0x48, 0x00, 0x69]));
  });

  test('writeNetworkString empty', () => {
    const w = new WriteContext();
    w.writeNetworkString('');
    expect(w.finish()).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
  });

  test('grows buffer automatically', () => {
    const w = new WriteContext(2); // Start with tiny capacity
    for (let i = 0; i < 100; i++) {
      w.writeUInt8(i & 0xff);
    }
    const result = w.finish();
    expect(result.length).toBe(100);
    expect(result[0]).toBe(0);
    expect(result[99]).toBe(99);
  });

  test('length tracks written bytes', () => {
    const w = new WriteContext();
    expect(w.length).toBe(0);
    w.writeUInt32(42);
    expect(w.length).toBe(4);
    w.writeNetworkString('A');
    expect(w.length).toBe(4 + 4 + 2); // u32 len + 1 char * 2 bytes
  });
});

describe('ReadContext + WriteContext round-trip', () => {
  test('network string round-trip', () => {
    const original = 'DISCOVERER_HOWDY_';
    const w = new WriteContext();
    w.writeNetworkString(original);
    const ctx = new ReadContext(w.finish());
    expect(ctx.readNetworkString()).toBe(original);
  });

  test('mixed types round-trip', () => {
    const w = new WriteContext();
    w.writeUInt8(0x42);
    w.writeUInt16(12345);
    w.writeUInt32(0xdeadbeef);
    w.writeUInt64(999999999999n);
    w.writeFloat64(Math.PI);
    w.writeNetworkString('Hello');

    const ctx = new ReadContext(w.finish());
    expect(ctx.readUInt8()).toBe(0x42);
    expect(ctx.readUInt16()).toBe(12345);
    expect(ctx.readUInt32()).toBe(0xdeadbeef);
    expect(ctx.readUInt64()).toBe(999999999999n);
    expect(ctx.readFloat64()).toBeCloseTo(Math.PI);
    expect(ctx.readNetworkString()).toBe('Hello');
    expect(ctx.remaining()).toBe(0);
  });
});
