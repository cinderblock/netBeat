import { describe, expect, test } from 'bun:test';
import { ReadContext } from '../../src/protocol/read-context.js';

describe('ReadContext', () => {
  test('readUInt8', () => {
    const ctx = new ReadContext(new Uint8Array([0xff, 0x00, 0x42]));
    expect(ctx.readUInt8()).toBe(0xff);
    expect(ctx.readUInt8()).toBe(0x00);
    expect(ctx.readUInt8()).toBe(0x42);
    expect(ctx.remaining()).toBe(0);
  });

  test('readUInt16 big-endian', () => {
    const ctx = new ReadContext(new Uint8Array([0x01, 0x02, 0xff, 0xfe]));
    expect(ctx.readUInt16()).toBe(0x0102);
    expect(ctx.readUInt16()).toBe(0xfffe);
  });

  test('readInt32 big-endian signed', () => {
    // -1 in big-endian i32
    const ctx = new ReadContext(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    expect(ctx.readInt32()).toBe(-1);
  });

  test('readUInt32 big-endian', () => {
    const ctx = new ReadContext(new Uint8Array([0x00, 0x01, 0x00, 0x00]));
    expect(ctx.readUInt32()).toBe(65536);
  });

  test('readUInt64 big-endian', () => {
    const ctx = new ReadContext(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00]));
    expect(ctx.readUInt64()).toBe(256n);
  });

  test('readFloat64 big-endian', () => {
    // 120.5 as IEEE 754 double, big-endian
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, 120.5, false);
    const ctx = new ReadContext(new Uint8Array(buf));
    expect(ctx.readFloat64()).toBe(120.5);
  });

  test('readBytes returns a copy', () => {
    const original = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const ctx = new ReadContext(original);
    const slice = ctx.readBytes(2);
    expect(slice).toEqual(new Uint8Array([0x01, 0x02]));
    // Mutating the copy should not affect the original
    slice[0] = 0xff;
    expect(original[0]).toBe(0x01);
    expect(ctx.remaining()).toBe(2);
  });

  test('readFixedString strips trailing nulls', () => {
    // "Hi" + 3 null bytes
    const ctx = new ReadContext(new Uint8Array([0x48, 0x69, 0x00, 0x00, 0x00]));
    expect(ctx.readFixedString(5)).toBe('Hi');
  });

  test('readNetworkString decodes UTF-16BE', () => {
    // "Hi" in UTF-16BE: length=4, H=0x0048, i=0x0069
    const ctx = new ReadContext(new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x00, 0x48, 0x00, 0x69]));
    expect(ctx.readNetworkString()).toBe('Hi');
  });

  test('readNetworkString empty string', () => {
    const ctx = new ReadContext(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
    expect(ctx.readNetworkString()).toBe('');
  });

  test('position tracking and hasBytes', () => {
    const ctx = new ReadContext(new Uint8Array(10));
    expect(ctx.position).toBe(0);
    expect(ctx.remaining()).toBe(10);
    expect(ctx.hasBytes(10)).toBe(true);
    expect(ctx.hasBytes(11)).toBe(false);
    ctx.skip(4);
    expect(ctx.position).toBe(4);
    expect(ctx.remaining()).toBe(6);
  });

  test('seek to absolute position', () => {
    const ctx = new ReadContext(new Uint8Array([0x0a, 0x0b, 0x0c, 0x0d]));
    ctx.seek(2);
    expect(ctx.readUInt8()).toBe(0x0c);
  });

  test('throws on overrun', () => {
    const ctx = new ReadContext(new Uint8Array(2));
    expect(() => ctx.readUInt32()).toThrow('overrun');
  });

  test('constructor with offset', () => {
    const ctx = new ReadContext(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]), 2);
    expect(ctx.readUInt8()).toBe(0xcc);
    expect(ctx.remaining()).toBe(1);
  });
});
