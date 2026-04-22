/**
 * Every Pro DJ Link UDP packet begins with this 10-byte magic signature.
 *
 * Sources: `prolink-connect/src/constants.ts::PROLINK_HEADER` and
 * `dysentery/src/dysentery/view.clj::status-header`. Together with the
 * destination port and the packet-kind byte at offset `0x0a`, this magic is
 * what distinguishes Pro DJ Link traffic from other UDP noise on the
 * network.
 */
// Not `Object.freeze`d — typed arrays reject `Object.freeze` in some runtimes
// (V8/JSC throw "Attempting to store non-configurable property on a typed
// array"). Treat this as immutable by convention; the `Readonly` type above
// enforces that at the TypeScript layer.
export const PROLINK_HEADER: Readonly<Uint8Array> = new Uint8Array([
  0x51, 0x73, 0x70, 0x74, 0x31, 0x57, 0x6d, 0x4a, 0x4f, 0x4c,
]);

/** Byte offset at which the packet-kind discriminator lives. */
export const KIND_OFFSET = 0x0a;

/** Minimum length for a packet to plausibly be Pro DJ Link (10-byte magic + kind byte). */
export const MIN_PACKET_LENGTH = KIND_OFFSET + 1;

/**
 * Returns true if `buf` begins with the Pro DJ Link magic and is long enough
 * to carry at least the kind byte. Callers should still validate length and
 * kind-specific structure after this check passes.
 */
export function hasProlinkHeader(buf: Uint8Array): boolean {
  if (buf.length < MIN_PACKET_LENGTH) return false;
  for (let i = 0; i < PROLINK_HEADER.length; i++) {
    if (buf[i] !== PROLINK_HEADER[i]) return false;
  }
  return true;
}

/**
 * Reads the packet-kind discriminator byte, or returns `null` if the buffer
 * is too short or doesn't carry the Pro DJ Link magic.
 */
export function readKind(buf: Uint8Array): number | null {
  if (!hasProlinkHeader(buf)) return null;
  return buf[KIND_OFFSET] ?? null;
}
