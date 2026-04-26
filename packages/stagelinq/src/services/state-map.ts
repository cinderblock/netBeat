/**
 * StateMap service — real-time deck state subscriptions.
 *
 * StateMap uses the `"smaa"` magic and exposes a subscribe/update model:
 *
 *   **Subscribe (type 0x7d2):**
 *     [4B "smaa"][4B type: 0x7d2][NetworkString statePath][4B interval (i32)]
 *
 *   **State update (type 0x0):**
 *     [4B "smaa"][4B type: 0x0][NetworkString statePath][NetworkString jsonValue]
 *
 * The interval in subscribe requests controls how often the device sends
 * updates for that path. An interval of 0 means "send on every change".
 *
 * State values are JSON-encoded strings (numbers, booleans, strings, objects).
 */

import { ReadContext } from '../protocol/read-context.js';
import { SERVICE_MAGIC } from '../protocol/services.js';
import { WriteContext } from '../protocol/write-context.js';

/** StateMap message type IDs. */
export const STATE_MAP_MSG = {
  /** State value update from device. */
  STATE_UPDATE: 0x00000000,
  /** Subscription request / interval change. */
  SUBSCRIBE: 0x000007d2,
} as const;

/** Parsed state update from a device. */
export interface StateUpdate {
  /** The state path that changed (e.g. "/Engine/Deck1/Play"). */
  readonly path: string;
  /** The new value as a JSON string. */
  readonly jsonValue: string;
}

/** Parse a state value to its native JS type. */
export function parseStateValue(jsonValue: string): unknown {
  try {
    return JSON.parse(jsonValue) as unknown;
  } catch {
    return jsonValue;
  }
}

const MAGIC_LENGTH = 4;

/**
 * Check if a payload starts with the StateMap magic `"smaa"`.
 */
export function hasStateMapMagic(payload: Uint8Array): boolean {
  if (payload.length < MAGIC_LENGTH) return false;
  for (let i = 0; i < MAGIC_LENGTH; i++) {
    if (payload[i] !== SERVICE_MAGIC.STATE_MAP[i]) return false;
  }
  return true;
}

/**
 * Parse a StateMap message payload (after length-prefix framing has been
 * stripped). Returns the state update, or `null` if malformed or not an
 * update message.
 */
export function parseStateMapMessage(payload: Uint8Array): StateUpdate | null {
  if (!hasStateMapMagic(payload)) return null;

  try {
    const ctx = new ReadContext(payload, MAGIC_LENGTH);
    const type = ctx.readUInt32();

    if (type !== STATE_MAP_MSG.STATE_UPDATE) return null;

    const path = ctx.readNetworkString();
    const jsonValue = ctx.readNetworkString();

    return { path, jsonValue };
  } catch {
    return null;
  }
}

/**
 * Build a StateMap subscribe request for a single state path.
 *
 * @param path - State path to subscribe to (e.g. "/Engine/Deck1/Play")
 * @param interval - Update interval; 0 = on every change
 */
export function buildStateMapSubscribe(path: string, interval = 0): Uint8Array {
  const ctx = new WriteContext();
  ctx.writeBytes(SERVICE_MAGIC.STATE_MAP);
  ctx.writeUInt32(STATE_MAP_MSG.SUBSCRIBE);
  ctx.writeNetworkString(path);
  ctx.writeInt32(interval);
  return ctx.finish();
}

/**
 * Build subscribe requests for multiple state paths. Returns an array of
 * payloads (each needs to be individually length-framed before sending).
 */
export function buildStateMapSubscriptions(paths: readonly string[], interval = 0): Uint8Array[] {
  return paths.map((path) => buildStateMapSubscribe(path, interval));
}
