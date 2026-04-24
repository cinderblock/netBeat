import { describe, expect, test } from 'bun:test';
import {
  BEAT_LENGTH,
  BEAT_TIMING_TRACK_ENDS,
  type BuildBeatOptions,
  buildBeat,
  decodePitch,
  encodePitch,
  parseBeat,
} from '../src/index.ts';

const TEST_BEAT: BuildBeatOptions = {
  deviceId: 1,
  deviceName: 'CDJ-2000NXS2',
  trackBpm: 128.5,
  beatInBar: 1,
  pitch: 0,
};

describe('decodePitch / encodePitch', () => {
  test('0x100000 = 0 %', () => {
    expect(decodePitch(0x100000)).toBeCloseTo(0, 5);
  });

  test('0x000000 = −100 %', () => {
    expect(decodePitch(0x000000)).toBeCloseTo(-100, 5);
  });

  test('0x200000 = +100 %', () => {
    expect(decodePitch(0x200000)).toBeCloseTo(100, 5);
  });

  test('+6 % round-trips through encode/decode', () => {
    const raw = encodePitch(6);
    expect(decodePitch(raw)).toBeCloseTo(6, 2);
  });

  test('−10 % round-trips through encode/decode', () => {
    const raw = encodePitch(-10);
    expect(decodePitch(raw)).toBeCloseTo(-10, 2);
  });

  test('real XDJ-XZ pitch 0x0e6666 decodes to ≈ −10 %', () => {
    // Captured from real XDJ-XZ hardware session (2026-04-22).
    expect(decodePitch(0x0e6666)).toBeCloseTo(-10.0, 0);
  });

  test('real XDJ-XZ pitch 0x105048 decodes to ≈ +2 %', () => {
    // Captured from real XDJ-XZ hardware session (2026-04-22).
    expect(decodePitch(0x105048)).toBeCloseTo(1.96, 1);
  });
});

describe('buildBeat', () => {
  test('produces a 96-byte packet', () => {
    const packet = buildBeat(TEST_BEAT);
    expect(packet.length).toBe(BEAT_LENGTH);
    expect(packet.length).toBe(0x60);
  });

  test('starts with the Pro DJ Link magic', () => {
    const packet = buildBeat(TEST_BEAT);
    expect(Array.from(packet.subarray(0, 10))).toEqual([
      0x51, 0x73, 0x70, 0x74, 0x31, 0x57, 0x6d, 0x4a, 0x4f, 0x4c,
    ]);
  });

  test('writes kind 0x28 at offset 0x0a', () => {
    const packet = buildBeat(TEST_BEAT);
    expect(packet[0x0a]).toBe(0x28);
  });

  test('writes device ID at offset 0x21 and 0x5f', () => {
    const packet = buildBeat({ ...TEST_BEAT, deviceId: 3 });
    expect(packet[0x21]).toBe(3);
    expect(packet[0x5f]).toBe(3);
  });

  test('writes len_r = 0x3c at offset 0x22', () => {
    const packet = buildBeat(TEST_BEAT);
    expect(packet[0x22]).toBe(0x00);
    expect(packet[0x23]).toBe(0x3c);
  });

  test('writes BPM × 100 at offset 0x5a', () => {
    const packet = buildBeat({ ...TEST_BEAT, trackBpm: 141.44 });
    // 141.44 × 100 = 14144 = 0x3740
    expect(packet[0x5a]).toBe(0x37);
    expect(packet[0x5b]).toBe(0x40);
  });

  test('writes beat-within-bar at offset 0x5c', () => {
    const packet = buildBeat({ ...TEST_BEAT, beatInBar: 3 });
    expect(packet[0x5c]).toBe(3);
  });

  test('writes pitch at offset 0x55 as u24 BE', () => {
    // 0 % pitch → raw = 0x100000
    const packet = buildBeat({ ...TEST_BEAT, pitch: 0 });
    expect(packet[0x54]).toBe(0x00); // leading zero
    expect(packet[0x55]).toBe(0x10);
    expect(packet[0x56]).toBe(0x00);
    expect(packet[0x57]).toBe(0x00);
  });

  test('fills padding at 0x3c..0x53 with 0xff', () => {
    const packet = buildBeat(TEST_BEAT);
    for (let i = 0x3c; i <= 0x53; i++) {
      expect(packet[i]).toBe(0xff);
    }
  });

  test('computes default timing intervals from BPM', () => {
    // 120 BPM → 500 ms per beat
    const packet = buildBeat({ ...TEST_BEAT, trackBpm: 120, beatInBar: 1 });
    // nextBeat = 500
    const nextBeat =
      ((packet[0x24] ?? 0) << 24) +
      ((packet[0x25] ?? 0) << 16) +
      ((packet[0x26] ?? 0) << 8) +
      (packet[0x27] ?? 0);
    expect(nextBeat).toBe(500);
  });

  test('throws on out-of-range device ID', () => {
    expect(() => buildBeat({ ...TEST_BEAT, deviceId: -1 })).toThrow(/deviceId must be a byte/);
    expect(() => buildBeat({ ...TEST_BEAT, deviceId: 300 })).toThrow(/deviceId must be a byte/);
  });

  test('throws on out-of-range beatInBar', () => {
    expect(() => buildBeat({ ...TEST_BEAT, beatInBar: 0 })).toThrow(/beatInBar must be 1..4/);
    expect(() => buildBeat({ ...TEST_BEAT, beatInBar: 5 })).toThrow(/beatInBar must be 1..4/);
  });
});

describe('parseBeat', () => {
  test('round-trips buildBeat output back to an equivalent Beat', () => {
    const packet = buildBeat({
      ...TEST_BEAT,
      pitch: 6,
      nextBeat: 467,
      secondBeat: 934,
      nextBar: 1868,
      fourthBeat: 1868,
      secondBar: 3736,
      eighthBeat: 3736,
    });
    const beat = parseBeat(packet);
    expect(beat).not.toBeNull();
    if (!beat) return;
    expect(beat.deviceId).toBe(1);
    expect(beat.deviceName).toBe('CDJ-2000NXS2');
    expect(beat.trackBpm).toBeCloseTo(128.5, 1);
    expect(beat.pitch).toBeCloseTo(6, 1);
    expect(beat.effectiveBpm).toBeCloseTo(128.5 * 1.06, 0);
    expect(beat.beatInBar).toBe(1);
    expect(beat.nextBeat).toBe(467);
    expect(beat.secondBeat).toBe(934);
    expect(beat.nextBar).toBe(1868);
    expect(beat.fourthBeat).toBe(1868);
    expect(beat.secondBar).toBe(3736);
    expect(beat.eighthBeat).toBe(3736);
    expect(beat.timestamp).toBeInstanceOf(Date);
  });

  test('returns null on wrong magic', () => {
    const packet = buildBeat(TEST_BEAT);
    packet[0] = 0x00;
    expect(parseBeat(packet)).toBeNull();
  });

  test('returns null on short buffer', () => {
    expect(parseBeat(new Uint8Array(10))).toBeNull();
    expect(parseBeat(new Uint8Array(95))).toBeNull();
  });

  test('returns null on a non-beat kind', () => {
    const packet = buildBeat(TEST_BEAT);
    packet[0x0a] = 0x06; // keep-alive kind
    expect(parseBeat(packet)).toBeNull();
  });

  test('uses the injected `now` for timestamp', () => {
    const packet = buildBeat(TEST_BEAT);
    const fixed = new Date('2026-04-22T20:00:00Z');
    const beat = parseBeat(packet, fixed);
    expect(beat?.timestamp.getTime()).toBe(fixed.getTime());
  });

  test('handles 0xffff BPM (no track)', () => {
    const packet = buildBeat(TEST_BEAT);
    // Overwrite BPM to 0xffff
    packet[0x5a] = 0xff;
    packet[0x5b] = 0xff;
    const beat = parseBeat(packet);
    expect(beat).not.toBeNull();
    expect(beat?.trackBpm).toBeCloseTo(655.35, 2);
  });

  test('handles TRACK_ENDS sentinel in timing fields', () => {
    const packet = buildBeat(TEST_BEAT);
    // Write 0xffffffff to nextBar
    packet[0x2c] = 0xff;
    packet[0x2d] = 0xff;
    packet[0x2e] = 0xff;
    packet[0x2f] = 0xff;
    const beat = parseBeat(packet);
    expect(beat).not.toBeNull();
    expect(beat?.nextBar).toBe(BEAT_TIMING_TRACK_ENDS);
  });

  test('decodes BPM and pitch from real XDJ-XZ beat packet', () => {
    // Real beat packet captured from XDJ-XZ (2026-04-22), player 2,
    // 141.44 BPM, pitch ≈ −10 %, beat-within-bar = 1.
    const hex =
      '51 73 70 74 31 57 6d 4a 4f 4c 28 58 44 4a 2d 58' +
      ' 5a 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01' +
      ' 00 02 00 3c 00 00 01 b8 00 00 03 66 00 00 07 6c' +
      ' 00 00 07 6c 00 00 0d 98 00 00 0d 98 ff ff ff ff' +
      ' ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff' +
      ' ff ff ff ff 00 0e 66 66 00 00 37 40 01 00 00 02';
    const bytes = new Uint8Array(hex.split(/\s+/).map((b) => parseInt(b, 16)));

    const beat = parseBeat(bytes);
    expect(beat).not.toBeNull();
    if (!beat) return;

    expect(beat.deviceId).toBe(2);
    // Name parsed from 0x0c is "DJ-XZ" (XDJ-XZ truncated by one char
    // because the XDJ-XZ starts the name at 0x0b, not 0x0c).
    expect(beat.deviceName).toBe('DJ-XZ');
    expect(beat.trackBpm).toBeCloseTo(141.44, 1);
    expect(beat.pitch).toBeCloseTo(-10.0, 0);
    expect(beat.effectiveBpm).toBeCloseTo(141.44 * 0.9, 0);
    expect(beat.beatInBar).toBe(1);
    expect(beat.nextBeat).toBe(0x1b8); // 440 ms
    expect(beat.secondBeat).toBe(0x366);
    expect(beat.nextBar).toBe(0x76c);
    expect(beat.secondBar).toBe(0xd98);
  });

  test('decodes a second real XDJ-XZ beat packet (player 1, beat 4)', () => {
    // Player 1, 89.25 BPM, pitch ≈ +2 %, beat-within-bar = 4.
    const hex =
      '51 73 70 74 31 57 6d 4a 4f 4c 28 58 44 4a 2d 58' +
      ' 5a 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01' +
      ' 00 01 00 3c 00 00 02 b2 00 00 05 a0 00 00 02 b2' +
      ' 00 00 0b 36 00 00 0e 2e 00 00 17 02 ff ff ff ff' +
      ' ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff' +
      ' ff ff ff ff 00 10 50 48 00 00 22 dd 04 00 00 01';
    const bytes = new Uint8Array(hex.split(/\s+/).map((b) => parseInt(b, 16)));

    const beat = parseBeat(bytes);
    expect(beat).not.toBeNull();
    if (!beat) return;

    expect(beat.deviceId).toBe(1);
    expect(beat.trackBpm).toBeCloseTo(89.25, 1);
    expect(beat.pitch).toBeCloseTo(1.96, 1);
    expect(beat.beatInBar).toBe(4);
    // nextBar should be the same as nextBeat when we're on beat 4
    // (next beat IS the downbeat).
    expect(beat.nextBar).toBe(beat.nextBeat);
  });

  test('handles beat-within-bar values 1 through 4', () => {
    for (const b of [1, 2, 3, 4]) {
      const packet = buildBeat({ ...TEST_BEAT, beatInBar: b });
      const beat = parseBeat(packet);
      expect(beat?.beatInBar).toBe(b);
    }
  });

  test('effective BPM accounts for pitch', () => {
    const packet = buildBeat({ ...TEST_BEAT, trackBpm: 120, pitch: 8 });
    const beat = parseBeat(packet);
    expect(beat).not.toBeNull();
    // effective = 120 × 1.08 = 129.6
    expect(beat?.effectiveBpm).toBeCloseTo(129.6, 0);
  });
});
