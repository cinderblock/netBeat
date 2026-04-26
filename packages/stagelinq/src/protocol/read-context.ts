/**
 * Sequential big-endian binary reader over a `Uint8Array`.
 *
 * StageLinQ is entirely big-endian (network byte order). ReadContext tracks a
 * cursor position and advances it after each read. Call `remaining()` to check
 * how many bytes are left, or `hasBytes(n)` before a read that might overrun.
 */
export class ReadContext {
  private readonly view: DataView;
  private pos: number;

  constructor(
    private readonly buf: Uint8Array,
    offset = 0,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = offset;
  }

  /** Current cursor position (bytes from start of buffer). */
  get position(): number {
    return this.pos;
  }

  /** Number of unread bytes remaining. */
  remaining(): number {
    return this.buf.byteLength - this.pos;
  }

  /** Returns `true` if at least `n` bytes remain to be read. */
  hasBytes(n: number): boolean {
    return this.remaining() >= n;
  }

  /** Read a single unsigned byte and advance. */
  readUInt8(): number {
    this.ensure(1);
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  /** Read a big-endian unsigned 16-bit integer and advance. */
  readUInt16(): number {
    this.ensure(2);
    const v = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return v;
  }

  /** Read a big-endian signed 32-bit integer and advance. */
  readInt32(): number {
    this.ensure(4);
    const v = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return v;
  }

  /** Read a big-endian unsigned 32-bit integer and advance. */
  readUInt32(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }

  /** Read a big-endian unsigned 64-bit integer as `bigint` and advance. */
  readUInt64(): bigint {
    this.ensure(8);
    const v = this.view.getBigUint64(this.pos, false);
    this.pos += 8;
    return v;
  }

  /** Read a big-endian IEEE 754 double (64-bit float) and advance. */
  readFloat64(): number {
    this.ensure(8);
    const v = this.view.getFloat64(this.pos, false);
    this.pos += 8;
    return v;
  }

  /** Read `length` raw bytes as a new `Uint8Array` and advance. */
  readBytes(length: number): Uint8Array {
    this.ensure(length);
    const slice = this.buf.slice(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }

  /**
   * Read a fixed-length ASCII string and advance. Trailing null bytes are
   * stripped.
   */
  readFixedString(length: number): string {
    const bytes = this.readBytes(length);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder('ascii').decode(bytes.subarray(0, end));
  }

  /**
   * Read a StageLinQ network string: `[u32 byteLength][UTF-16BE data]`.
   *
   * The length prefix counts bytes, not characters. Each character is 2 bytes
   * in UTF-16BE.
   */
  readNetworkString(): string {
    const byteLength = this.readUInt32();
    if (byteLength === 0) return '';
    this.ensure(byteLength);

    // Decode UTF-16BE manually — TextDecoder('utf-16be') is not universally
    // available. Each code unit is 2 bytes, big-endian.
    const charCount = byteLength >>> 1;
    const chars = new Array<string>(charCount);
    for (let i = 0; i < charCount; i++) {
      const hi = this.buf[this.pos + i * 2] ?? 0;
      const lo = this.buf[this.pos + i * 2 + 1] ?? 0;
      chars[i] = String.fromCharCode((hi << 8) | lo);
    }
    this.pos += byteLength;
    return chars.join('');
  }

  /** Skip `n` bytes without reading them. */
  skip(n: number): void {
    this.ensure(n);
    this.pos += n;
  }

  /** Seek to an absolute position. */
  seek(offset: number): void {
    if (offset < 0 || offset > this.buf.byteLength) {
      throw new RangeError(`Seek to ${offset} out of bounds [0, ${this.buf.byteLength}]`);
    }
    this.pos = offset;
  }

  private ensure(n: number): void {
    if (this.pos + n > this.buf.byteLength) {
      throw new RangeError(
        `ReadContext overrun: need ${n} bytes at offset ${this.pos}, ` +
          `but buffer is only ${this.buf.byteLength} bytes`,
      );
    }
  }
}
