import { describe, expect, test } from 'bun:test';
import {
  type BuildStatusOptions,
  buildStatus,
  PlayState,
  parseStatus,
  STATUS_LENGTH,
  STATUS_MIN_LENGTH,
  TrackSlot,
  TrackType,
} from '../src/index.ts';

const TEST_STATUS: BuildStatusOptions = {
  deviceId: 1,
  deviceName: 'CDJ-2000NXS2',
  trackSlot: TrackSlot.USB,
  trackType: TrackType.REKORDBOX,
  trackId: 42,
  playState: PlayState.PLAYING,
  isMaster: true,
  trackBpm: 128.5,
  pitch: 0,
  beatCounter: 100,
  beatInBar: 2,
};

describe('buildStatus', () => {
  test('produces a 292-byte packet', () => {
    const packet = buildStatus(TEST_STATUS);
    expect(packet.length).toBe(STATUS_LENGTH);
    expect(packet.length).toBe(0x124);
  });

  test('starts with Pro DJ Link magic', () => {
    const packet = buildStatus(TEST_STATUS);
    expect(Array.from(packet.subarray(0, 10))).toEqual([
      0x51, 0x73, 0x70, 0x74, 0x31, 0x57, 0x6d, 0x4a, 0x4f, 0x4c,
    ]);
  });

  test('writes kind 0x0a at offset 0x0a', () => {
    const packet = buildStatus(TEST_STATUS);
    expect(packet[0x0a]).toBe(0x0a);
  });

  test('writes device ID at offset 0x21', () => {
    const packet = buildStatus({ ...TEST_STATUS, deviceId: 3 });
    expect(packet[0x21]).toBe(3);
  });

  test('writes len_r at offset 0x22..0x23', () => {
    const packet = buildStatus(TEST_STATUS);
    const lenR = ((packet[0x22] ?? 0) << 8) + (packet[0x23] ?? 0);
    expect(lenR).toBe(STATUS_LENGTH - 0x24);
  });

  test('writes track identification fields', () => {
    const packet = buildStatus({
      ...TEST_STATUS,
      trackDeviceId: 2,
      trackSlot: TrackSlot.SD,
      trackType: TrackType.REKORDBOX,
      trackId: 0x1234,
    });
    expect(packet[0x28]).toBe(2);
    expect(packet[0x29]).toBe(TrackSlot.SD);
    expect(packet[0x2a]).toBe(TrackType.REKORDBOX);
    // Track ID as u32 BE
    expect(packet[0x2c]).toBe(0x00);
    expect(packet[0x2d]).toBe(0x00);
    expect(packet[0x2e]).toBe(0x12);
    expect(packet[0x2f]).toBe(0x34);
  });

  test('defaults trackDeviceId to deviceId', () => {
    const packet = buildStatus({ ...TEST_STATUS, deviceId: 5 });
    expect(packet[0x28]).toBe(5);
  });

  test('writes play state at offset 0x7b', () => {
    const packet = buildStatus({ ...TEST_STATUS, playState: PlayState.PAUSED });
    expect(packet[0x7b]).toBe(PlayState.PAUSED);
  });

  test('writes status flags from boolean fields', () => {
    const packet = buildStatus({ ...TEST_STATUS, isMaster: true, isSync: true, isOnAir: true });
    const flags = packet[0x89] ?? 0;
    expect((flags & 0x08) !== 0).toBe(true); // on-air
    expect((flags & 0x10) !== 0).toBe(true); // sync
    expect((flags & 0x20) !== 0).toBe(true); // master
  });

  test('writes explicit statusFlags over booleans', () => {
    const packet = buildStatus({
      ...TEST_STATUS,
      statusFlags: 0xe4,
      isMaster: false, // should be ignored
    });
    expect(packet[0x89]).toBe(0xe4);
  });

  test('writes BPM × 100 at offset 0x92', () => {
    const packet = buildStatus({ ...TEST_STATUS, trackBpm: 141.44 });
    // 141.44 × 100 = 14144 = 0x3740
    expect(packet[0x92]).toBe(0x37);
    expect(packet[0x93]).toBe(0x40);
  });

  test('writes pitch at offset 0x8d as u24 BE', () => {
    // 0 % pitch → raw = 0x100000
    const packet = buildStatus({ ...TEST_STATUS, pitch: 0 });
    expect(packet[0x8d]).toBe(0x10);
    expect(packet[0x8e]).toBe(0x00);
    expect(packet[0x8f]).toBe(0x00);
  });

  test('writes pitch to both Pitch_1 and Pitch_2', () => {
    const packet = buildStatus({ ...TEST_STATUS, pitch: 6 });
    const p1 = ((packet[0x8d] ?? 0) << 16) + ((packet[0x8e] ?? 0) << 8) + (packet[0x8f] ?? 0);
    const p2 = ((packet[0x99] ?? 0) << 16) + ((packet[0x9a] ?? 0) << 8) + (packet[0x9b] ?? 0);
    expect(p1).toBe(p2);
  });

  test('writes beat counter at offset 0xa0', () => {
    const packet = buildStatus({ ...TEST_STATUS, beatCounter: 0x00001234 });
    expect(packet[0xa0]).toBe(0x00);
    expect(packet[0xa1]).toBe(0x00);
    expect(packet[0xa2]).toBe(0x12);
    expect(packet[0xa3]).toBe(0x34);
  });

  test('writes beat-in-bar at offset 0xa6', () => {
    const packet = buildStatus({ ...TEST_STATUS, beatInBar: 3 });
    expect(packet[0xa6]).toBe(3);
  });

  test('writes beats-until-cue at offset 0xa4', () => {
    const packet = buildStatus({ ...TEST_STATUS, beatsUntilCue: 32 });
    expect(packet[0xa4]).toBe(0x00);
    expect(packet[0xa5]).toBe(0x20);
  });

  test('writes master-handoff at offset 0x9f', () => {
    const packet = buildStatus({ ...TEST_STATUS, masterHandoff: 2 });
    expect(packet[0x9f]).toBe(2);
  });

  test('writes packet counter at offset 0xc8', () => {
    const packet = buildStatus({ ...TEST_STATUS, packetCounter: 42 });
    const val =
      ((packet[0xc8] ?? 0) << 24) +
      ((packet[0xc9] ?? 0) << 16) +
      ((packet[0xca] ?? 0) << 8) +
      (packet[0xcb] ?? 0);
    expect(val).toBe(42);
  });

  test('throws on out-of-range device ID', () => {
    expect(() => buildStatus({ ...TEST_STATUS, deviceId: -1 })).toThrow(/deviceId must be a byte/);
    expect(() => buildStatus({ ...TEST_STATUS, deviceId: 300 })).toThrow(/deviceId must be a byte/);
  });
});

describe('parseStatus', () => {
  test('round-trips buildStatus output back to equivalent CdjStatus', () => {
    const packet = buildStatus({
      ...TEST_STATUS,
      pitch: 6,
      beatCounter: 200,
      beatInBar: 3,
      beatsUntilCue: 16,
      packetCounter: 99,
    });
    const status = parseStatus(packet);
    expect(status).not.toBeNull();
    if (!status) return;

    expect(status.deviceId).toBe(1);
    expect(status.deviceName).toBe('CDJ-2000NXS2');
    expect(status.trackSlot).toBe(TrackSlot.USB);
    expect(status.trackType).toBe(TrackType.REKORDBOX);
    expect(status.trackId).toBe(42);
    expect(status.playState).toBe(PlayState.PLAYING);
    expect(status.isPlaying).toBe(true);
    expect(status.isMaster).toBe(true);
    expect(status.isSync).toBe(false);
    expect(status.isOnAir).toBe(false);
    expect(status.trackBpm).toBeCloseTo(128.5, 1);
    expect(status.pitch).toBeCloseTo(6, 1);
    expect(status.effectiveBpm).toBeCloseTo(128.5 * 1.06, 0);
    expect(status.beatCounter).toBe(200);
    expect(status.beatInBar).toBe(3);
    expect(status.beatsUntilCue).toBe(16);
    expect(status.packetCounter).toBe(99);
    expect(status.masterHandoff).toBe(0xff);
    expect(status.timestamp).toBeInstanceOf(Date);
  });

  test('returns null on wrong magic', () => {
    const packet = buildStatus(TEST_STATUS);
    packet[0] = 0x00;
    expect(parseStatus(packet)).toBeNull();
  });

  test('returns null on short buffer', () => {
    expect(parseStatus(new Uint8Array(10))).toBeNull();
    expect(parseStatus(new Uint8Array(STATUS_MIN_LENGTH - 1))).toBeNull();
  });

  test('returns null on wrong kind', () => {
    const packet = buildStatus(TEST_STATUS);
    packet[0x0a] = 0x28; // beat kind, not status
    expect(parseStatus(packet)).toBeNull();
  });

  test('uses the injected `now` for timestamp', () => {
    const packet = buildStatus(TEST_STATUS);
    const fixed = new Date('2026-04-22T20:00:00Z');
    const status = parseStatus(packet, fixed);
    expect(status?.timestamp.getTime()).toBe(fixed.getTime());
  });

  test('isPlaying true for PLAYING state', () => {
    const packet = buildStatus({ ...TEST_STATUS, playState: PlayState.PLAYING });
    expect(parseStatus(packet)?.isPlaying).toBe(true);
  });

  test('isPlaying true for LOOPING state', () => {
    const packet = buildStatus({ ...TEST_STATUS, playState: PlayState.LOOPING });
    expect(parseStatus(packet)?.isPlaying).toBe(true);
  });

  test('isPlaying false for PAUSED state', () => {
    const packet = buildStatus({ ...TEST_STATUS, playState: PlayState.PAUSED });
    expect(parseStatus(packet)?.isPlaying).toBe(false);
  });

  test('isPlaying false for CUED state', () => {
    const packet = buildStatus({ ...TEST_STATUS, playState: PlayState.CUED });
    expect(parseStatus(packet)?.isPlaying).toBe(false);
  });

  test('parses all flag combinations', () => {
    const cases: Array<{
      flags: number;
      master: boolean;
      sync: boolean;
      onAir: boolean;
    }> = [
      { flags: 0x00, master: false, sync: false, onAir: false },
      { flags: 0x08, master: false, sync: false, onAir: true },
      { flags: 0x10, master: false, sync: true, onAir: false },
      { flags: 0x20, master: true, sync: false, onAir: false },
      { flags: 0x38, master: true, sync: true, onAir: true },
      { flags: 0xe4, master: true, sync: false, onAir: false }, // real XDJ-XZ value
    ];
    for (const c of cases) {
      const packet = buildStatus({ ...TEST_STATUS, statusFlags: c.flags });
      const status = parseStatus(packet);
      expect(status?.isMaster).toBe(c.master);
      expect(status?.isSync).toBe(c.sync);
      expect(status?.isOnAir).toBe(c.onAir);
    }
  });

  test('parses beat counter 0xffffffff as not-available', () => {
    const packet = buildStatus({ ...TEST_STATUS, beatCounter: 0xffffffff });
    expect(parseStatus(packet)?.beatCounter).toBe(0xffffffff);
  });

  test('parses beats-until-cue 0x01ff as none', () => {
    const packet = buildStatus({ ...TEST_STATUS, beatsUntilCue: 0x01ff });
    expect(parseStatus(packet)?.beatsUntilCue).toBe(0x01ff);
  });

  test('decodes real XDJ-XZ status packet (analyzed track, player 1, master)', () => {
    // Real status packet captured from XDJ-XZ (2026-04-22), player 1,
    // 89.25 BPM, pitch ≈ +1.96 %, beat 3, master=true, rekordbox track #18.
    const hex =
      '51 73 70 74 31 57 6d 4a 4f 4c 0a 58 44 4a 2d 58 ' +
      '5a 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01 ' +
      '05 01 01 00 01 00 00 00 01 02 01 00 00 00 00 12 ' +
      '00 00 00 01 00 00 00 02 00 00 00 06 00 00 00 03 ' +
      '00 00 00 00 00 00 00 02 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 01 00 06 04 00 00 00 00 ' +
      '00 00 00 00 03 00 00 00 00 00 00 03 31 2e 32 35 ' +
      '00 00 00 00 00 00 00 08 00 e4 ff 9a 00 10 50 48 ' +
      '80 00 22 dd 7f ff ff ff 00 10 50 48 00 09 01 ff ' +
      '00 00 01 28 01 ff 03 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 01 00 00 00 00 00 00 00 00 00 ' +
      '00 10 50 48 00 10 50 48 00 00 00 00 1f 09 00 00 ' +
      '12 34 56 78 00 00 00 01 01 01 01 01 01 01 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '12 34 56 78 00 00 00 01 01 01 01 01 01 01 01 01 ' +
      '01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 05 00 00 09 d4 00 00 01 d6 00 00 00 00 ' +
      '00 00 00 00';
    const bytes = new Uint8Array(hex.split(/\s+/).map((b) => parseInt(b, 16)));

    expect(bytes.length).toBe(292);

    const status = parseStatus(bytes);
    expect(status).not.toBeNull();
    if (!status) return;

    expect(status.deviceId).toBe(1);
    // XDJ-XZ name quirk: name starts at 0x0b, so parsing from 0x0c truncates one char
    expect(status.deviceName).toBe('DJ-XZ');
    expect(status.trackSlot).toBe(TrackSlot.SD);
    expect(status.trackType).toBe(TrackType.REKORDBOX);
    expect(status.trackId).toBe(18);
    expect(status.playState).toBe(PlayState.PLAYING);
    expect(status.isPlaying).toBe(true);
    expect(status.isMaster).toBe(true);
    expect(status.isSync).toBe(false);
    expect(status.isOnAir).toBe(false); // XDJ-XZ combo unit doesn't set on-air for its own decks
    expect(status.statusFlags).toBe(0xe4);
    expect(status.trackBpm).toBeCloseTo(89.25, 1);
    expect(status.pitch).toBeCloseTo(1.96, 1);
    expect(status.effectiveBpm).toBeCloseTo(89.25 * 1.0196, 0);
    expect(status.beatCounter).toBe(296);
    expect(status.beatInBar).toBe(3);
    expect(status.masterHandoff).toBe(0xff);
  });

  test('decodes real XDJ-XZ status packet (unanalyzed track)', () => {
    // Status from unanalyzed track — beat counter = 0xffffffff, beat in bar = 0,
    // master bit not set even though play state = Playing (0x03).
    const hex =
      '51 73 70 74 31 57 6d 4a 4f 4c 0a 58 44 4a 2d 58 ' +
      '5a 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01 ' +
      '05 01 01 00 01 00 00 00 01 02 02 00 06 79 dc 49 ' +
      '00 00 00 01 00 00 00 11 00 00 00 11 00 00 00 00 ' +
      '00 00 00 00 00 00 00 0c 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 01 00 06 06 00 00 00 00 ' +
      '00 00 00 00 03 00 00 00 00 00 00 03 31 2e 32 35 ' +
      '00 00 00 00 00 00 00 04 00 84 ff 9a 00 0f fe 5c ' +
      '00 00 26 b0 7f ff ff ff 00 0f fe 5c 00 09 00 ff ' +
      'ff ff ff ff 01 ff 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 01 00 00 00 00 00 00 00 00 00 ' +
      '00 0f fe 5c 00 0f fe 5c 00 00 00 00 1f 09 00 00 ' +
      '12 34 56 78 00 00 00 01 01 01 01 01 01 01 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '12 34 56 78 00 00 00 01 01 01 01 01 01 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 05 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00';
    const bytes = new Uint8Array(hex.split(/\s+/).map((b) => parseInt(b, 16)));

    const status = parseStatus(bytes);
    expect(status).not.toBeNull();
    if (!status) return;

    expect(status.deviceId).toBe(1);
    expect(status.trackType).toBe(TrackType.UNANALYZED);
    expect(status.playState).toBe(PlayState.PLAYING);
    expect(status.isPlaying).toBe(true);
    expect(status.isMaster).toBe(false);
    expect(status.statusFlags).toBe(0x84);
    expect(status.trackBpm).toBeCloseTo(99.04, 1);
    expect(status.pitch).toBeCloseTo(-0.04, 1);
    expect(status.beatCounter).toBe(0xffffffff); // n/a for unanalyzed
    expect(status.beatInBar).toBe(0); // no phase without analysis
  });
});
