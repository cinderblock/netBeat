/**
 * BeatInfo service — real-time beat synchronization data.
 *
 * BeatInfo provides per-deck beat position, BPM, and timing data. The message
 * format:
 *
 *   [4B messageId (u32)]
 *   [8B clock (u64, nanoseconds)]
 *   [4B deckCount (u32)]
 *   For each deck:
 *     [8B beat (f64)]
 *     [8B totalBeats (f64)]
 *     [8B BPM (f64)]
 *   For each deck:
 *     [8B samples (f64)]
 *
 * The subscription request is simply:
 *   [4B 0x00000004][4B 0x00000000]
 */

import { ReadContext } from '../protocol/read-context.js';
import { WriteContext } from '../protocol/write-context.js';

/** Per-deck beat data. */
export interface DeckBeatInfo {
  /** Current beat position within the track. */
  readonly beat: number;
  /** Total number of beats in the track. */
  readonly totalBeats: number;
  /** Current BPM. */
  readonly bpm: number;
  /** Sample count / playback position in samples. */
  readonly samples: number;
}

/** A complete beat info update from the device. */
export interface BeatInfoMessage {
  /** Message ID from the device. */
  readonly messageId: number;
  /** Device clock in nanoseconds. */
  readonly clock: bigint;
  /** Number of decks reporting. */
  readonly deckCount: number;
  /** Per-deck beat data, indexed 0..deckCount-1. */
  readonly decks: readonly DeckBeatInfo[];
}

/**
 * Parse a BeatInfo message payload (after length-prefix framing).
 * Returns `null` if the payload is malformed.
 */
export function parseBeatInfoMessage(payload: Uint8Array): BeatInfoMessage | null {
  try {
    const ctx = new ReadContext(payload);

    const messageId = ctx.readUInt32();
    const clock = ctx.readUInt64();
    const deckCount = ctx.readUInt32();

    // Sanity check — no device has more than 4 decks.
    if (deckCount > 8) return null;

    // Read beat/totalBeats/BPM for each deck.
    const beats: { beat: number; totalBeats: number; bpm: number }[] = [];
    for (let i = 0; i < deckCount; i++) {
      if (!ctx.hasBytes(24)) return null;
      const beat = ctx.readFloat64();
      const totalBeats = ctx.readFloat64();
      const bpm = ctx.readFloat64();
      beats.push({ beat, totalBeats, bpm });
    }

    // Read samples for each deck.
    const decks: DeckBeatInfo[] = [];
    for (let i = 0; i < deckCount; i++) {
      if (!ctx.hasBytes(8)) return null;
      const samples = ctx.readFloat64();
      const entry = beats[i];
      if (!entry) return null;
      decks.push({ beat: entry.beat, totalBeats: entry.totalBeats, bpm: entry.bpm, samples });
    }

    return { messageId, clock, deckCount, decks };
  } catch {
    return null;
  }
}

/**
 * Build a BeatInfo subscription request.
 *
 * The subscription message is simply `[0x00000004][0x00000000]` (8 bytes).
 */
export function buildBeatInfoSubscription(): Uint8Array {
  const ctx = new WriteContext(8);
  ctx.writeUInt32(0x00000004);
  ctx.writeUInt32(0x00000000);
  return ctx.finish();
}
