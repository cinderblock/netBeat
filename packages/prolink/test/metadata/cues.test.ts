import { describe, expect, test } from 'bun:test';
import { parseSectionHeader } from '../../src/metadata/anlz.ts';
import type { BuildCueEntryExtOptions, BuildCueEntryOptions } from '../../src/metadata/cues.ts';
import {
  buildCuesExtendedSection,
  buildCuesLegacySection,
  parseCuesExtended,
  parseCuesLegacy,
} from '../../src/metadata/cues.ts';

/** Helper: build a PCOB section, extract body, parse. */
function roundTripLegacy(entries: readonly BuildCueEntryOptions[]) {
  const section = buildCuesLegacySection(entries);
  const header = parseSectionHeader(section, 0) ?? ({ headerLen: 0, tagLen: 0 } as never);
  expect(header).not.toBeNull();
  const body = section.subarray(header.headerLen, header.tagLen);
  const result = parseCuesLegacy(body);
  expect(result).not.toBeNull();
  return result ?? ([] as never);
}

/** Helper: build a PCO2 section, extract body, parse. */
function roundTripExtended(entries: readonly BuildCueEntryExtOptions[]) {
  const section = buildCuesExtendedSection(entries);
  const header = parseSectionHeader(section, 0) ?? ({ headerLen: 0, tagLen: 0 } as never);
  expect(header).not.toBeNull();
  const body = section.subarray(header.headerLen, header.tagLen);
  const result = parseCuesExtended(body);
  expect(result).not.toBeNull();
  return result ?? ([] as never);
}

describe('PCOB (legacy cues)', () => {
  test('section magic is PCOB', () => {
    const section = buildCuesLegacySection([]);
    const magic = String.fromCharCode(section[0], section[1], section[2], section[3]);
    expect(magic).toBe('PCOB');
  });

  test('returns null for too-short body', () => {
    expect(parseCuesLegacy(new Uint8Array(4))).toBeNull();
  });

  test('empty entries', () => {
    const result = roundTripLegacy([]);
    expect(result).toEqual([]);
  });

  test('round-trip: single memory cue', () => {
    const result = roundTripLegacy([{ type: 'memory', timeMs: 5000 }]);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('memory');
    expect(result[0].timeMs).toBe(5000);
    expect(result[0].hotCueSlot).toBeNull();
    expect(result[0].loopEndMs).toBeNull();
  });

  test('round-trip: hot cue A', () => {
    const result = roundTripLegacy([{ type: 'hotcue', timeMs: 10000, hotCueSlot: 1 }]);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('hotcue');
    expect(result[0].timeMs).toBe(10000);
    expect(result[0].hotCueSlot).toBe(1);
  });

  test('round-trip: loop', () => {
    const result = roundTripLegacy([{ type: 'loop', timeMs: 20000, loopEndMs: 24000 }]);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('loop');
    expect(result[0].timeMs).toBe(20000);
    expect(result[0].loopEndMs).toBe(24000);
  });

  test('round-trip: hot loop', () => {
    const result = roundTripLegacy([
      { type: 'hotloop', timeMs: 30000, loopEndMs: 32000, hotCueSlot: 2 },
    ]);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('hotloop');
    expect(result[0].timeMs).toBe(30000);
    expect(result[0].loopEndMs).toBe(32000);
    expect(result[0].hotCueSlot).toBe(2);
  });

  test('round-trip: multiple cues', () => {
    const result = roundTripLegacy([
      { type: 'memory', timeMs: 0 },
      { type: 'hotcue', timeMs: 15000, hotCueSlot: 1 },
      { type: 'hotcue', timeMs: 60000, hotCueSlot: 2 },
      { type: 'memory', timeMs: 240000 },
    ]);
    expect(result.length).toBe(4);
    expect(result[0].timeMs).toBe(0);
    expect(result[1].hotCueSlot).toBe(1);
    expect(result[2].hotCueSlot).toBe(2);
    expect(result[3].timeMs).toBe(240000);
  });

  test('legacy cues have null comment, color, colorId', () => {
    const result = roundTripLegacy([{ type: 'hotcue', timeMs: 1000, hotCueSlot: 1 }]);
    expect(result[0].comment).toBeNull();
    expect(result[0].color).toBeNull();
    expect(result[0].colorId).toBeNull();
  });
});

describe('PCO2 (extended cues)', () => {
  test('section magic is PCO2', () => {
    const section = buildCuesExtendedSection([]);
    const magic = String.fromCharCode(section[0], section[1], section[2], section[3]);
    expect(magic).toBe('PCO2');
  });

  test('returns null for too-short body', () => {
    expect(parseCuesExtended(new Uint8Array(4))).toBeNull();
  });

  test('empty entries', () => {
    const result = roundTripExtended([]);
    expect(result).toEqual([]);
  });

  test('round-trip: memory cue with comment', () => {
    const result = roundTripExtended([{ type: 'memory', timeMs: 5000, comment: 'Drop' }]);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('memory');
    expect(result[0].timeMs).toBe(5000);
    expect(result[0].comment).toBe('Drop');
  });

  test('round-trip: hot cue with color', () => {
    const result = roundTripExtended([
      { type: 'hotcue', timeMs: 10000, hotCueSlot: 1, color: { r: 255, g: 0, b: 128 }, colorId: 1 },
    ]);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('hotcue');
    expect(result[0].hotCueSlot).toBe(1);
    expect(result[0].color).toEqual({ r: 255, g: 0, b: 128 });
    expect(result[0].colorId).toBe(1);
  });

  test('round-trip: hot cue D through H', () => {
    const result = roundTripExtended([
      { type: 'hotcue', timeMs: 10000, hotCueSlot: 4 },
      { type: 'hotcue', timeMs: 20000, hotCueSlot: 5 },
      { type: 'hotcue', timeMs: 30000, hotCueSlot: 6 },
      { type: 'hotcue', timeMs: 40000, hotCueSlot: 7 },
      { type: 'hotcue', timeMs: 50000, hotCueSlot: 8 },
    ]);
    expect(result.length).toBe(5);
    expect(result[0].hotCueSlot).toBe(4);
    expect(result[4].hotCueSlot).toBe(8);
  });

  test('round-trip: loop with comment and color', () => {
    const result = roundTripExtended([
      {
        type: 'loop',
        timeMs: 60000,
        loopEndMs: 64000,
        comment: 'Build',
        color: { r: 0, g: 255, b: 0 },
        colorId: 3,
      },
    ]);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('loop');
    expect(result[0].timeMs).toBe(60000);
    expect(result[0].loopEndMs).toBe(64000);
    expect(result[0].comment).toBe('Build');
    expect(result[0].color).toEqual({ r: 0, g: 255, b: 0 });
  });

  test('round-trip: cue with empty comment', () => {
    const result = roundTripExtended([{ type: 'memory', timeMs: 1000, comment: '' }]);
    expect(result.length).toBe(1);
    // Empty comment should come back as null (or empty string — both acceptable)
    expect(result[0].comment).toBeNull();
  });

  test('round-trip: multiple extended cues', () => {
    const result = roundTripExtended([
      { type: 'memory', timeMs: 0, comment: 'Intro' },
      {
        type: 'hotcue',
        timeMs: 32000,
        hotCueSlot: 1,
        comment: 'Drop',
        color: { r: 255, g: 0, b: 0 },
      },
      {
        type: 'hotcue',
        timeMs: 64000,
        hotCueSlot: 2,
        comment: 'Break',
        color: { r: 0, g: 0, b: 255 },
      },
    ]);
    expect(result.length).toBe(3);
    expect(result[0].comment).toBe('Intro');
    expect(result[1].comment).toBe('Drop');
    expect(result[2].comment).toBe('Break');
  });
});
