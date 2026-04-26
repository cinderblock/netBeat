import { describe, expect, test } from 'bun:test';
import { ReadContext } from '../../src/protocol/read-context.js';
import { WriteContext } from '../../src/protocol/write-context.js';
import { buildBeatInfoSubscription, parseBeatInfoMessage } from '../../src/services/beat-info.js';

describe('BeatInfo', () => {
  function buildTestBeatInfo(deckCount: number): Uint8Array {
    const w = new WriteContext();
    w.writeUInt32(1); // messageId
    w.writeUInt64(5_000_000_000n); // clock: 5 seconds in ns
    w.writeUInt32(deckCount);

    // Beat data per deck
    for (let i = 0; i < deckCount; i++) {
      w.writeFloat64(i * 4 + 1); // beat
      w.writeFloat64(500 + i); // totalBeats
      w.writeFloat64(120 + i); // BPM
    }

    // Samples per deck
    for (let i = 0; i < deckCount; i++) {
      w.writeFloat64(44100 * 60 * (i + 1)); // samples
    }

    return w.finish();
  }

  test('parseBeatInfoMessage with 2 decks', () => {
    const buf = buildTestBeatInfo(2);
    const msg = parseBeatInfoMessage(buf);

    expect(msg).not.toBeNull();
    expect(msg?.messageId).toBe(1);
    expect(msg?.clock).toBe(5_000_000_000n);
    expect(msg?.deckCount).toBe(2);
    expect(msg?.decks.length).toBe(2);

    const deck1 = msg?.decks[0];
    expect(deck1?.beat).toBe(1);
    expect(deck1?.totalBeats).toBe(500);
    expect(deck1?.bpm).toBe(120);
    expect(deck1?.samples).toBe(44100 * 60);

    const deck2 = msg?.decks[1];
    expect(deck2?.beat).toBe(5);
    expect(deck2?.totalBeats).toBe(501);
    expect(deck2?.bpm).toBe(121);
    expect(deck2?.samples).toBe(44100 * 60 * 2);
  });

  test('parseBeatInfoMessage with 4 decks', () => {
    const buf = buildTestBeatInfo(4);
    const msg = parseBeatInfoMessage(buf);

    expect(msg).not.toBeNull();
    expect(msg?.deckCount).toBe(4);
    expect(msg?.decks.length).toBe(4);
  });

  test('parseBeatInfoMessage with 0 decks', () => {
    const buf = buildTestBeatInfo(0);
    const msg = parseBeatInfoMessage(buf);

    expect(msg).not.toBeNull();
    expect(msg?.deckCount).toBe(0);
    expect(msg?.decks.length).toBe(0);
  });

  test('parseBeatInfoMessage returns null for insane deck count', () => {
    const w = new WriteContext();
    w.writeUInt32(1);
    w.writeUInt64(0n);
    w.writeUInt32(100); // >8 decks = reject
    expect(parseBeatInfoMessage(w.finish())).toBeNull();
  });

  test('parseBeatInfoMessage returns null for truncated data', () => {
    expect(parseBeatInfoMessage(new Uint8Array(4))).toBeNull();
    expect(parseBeatInfoMessage(new Uint8Array(0))).toBeNull();
  });

  test('parseBeatInfoMessage returns null for truncated deck data', () => {
    const w = new WriteContext();
    w.writeUInt32(1);
    w.writeUInt64(0n);
    w.writeUInt32(2); // claims 2 decks
    // Only write partial data for 1 deck
    w.writeFloat64(1);
    w.writeFloat64(100);
    // Missing: BPM for deck 1, all of deck 2, and all samples
    expect(parseBeatInfoMessage(w.finish())).toBeNull();
  });

  test('buildBeatInfoSubscription format', () => {
    const buf = buildBeatInfoSubscription();
    expect(buf.length).toBe(8);
    const ctx = new ReadContext(buf);
    expect(ctx.readUInt32()).toBe(0x00000004);
    expect(ctx.readUInt32()).toBe(0x00000000);
  });
});
