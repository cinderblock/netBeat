/**
 * Length-prefixed TCP message framing for StageLinQ services.
 *
 * Most StageLinQ services (StateMap, BeatInfo, FileTransfer, TimeSynchronization)
 * frame their TCP messages with a 4-byte big-endian length prefix:
 *
 *   [4B length (u32 BE)][N bytes payload]
 *
 * The length field indicates the total payload size that follows. TCP delivers
 * a byte stream, so we must accumulate fragments until a complete message is
 * received.
 *
 * The Broadcast and Directory services are exceptions — Directory uses its own
 * message-ID-based framing, and Broadcast uses unbuffered JSON messages.
 */

/** Minimum bytes needed to read a length prefix. */
export const FRAME_HEADER_SIZE = 4;

/**
 * Accumulator for length-prefixed TCP messages. Feed it chunks from
 * `socket.on('data')` and it will emit complete message payloads via the
 * callback.
 */
export class MessageFramer {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly handler: (payload: Uint8Array) => void;

  constructor(handler: (payload: Uint8Array) => void) {
    this.handler = handler;
  }

  /** Feed a chunk of TCP data. May emit zero or more complete messages. */
  ingest(chunk: Uint8Array): void {
    // Append chunk to buffer.
    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      const combined = new Uint8Array(this.buffer.length + chunk.length);
      combined.set(this.buffer);
      combined.set(chunk, this.buffer.length);
      this.buffer = combined;
    }

    // Extract complete messages.
    while (this.buffer.length >= FRAME_HEADER_SIZE) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const payloadLen = view.getUint32(0, false);

      const totalLen = FRAME_HEADER_SIZE + payloadLen;
      if (this.buffer.length < totalLen) {
        break; // Incomplete message — wait for more data.
      }

      // Extract payload and advance buffer.
      const payload = this.buffer.slice(FRAME_HEADER_SIZE, totalLen);
      this.buffer = this.buffer.slice(totalLen);

      this.handler(payload);
    }
  }

  /** Discard any buffered partial data. */
  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}

/**
 * Wrap a payload with a 4-byte big-endian length prefix for sending.
 */
export function frameMessage(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(0, payload.length, false);
  frame.set(payload, FRAME_HEADER_SIZE);
  return frame;
}
