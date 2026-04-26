import { describe, expect, test } from 'bun:test';
import { FILE_MAGIC, parseAnlzFile, SECTION_HEADER_SIZE } from '../../src/metadata/anlz.ts';
import { buildBeatGridSection } from '../../src/metadata/beat-grid.ts';
import { buildCuesExtendedSection, buildCuesLegacySection } from '../../src/metadata/cues.ts';
import { buildPhrasesSection } from '../../src/metadata/phrases.ts';
import type { BeatGridEntry, Phrase } from '../../src/metadata/types.ts';

/** Build a minimal PMAI file envelope header. */
function buildFileHeader(): Uint8Array {
  const buf = new Uint8Array(SECTION_HEADER_SIZE);
  // PMAI magic.
  buf[0] = 0x50; // P
  buf[1] = 0x4d; // M
  buf[2] = 0x41; // A
  buf[3] = 0x49; // I
  // len_header = 12 (minimal).
  buf[4] = 0;
  buf[5] = 0;
  buf[6] = 0;
  buf[7] = SECTION_HEADER_SIZE;
  // len_tag = 12 (header only — body is zero-length for PMAI).
  buf[8] = 0;
  buf[9] = 0;
  buf[10] = 0;
  buf[11] = SECTION_HEADER_SIZE;
  return buf;
}

/** Concatenate multiple Uint8Arrays. */
function concat(...parts: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

describe('parseAnlzFile', () => {
  test('returns null for empty buffer', () => {
    expect(parseAnlzFile(new Uint8Array(0))).toBeNull();
  });

  test('returns null for too-short buffer', () => {
    expect(parseAnlzFile(new Uint8Array(8))).toBeNull();
  });

  test('returns null for wrong magic', () => {
    const buf = new Uint8Array(12);
    buf[0] = 0x42; // wrong
    expect(parseAnlzFile(buf)).toBeNull();
  });

  test('parses file with only PMAI header', () => {
    const file = buildFileHeader();
    const result = parseAnlzFile(file);
    expect(result).not.toBeNull();
    expect(result?.beatGrid).toBeNull();
    expect(result?.cuePoints).toEqual([]);
    expect(result?.phrases).toBeNull();
  });

  test('parses file with beat grid section', () => {
    const entries: BeatGridEntry[] = [
      { beatInBar: 1, bpm: 128.0, timeMs: 0 },
      { beatInBar: 2, bpm: 128.0, timeMs: 469 },
      { beatInBar: 3, bpm: 128.0, timeMs: 938 },
      { beatInBar: 4, bpm: 128.0, timeMs: 1406 },
    ];
    const beatGridSection = buildBeatGridSection({ entries });
    const file = concat(buildFileHeader(), beatGridSection);
    const result = parseAnlzFile(file);
    expect(result).not.toBeNull();
    expect(result?.beatGrid).not.toBeNull();
    expect(result?.beatGrid?.length).toBe(4);
    expect(result?.beatGrid?.[0]?.beatInBar).toBe(1);
    expect(result?.beatGrid?.[0]?.bpm).toBeCloseTo(128.0, 2);
    expect(result?.beatGrid?.[3]?.timeMs).toBe(1406);
  });

  test('parses file with legacy cues section', () => {
    const cuesSection = buildCuesLegacySection([
      { type: 'memory', timeMs: 0 },
      { type: 'hotcue', timeMs: 30000, hotCueSlot: 1 },
    ]);
    const file = concat(buildFileHeader(), cuesSection);
    const result = parseAnlzFile(file);
    expect(result).not.toBeNull();
    expect(result?.cuePoints.length).toBe(2);
    expect(result?.cuePoints[0]?.type).toBe('memory');
    expect(result?.cuePoints[1]?.hotCueSlot).toBe(1);
  });

  test('parses file with extended cues section', () => {
    const cuesSection = buildCuesExtendedSection([
      {
        type: 'hotcue',
        timeMs: 15000,
        hotCueSlot: 1,
        comment: 'Drop',
        color: { r: 255, g: 0, b: 0 },
        colorId: 1,
      },
    ]);
    const file = concat(buildFileHeader(), cuesSection);
    const result = parseAnlzFile(file);
    expect(result).not.toBeNull();
    expect(result?.cuePoints.length).toBe(1);
    expect(result?.cuePoints[0]?.comment).toBe('Drop');
    expect(result?.cuePoints[0]?.color).toEqual({ r: 255, g: 0, b: 0 });
  });

  test('parses file with phrases section', () => {
    const phrasesSection = buildPhrasesSection({
      mood: 'high',
      endBeat: 256,
      bank: 'hot',
      phrases: [
        {
          phraseNumber: 1,
          beatNumber: 1,
          kind: 'intro',
          rawKind: 1,
          fillIn: false,
          fillInBeatNumber: null,
        },
        {
          phraseNumber: 2,
          beatNumber: 65,
          kind: 'up',
          rawKind: 2,
          fillIn: false,
          fillInBeatNumber: null,
        },
        {
          phraseNumber: 3,
          beatNumber: 129,
          kind: 'chorus',
          rawKind: 5,
          fillIn: false,
          fillInBeatNumber: null,
        },
        {
          phraseNumber: 4,
          beatNumber: 225,
          kind: 'outro',
          rawKind: 6,
          fillIn: false,
          fillInBeatNumber: null,
        },
      ] satisfies Phrase[],
    });
    const file = concat(buildFileHeader(), phrasesSection);
    const result = parseAnlzFile(file);
    expect(result).not.toBeNull();
    expect(result?.phrases).not.toBeNull();
    expect(result?.phrases?.mood).toBe('high');
    expect(result?.phrases?.bank).toBe('hot');
    expect(result?.phrases?.phrases.length).toBe(4);
    expect(result?.phrases?.phrases.map((p) => p.kind)).toEqual(['intro', 'up', 'chorus', 'outro']);
  });

  test('parses .EXT file with all section types', () => {
    // Simulate a complete .EXT file with beat grid, extended cues, and phrases.
    const beatGrid = buildBeatGridSection({
      entries: [
        { beatInBar: 1, bpm: 126.0, timeMs: 0 },
        { beatInBar: 2, bpm: 126.0, timeMs: 476 },
        { beatInBar: 3, bpm: 126.0, timeMs: 952 },
        { beatInBar: 4, bpm: 126.0, timeMs: 1429 },
      ],
    });

    const cuesExt = buildCuesExtendedSection([
      { type: 'memory', timeMs: 0, comment: 'Intro' },
      {
        type: 'hotcue',
        timeMs: 32000,
        hotCueSlot: 1,
        comment: 'Drop 1',
        color: { r: 255, g: 0, b: 0 },
      },
      {
        type: 'hotcue',
        timeMs: 96000,
        hotCueSlot: 2,
        comment: 'Drop 2',
        color: { r: 0, g: 255, b: 0 },
      },
      { type: 'loop', timeMs: 120000, loopEndMs: 128000, comment: 'Build' },
    ]);

    const phrases = buildPhrasesSection({
      mood: 'high',
      endBeat: 512,
      bank: 'vivid',
      phrases: [
        {
          phraseNumber: 1,
          beatNumber: 1,
          kind: 'intro',
          rawKind: 1,
          fillIn: false,
          fillInBeatNumber: null,
        },
        {
          phraseNumber: 2,
          beatNumber: 65,
          kind: 'up',
          rawKind: 2,
          fillIn: true,
          fillInBeatNumber: 60,
        },
        {
          phraseNumber: 3,
          beatNumber: 129,
          kind: 'chorus',
          rawKind: 5,
          fillIn: false,
          fillInBeatNumber: null,
        },
        {
          phraseNumber: 4,
          beatNumber: 257,
          kind: 'down',
          rawKind: 3,
          fillIn: false,
          fillInBeatNumber: null,
        },
        {
          phraseNumber: 5,
          beatNumber: 385,
          kind: 'outro',
          rawKind: 6,
          fillIn: false,
          fillInBeatNumber: null,
        },
      ] satisfies Phrase[],
    });

    const file = concat(buildFileHeader(), beatGrid, cuesExt, phrases);
    const result = parseAnlzFile(file);
    expect(result).not.toBeNull();

    // Beat grid.
    expect(result?.beatGrid?.length).toBe(4);
    expect(result?.beatGrid?.[0]?.bpm).toBeCloseTo(126.0, 2);

    // Extended cues.
    expect(result?.cuePoints.length).toBe(4);
    expect(result?.cuePoints[0]?.comment).toBe('Intro');
    expect(result?.cuePoints[1]?.comment).toBe('Drop 1');
    expect(result?.cuePoints[2]?.comment).toBe('Drop 2');
    expect(result?.cuePoints[3]?.type).toBe('loop');
    expect(result?.cuePoints[3]?.loopEndMs).toBe(128000);

    // Phrases.
    expect(result?.phrases?.mood).toBe('high');
    expect(result?.phrases?.bank).toBe('vivid');
    expect(result?.phrases?.phrases.length).toBe(5);
    expect(result?.phrases?.phrases[1]?.fillIn).toBe(true);
    expect(result?.phrases?.phrases[1]?.fillInBeatNumber).toBe(60);
  });

  test('skips unknown sections gracefully', () => {
    // Build an unknown section (e.g. "PWAV") manually.
    const unknownBody = new Uint8Array(20);
    const unknownSection = new Uint8Array(SECTION_HEADER_SIZE + unknownBody.length);
    // Magic: "PWAV"
    unknownSection[0] = 0x50; // P
    unknownSection[1] = 0x57; // W
    unknownSection[2] = 0x41; // A
    unknownSection[3] = 0x56; // V
    // len_header = 12
    unknownSection[7] = SECTION_HEADER_SIZE;
    // len_tag = 12 + 20 = 32
    unknownSection[11] = SECTION_HEADER_SIZE + unknownBody.length;

    // Place a beat grid section after the unknown section.
    const beatGrid = buildBeatGridSection({
      entries: [{ beatInBar: 1, bpm: 140.0, timeMs: 0 }],
    });

    const file = concat(buildFileHeader(), unknownSection, beatGrid);
    const result = parseAnlzFile(file);
    expect(result).not.toBeNull();
    // Should have skipped the unknown section and parsed the beat grid.
    expect(result?.beatGrid?.length).toBe(1);
    expect(result?.beatGrid?.[0]?.bpm).toBeCloseTo(140.0, 2);
  });

  test('merges legacy and extended cues from same file', () => {
    const legacyCues = buildCuesLegacySection([
      { type: 'memory', timeMs: 0 },
      { type: 'hotcue', timeMs: 5000, hotCueSlot: 1 },
    ]);
    const extCues = buildCuesExtendedSection([
      {
        type: 'hotcue',
        timeMs: 5000,
        hotCueSlot: 1,
        comment: 'Verse',
        color: { r: 0, g: 0, b: 255 },
      },
      { type: 'hotcue', timeMs: 60000, hotCueSlot: 4, comment: 'Drop' },
    ]);

    const file = concat(buildFileHeader(), legacyCues, extCues);
    const result = parseAnlzFile(file);
    expect(result).not.toBeNull();
    // Both sets of cues are merged (4 total).
    expect(result?.cuePoints.length).toBe(4);
  });

  test('file magic is PMAI', () => {
    expect(FILE_MAGIC).toBe('PMAI');
  });
});
