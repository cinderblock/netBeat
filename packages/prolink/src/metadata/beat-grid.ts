/**
 * Beat grid parser + builder — PQTZ section of ANLZ analysis files.
 *
 * The beat grid maps every beat in a track to a millisecond offset and
 * a tempo value. This is the foundation for time ↔ beat conversion,
 * which is needed to map phrase boundaries (beat-indexed) to wall-clock
 * time.
 *
 * **PQTZ body layout** (after the 12-byte section header):
 *
 * | Offset | Size | Meaning                                       |
 * |-------:|-----:|-----------------------------------------------|
 * |    0x0 |    4 | u32 BE — unknown (seen `0x00` or `0x01`)      |
 * |    0x4 |    4 | u32 BE — unknown                              |
 * |    0x8 |    4 | u32 BE — entry count                          |
 * |    0xc |  n×8 | beat entries                                  |
 *
 * **Each beat entry (8 bytes):**
 *
 * | Offset | Size | Meaning                                       |
 * |-------:|-----:|-----------------------------------------------|
 * |    0x0 |    2 | u16 BE — beat number within bar (1–4)         |
 * |    0x2 |    2 | u16 BE — tempo (BPM × 100)                    |
 * |    0x4 |    4 | u32 BE — time in ms from track start           |
 *
 * Sources: `rekordbox_anlz.ksy` `beat_grid_tag` / `beat_grid_beat`,
 * `docs/protocol-reference.md` §6.
 */

import type { BeatGridEntry } from './types.js';

/** Size of the PQTZ body header (before entries). */
const BODY_HEADER_SIZE = 12;

/** Size of each beat grid entry. */
const ENTRY_SIZE = 8;

// Body header offsets.
const OFFSET_ENTRY_COUNT = 0x08;

// Per-entry offsets.
const ENTRY_OFFSET_BEAT = 0x00;
const ENTRY_OFFSET_TEMPO = 0x02;
const ENTRY_OFFSET_TIME = 0x04;

function readU16BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset] ?? 0) << 8) | (buf[offset + 1] ?? 0);
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    (((buf[offset] ?? 0) << 24) |
      ((buf[offset + 1] ?? 0) << 16) |
      ((buf[offset + 2] ?? 0) << 8) |
      (buf[offset + 3] ?? 0)) >>>
    0
  );
}

function writeU16BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

/**
 * Parse the beat grid from a PQTZ section body.
 *
 * @param body — the section body (after the section header)
 * @param _fullSection — the full section including header (unused, kept
 *   for signature consistency with the ANLZ dispatcher)
 * @returns array of beat grid entries, or null if the body is malformed
 */
export function parseBeatGrid(
  body: Uint8Array,
  _fullSection?: Uint8Array,
): readonly BeatGridEntry[] | null {
  if (body.length < BODY_HEADER_SIZE) return null;

  const entryCount = readU32BE(body, OFFSET_ENTRY_COUNT);
  const expectedLen = BODY_HEADER_SIZE + entryCount * ENTRY_SIZE;
  if (body.length < expectedLen) return null;

  const entries: BeatGridEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const base = BODY_HEADER_SIZE + i * ENTRY_SIZE;
    entries.push({
      beatInBar: readU16BE(body, base + ENTRY_OFFSET_BEAT),
      bpm: readU16BE(body, base + ENTRY_OFFSET_TEMPO) / 100,
      timeMs: readU32BE(body, base + ENTRY_OFFSET_TIME),
    });
  }

  return entries;
}

/** Options for building a PQTZ section body (for testing). */
export interface BuildBeatGridOptions {
  readonly entries: readonly BeatGridEntry[];
}

/**
 * Build a complete PQTZ ANLZ section (header + body).
 *
 * Returns the full section bytes including the PQTZ section header.
 * Used for round-trip testing.
 */
export function buildBeatGridSection(options: BuildBeatGridOptions): Uint8Array {
  const { entries } = options;
  const headerLen = 12; // Section header: magic(4) + len_header(4) + len_tag(4)
  const bodyHeaderLen = BODY_HEADER_SIZE;
  const bodyLen = bodyHeaderLen + entries.length * ENTRY_SIZE;
  const tagLen = headerLen + bodyLen;

  const buf = new Uint8Array(tagLen);

  // Section header.
  buf[0] = 0x50; // P
  buf[1] = 0x51; // Q
  buf[2] = 0x54; // T
  buf[3] = 0x5a; // Z
  writeU32BE(buf, 4, headerLen);
  writeU32BE(buf, 8, tagLen);

  // Body header.
  const bodyBase = headerLen;
  writeU32BE(buf, bodyBase + OFFSET_ENTRY_COUNT, entries.length);

  // Entries.
  for (const [i, entry] of entries.entries()) {
    const base = bodyBase + BODY_HEADER_SIZE + i * ENTRY_SIZE;
    writeU16BE(buf, base + ENTRY_OFFSET_BEAT, entry.beatInBar);
    writeU16BE(buf, base + ENTRY_OFFSET_TEMPO, Math.round(entry.bpm * 100));
    writeU32BE(buf, base + ENTRY_OFFSET_TIME, entry.timeMs);
  }

  return buf;
}
