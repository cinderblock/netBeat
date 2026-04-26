import { describe, expect, test } from 'bun:test';
import { parseSectionHeader, SECTION_HEADER_SIZE } from '../../src/metadata/anlz.ts';
import { buildBeatGridSection, parseBeatGrid } from '../../src/metadata/beat-grid.ts';
import type { BeatGridEntry } from '../../src/metadata/types.ts';

/** Helper: build a section, extract the body, parse it. */
function roundTrip(entries: readonly BeatGridEntry[]) {
  const section = buildBeatGridSection({ entries });
  const header = parseSectionHeader(section, 0) ?? ({ headerLen: 0, tagLen: 0 } as never);
  expect(header).not.toBeNull();
  const body = section.subarray(header.headerLen, header.tagLen);
  const result = parseBeatGrid(body);
  expect(result).not.toBeNull();
  return result ?? ([] as never);
}

describe('buildBeatGridSection', () => {
  test('produces correct section magic', () => {
    const section = buildBeatGridSection({ entries: [] });
    const magic = String.fromCharCode(section[0], section[1], section[2], section[3]);
    expect(magic).toBe('PQTZ');
  });

  test('section header has correct lengths', () => {
    const entries: BeatGridEntry[] = [
      { beatInBar: 1, bpm: 128.0, timeMs: 0 },
      { beatInBar: 2, bpm: 128.0, timeMs: 468 },
    ];
    const section = buildBeatGridSection({ entries });
    const header = parseSectionHeader(section, 0) ?? ({ headerLen: 0, tagLen: 0 } as never);
    expect(header).not.toBeNull();
    expect(header.headerLen).toBe(SECTION_HEADER_SIZE);
    expect(header.tagLen).toBe(section.length);
    // 12 (section header) + 12 (body header) + 2*8 (entries) = 40
    expect(section.length).toBe(40);
  });

  test('empty entries produces valid section', () => {
    const section = buildBeatGridSection({ entries: [] });
    expect(section.length).toBe(24); // 12 header + 12 body header
  });
});

describe('parseBeatGrid', () => {
  test('returns null for too-short body', () => {
    expect(parseBeatGrid(new Uint8Array(8))).toBeNull();
  });

  test('returns null when entry count exceeds buffer', () => {
    // Body header claiming 100 entries but only 12 bytes of body.
    const body = new Uint8Array(12);
    body[8] = 0;
    body[9] = 0;
    body[10] = 0;
    body[11] = 100; // entry count = 100
    expect(parseBeatGrid(body)).toBeNull();
  });

  test('returns empty array for zero entries', () => {
    const result = roundTrip([]);
    expect(result).toEqual([]);
  });

  test('round-trip: single beat entry', () => {
    const entries: BeatGridEntry[] = [{ beatInBar: 1, bpm: 128.0, timeMs: 0 }];
    const result = roundTrip(entries);
    expect(result.length).toBe(1);
    expect(result[0].beatInBar).toBe(1);
    expect(result[0].bpm).toBeCloseTo(128.0, 2);
    expect(result[0].timeMs).toBe(0);
  });

  test('round-trip: four beats (one bar at 128 BPM)', () => {
    // 128 BPM = 468.75 ms per beat
    const entries: BeatGridEntry[] = [
      { beatInBar: 1, bpm: 128.0, timeMs: 0 },
      { beatInBar: 2, bpm: 128.0, timeMs: 469 },
      { beatInBar: 3, bpm: 128.0, timeMs: 938 },
      { beatInBar: 4, bpm: 128.0, timeMs: 1406 },
    ];
    const result = roundTrip(entries);
    expect(result.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(result[i].beatInBar).toBe(i + 1);
      expect(result[i].bpm).toBeCloseTo(128.0, 2);
      expect(result[i].timeMs).toBe(entries[i].timeMs);
    }
  });

  test('round-trip: variable-tempo track', () => {
    const entries: BeatGridEntry[] = [
      { beatInBar: 1, bpm: 100.0, timeMs: 0 },
      { beatInBar: 2, bpm: 100.0, timeMs: 600 },
      { beatInBar: 3, bpm: 120.0, timeMs: 1100 },
      { beatInBar: 4, bpm: 120.0, timeMs: 1600 },
    ];
    const result = roundTrip(entries);
    expect(result[0].bpm).toBeCloseTo(100.0, 2);
    expect(result[2].bpm).toBeCloseTo(120.0, 2);
  });

  test('round-trip: fractional BPM', () => {
    const entries: BeatGridEntry[] = [{ beatInBar: 1, bpm: 174.25, timeMs: 0 }];
    const result = roundTrip(entries);
    expect(result[0].bpm).toBeCloseTo(174.25, 2);
  });

  test('round-trip: high timeMs value', () => {
    // 5 minutes = 300000 ms
    const entries: BeatGridEntry[] = [{ beatInBar: 3, bpm: 140.0, timeMs: 300000 }];
    const result = roundTrip(entries);
    expect(result[0].timeMs).toBe(300000);
  });

  test('round-trip: large entry count', () => {
    // Simulate a 5-minute track at 128 BPM ≈ 640 beats
    const entries: BeatGridEntry[] = [];
    const msPerBeat = 60000 / 128;
    for (let i = 0; i < 640; i++) {
      entries.push({
        beatInBar: (i % 4) + 1,
        bpm: 128.0,
        timeMs: Math.round(i * msPerBeat),
      });
    }
    const result = roundTrip(entries);
    expect(result.length).toBe(640);
    expect(result[0].timeMs).toBe(0);
    expect(result[639].timeMs).toBe(Math.round(639 * msPerBeat));
  });

  test('beat grid can convert beat number to time', () => {
    const entries: BeatGridEntry[] = [
      { beatInBar: 1, bpm: 120.0, timeMs: 0 },
      { beatInBar: 2, bpm: 120.0, timeMs: 500 },
      { beatInBar: 3, bpm: 120.0, timeMs: 1000 },
      { beatInBar: 4, bpm: 120.0, timeMs: 1500 },
    ];
    const result = roundTrip(entries);
    // Beat 3 starts at 1000 ms
    expect(result[2].timeMs).toBe(1000);
    // Duration of one bar at 120 BPM = 2000 ms
    expect(result[3].timeMs - result[0].timeMs).toBe(1500);
  });
});
