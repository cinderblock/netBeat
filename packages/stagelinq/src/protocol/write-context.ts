/**
 * Sequential big-endian binary writer that grows as needed.
 *
 * StageLinQ is entirely big-endian. WriteContext maintains an internal buffer
 * that doubles in capacity when full, and exposes `finish()` to extract the
 * exact-length result.
 */
export class WriteContext {
  private buf: Uint8Array;
  private view: DataView;
  private pos: number;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.pos = 0;
  }

  /** Number of bytes written so far. */
  get length(): number {
    return this.pos;
  }

  /** Write a single unsigned byte. */
  writeUInt8(value: number): void {
    this.grow(1);
    this.view.setUint8(this.pos, value);
    this.pos += 1;
  }

  /** Write a big-endian unsigned 16-bit integer. */
  writeUInt16(value: number): void {
    this.grow(2);
    this.view.setUint16(this.pos, value, false);
    this.pos += 2;
  }

  /** Write a big-endian signed 32-bit integer. */
  writeInt32(value: number): void {
    this.grow(4);
    this.view.setInt32(this.pos, value, false);
    this.pos += 4;
  }

  /** Write a big-endian unsigned 32-bit integer. */
  writeUInt32(value: number): void {
    this.grow(4);
    this.view.setUint32(this.pos, value, false);
    this.pos += 4;
  }

  /** Write a big-endian unsigned 64-bit integer from `bigint`. */
  writeUInt64(value: bigint): void {
    this.grow(8);
    this.view.setBigUint64(this.pos, value, false);
    this.pos += 8;
  }

  /** Write a big-endian IEEE 754 double (64-bit float). */
  writeFloat64(value: number): void {
    this.grow(8);
    this.view.setFloat64(this.pos, value, false);
    this.pos += 8;
  }

  /** Write raw bytes. */
  writeBytes(data: Uint8Array): void {
    this.grow(data.length);
    this.buf.set(data, this.pos);
    this.pos += data.length;
  }

  /** Write a fixed-length ASCII string, null-padded to `length` bytes. */
  writeFixedString(value: string, length: number): void {
    this.grow(length);
    for (let i = 0; i < length; i++) {
      this.buf[this.pos + i] = i < value.length ? value.charCodeAt(i) & 0xff : 0;
    }
    this.pos += length;
  }

  /**
   * Write a StageLinQ network string: `[u32 byteLength][UTF-16BE data]`.
   *
   * The length prefix counts bytes (2 per character for BMP characters).
   */
  writeNetworkString(value: string): void {
    const byteLength = value.length * 2;
    this.writeUInt32(byteLength);
    this.grow(byteLength);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      this.buf[this.pos + i * 2] = (code >>> 8) & 0xff;
      this.buf[this.pos + i * 2 + 1] = code & 0xff;
    }
    this.pos += byteLength;
  }

  /**
   * Return the written bytes as a new `Uint8Array` (exact length, no slack).
   * The writer can continue to be used after calling this.
   */
  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  /** Ensure at least `needed` bytes of free space remain. */
  private grow(needed: number): void {
    const required = this.pos + needed;
    if (required <= this.buf.byteLength) return;

    let newCap = this.buf.byteLength;
    while (newCap < required) newCap *= 2;

    const next = new Uint8Array(newCap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer, next.byteOffset, next.byteLength);
  }
}
