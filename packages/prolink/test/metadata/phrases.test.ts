import { describe, expect, test } from 'bun:test';
import { parseSectionHeader } from '../../src/metadata/anlz.ts';
import { buildPhrasesSection, parsePhrases } from '../../src/metadata/phrases.ts';
import type { Phrase, PhraseAnalysis, TrackBank, TrackMood } from '../../src/metadata/types.ts';

/** Helper: build a PSSI section, extract body + header, parse. */
function roundTrip(options: {
  mood?: TrackMood;
  endBeat?: number;
  bank?: TrackBank;
  phrases?: readonly Phrase[];
}): PhraseAnalysis {
  const section = buildPhrasesSection(options);
  const header = parseSectionHeader(section, 0) ?? ({} as never);
  expect(header).not.toBeNull();
  const body = section.subarray(header.headerLen, header.tagLen);
  const result = parsePhrases(body, header);
  expect(result).not.toBeNull();
  return result ?? ({} as never);
}

/** Convenience: build a phrase entry. */
function phrase(
  phraseNumber: number,
  beatNumber: number,
  kind: string,
  rawKind: number,
  fillIn = false,
  fillInBeatNumber: number | null = null,
): Phrase {
  return {
    phraseNumber,
    beatNumber,
    kind: kind as Phrase['kind'],
    rawKind,
    fillIn,
    fillInBeatNumber,
  };
}

describe('buildPhrasesSection', () => {
  test('produces correct section magic', () => {
    const section = buildPhrasesSection();
    const magic = String.fromCharCode(section[0], section[1], section[2], section[3]);
    expect(magic).toBe('PSSI');
  });

  test('section header has correct lengths', () => {
    const section = buildPhrasesSection({ phrases: [phrase(1, 1, 'intro', 1)] });
    const header = parseSectionHeader(section, 0) ?? ({} as never);
    expect(header).not.toBeNull();
    expect(header.tagLen).toBe(section.length);
    // 12 (section header) + 12 (body header) + 1*24 (entry) = 48
    expect(section.length).toBe(48);
  });

  test('body is XOR-obfuscated (not cleartext)', () => {
    const section = buildPhrasesSection({
      mood: 'high',
      phrases: [phrase(1, 1, 'intro', 1)],
    });
    // The mood field in cleartext would be 0x0001 (high).
    // After XOR obfuscation it should be different.
    // Mood is at body offset 0x04 = section offset 12 + 4 = 16.
    const moodByte1 = section[16];
    const moodByte2 = section[17];
    // With 1 entry, mask[4] + 1 = 0xE5 + 1 = 0xE6, mask[5] + 1 = 0xEE + 1 = 0xEF
    // XOR: 0x00 ^ 0xE6 = 0xE6, 0x01 ^ 0xEF = 0xEE
    expect(moodByte1).toBe(0xe6);
    expect(moodByte2).toBe(0xee);
  });
});

describe('parsePhrases', () => {
  test('returns null for too-short body', () => {
    const header = { magic: 'PSSI', headerLen: 12, tagLen: 20 };
    expect(parsePhrases(new Uint8Array(4), header)).toBeNull();
  });

  test('round-trip: empty phrases', () => {
    const result = roundTrip({ mood: 'high', endBeat: 0, bank: 'default', phrases: [] });
    expect(result.mood).toBe('high');
    expect(result.endBeat).toBe(0);
    expect(result.bank).toBe('default');
    expect(result.phrases).toEqual([]);
  });

  test('round-trip: mood values', () => {
    expect(roundTrip({ mood: 'high' }).mood).toBe('high');
    expect(roundTrip({ mood: 'mid' }).mood).toBe('mid');
    expect(roundTrip({ mood: 'low' }).mood).toBe('low');
  });

  test('round-trip: bank values', () => {
    const banks: TrackBank[] = [
      'default',
      'cool',
      'natural',
      'hot',
      'subtle',
      'warm',
      'vivid',
      'club1',
      'club2',
    ];
    for (const bank of banks) {
      expect(roundTrip({ bank }).bank).toBe(bank);
    }
  });

  test('round-trip: endBeat', () => {
    expect(roundTrip({ endBeat: 0 }).endBeat).toBe(0);
    expect(roundTrip({ endBeat: 512 }).endBeat).toBe(512);
    expect(roundTrip({ endBeat: 2048 }).endBeat).toBe(2048);
  });

  // ---- High mood (EDM) phrase kinds ----

  test('round-trip: high mood — intro', () => {
    const result = roundTrip({
      mood: 'high',
      phrases: [phrase(1, 1, 'intro', 1)],
    });
    expect(result.phrases[0].kind).toBe('intro');
    expect(result.phrases[0].rawKind).toBe(1);
  });

  test('round-trip: high mood — up (buildup)', () => {
    const result = roundTrip({
      mood: 'high',
      phrases: [phrase(1, 33, 'up', 2)],
    });
    expect(result.phrases[0].kind).toBe('up');
  });

  test('round-trip: high mood — down', () => {
    const result = roundTrip({
      mood: 'high',
      phrases: [phrase(1, 65, 'down', 3)],
    });
    expect(result.phrases[0].kind).toBe('down');
  });

  test('round-trip: high mood — chorus (drop)', () => {
    const result = roundTrip({
      mood: 'high',
      phrases: [phrase(1, 97, 'chorus', 5)],
    });
    expect(result.phrases[0].kind).toBe('chorus');
    expect(result.phrases[0].rawKind).toBe(5);
  });

  test('round-trip: high mood — outro', () => {
    const result = roundTrip({
      mood: 'high',
      phrases: [phrase(1, 129, 'outro', 6)],
    });
    expect(result.phrases[0].kind).toBe('outro');
  });

  test('round-trip: high mood — full EDM structure', () => {
    const result = roundTrip({
      mood: 'high',
      endBeat: 256,
      bank: 'hot',
      phrases: [
        phrase(1, 1, 'intro', 1),
        phrase(2, 33, 'up', 2),
        phrase(3, 65, 'chorus', 5),
        phrase(4, 129, 'down', 3),
        phrase(5, 161, 'up', 2),
        phrase(6, 193, 'chorus', 5),
        phrase(7, 225, 'outro', 6),
      ],
    });
    expect(result.mood).toBe('high');
    expect(result.endBeat).toBe(256);
    expect(result.bank).toBe('hot');
    expect(result.phrases.length).toBe(7);
    expect(result.phrases.map((p) => p.kind)).toEqual([
      'intro',
      'up',
      'chorus',
      'down',
      'up',
      'chorus',
      'outro',
    ]);
  });

  // ---- Mid mood phrase kinds ----

  test('round-trip: mid mood — verse and bridge', () => {
    const result = roundTrip({
      mood: 'mid',
      phrases: [
        phrase(1, 1, 'intro', 1),
        phrase(2, 33, 'verse1', 2),
        phrase(3, 65, 'bridge', 8),
        phrase(4, 97, 'chorus', 9),
        phrase(5, 129, 'outro', 10),
      ],
    });
    expect(result.phrases.map((p) => p.kind)).toEqual([
      'intro',
      'verse1',
      'bridge',
      'chorus',
      'outro',
    ]);
  });

  test('round-trip: mid mood — all verse variants', () => {
    const result = roundTrip({
      mood: 'mid',
      phrases: [
        phrase(1, 1, 'verse1', 2),
        phrase(2, 33, 'verse2', 3),
        phrase(3, 65, 'verse3', 4),
        phrase(4, 97, 'verse4', 5),
        phrase(5, 129, 'verse5', 6),
        phrase(6, 161, 'verse6', 7),
      ],
    });
    expect(result.phrases.map((p) => p.kind)).toEqual([
      'verse1',
      'verse2',
      'verse3',
      'verse4',
      'verse5',
      'verse6',
    ]);
  });

  // ---- Low mood phrase kinds ----

  test('round-trip: low mood — verse variants', () => {
    const result = roundTrip({
      mood: 'low',
      phrases: [
        phrase(1, 1, 'intro', 1),
        phrase(2, 33, 'verse1a', 2),
        phrase(3, 65, 'verse1b', 3),
        phrase(4, 97, 'verse1c', 4),
        phrase(5, 129, 'verse2a', 5),
        phrase(6, 161, 'verse2b', 6),
        phrase(7, 193, 'verse2c', 7),
      ],
    });
    expect(result.phrases.map((p) => p.kind)).toEqual([
      'intro',
      'verse1a',
      'verse1b',
      'verse1c',
      'verse2a',
      'verse2b',
      'verse2c',
    ]);
  });

  // ---- Fill-ins ----

  test('round-trip: phrase with fill-in', () => {
    const result = roundTrip({
      mood: 'high',
      phrases: [phrase(1, 1, 'up', 2, true, 28)],
    });
    expect(result.phrases[0].fillIn).toBe(true);
    expect(result.phrases[0].fillInBeatNumber).toBe(28);
  });

  test('round-trip: phrase without fill-in', () => {
    const result = roundTrip({
      mood: 'high',
      phrases: [phrase(1, 1, 'chorus', 5, false, null)],
    });
    expect(result.phrases[0].fillIn).toBe(false);
    expect(result.phrases[0].fillInBeatNumber).toBeNull();
  });

  // ---- XOR obfuscation ----

  test('XOR obfuscation is symmetric', () => {
    // Build → the body is obfuscated
    // Parse → deobfuscates and reads correct values
    // This test verifies the round-trip implicitly tests XOR symmetry
    const result = roundTrip({
      mood: 'high',
      endBeat: 1024,
      bank: 'vivid',
      phrases: [phrase(1, 1, 'intro', 1), phrase(2, 33, 'chorus', 5), phrase(3, 65, 'outro', 6)],
    });
    expect(result.mood).toBe('high');
    expect(result.endBeat).toBe(1024);
    expect(result.bank).toBe('vivid');
    expect(result.phrases.length).toBe(3);
  });

  test('XOR with different entry counts produces different masks', () => {
    // Build two sections with different entry counts.
    const s1 = buildPhrasesSection({ mood: 'high', phrases: [phrase(1, 1, 'intro', 1)] });
    const s2 = buildPhrasesSection({
      mood: 'high',
      phrases: [phrase(1, 1, 'intro', 1), phrase(2, 33, 'up', 2)],
    });
    // The obfuscated bytes should differ even though the first entry is the same.
    // Compare the first entry's bytes (offset 12+12=24 to 24+24=48 in section).
    const e1 = s1.subarray(24, 48);
    const e2 = s2.subarray(24, 48);
    let anyDiff = false;
    for (let i = 0; i < e1.length && i < e2.length; i++) {
      if (e1[i] !== e2[i]) anyDiff = true;
    }
    expect(anyDiff).toBe(true);
  });

  // ---- phraseNumber and beatNumber ----

  test('round-trip: phraseNumber is 1-based', () => {
    const result = roundTrip({
      mood: 'high',
      phrases: [phrase(1, 1, 'intro', 1), phrase(2, 33, 'up', 2), phrase(3, 65, 'chorus', 5)],
    });
    expect(result.phrases[0].phraseNumber).toBe(1);
    expect(result.phrases[1].phraseNumber).toBe(2);
    expect(result.phrases[2].phraseNumber).toBe(3);
  });

  test('round-trip: beatNumber at phrase boundaries', () => {
    const result = roundTrip({
      mood: 'high',
      phrases: [phrase(1, 1, 'intro', 1), phrase(2, 129, 'chorus', 5), phrase(3, 257, 'outro', 6)],
    });
    expect(result.phrases[0].beatNumber).toBe(1);
    expect(result.phrases[1].beatNumber).toBe(129);
    expect(result.phrases[2].beatNumber).toBe(257);
  });

  // ---- Lighting use case ----

  test('buildup-to-drop detection: up → chorus transition', () => {
    const result = roundTrip({
      mood: 'high',
      bank: 'hot',
      endBeat: 512,
      phrases: [
        phrase(1, 1, 'intro', 1),
        phrase(2, 65, 'up', 2),
        phrase(3, 129, 'chorus', 5),
        phrase(4, 257, 'down', 3),
        phrase(5, 321, 'up', 2),
        phrase(6, 385, 'chorus', 5),
        phrase(7, 449, 'outro', 6),
      ],
    });

    // Find buildup-to-drop boundaries.
    const drops: number[] = [];
    for (let i = 1; i < result.phrases.length; i++) {
      if (result.phrases[i - 1].kind === 'up' && result.phrases[i].kind === 'chorus') {
        drops.push(result.phrases[i].beatNumber);
      }
    }
    expect(drops).toEqual([129, 385]);
  });
});
