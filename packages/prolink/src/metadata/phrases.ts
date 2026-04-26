/**
 * Phrase analysis parser + builder — PSSI section of ANLZ .EXT files.
 *
 * The PSSI section contains rekordbox's song structure analysis: the
 * track is divided into phrases (intro, buildup, drop/chorus, outro)
 * with beat-indexed boundaries. This is the highest-value data for
 * automated lighting — the `up` → `chorus` transition in high-mood
 * tracks is the buildup-to-drop boundary.
 *
 * **Only present in `.EXT` files** (rekordbox 6+ / nexus2+). Not in
 * basic `.DAT` files. Not exposed via remotedb TCP — NFS scrape or
 * local file access only.
 *
 * **XOR obfuscation:** The PSSI body is XOR'd with a 19-byte mask
 * derived from the phrase count. Each byte of the mask is:
 * `BASE_MASK[i % 19] + len_entries (mod 256)`.
 *
 * **Deobfuscated PSSI body layout:**
 *
 * | Offset | Size | Meaning                                       |
 * |-------:|-----:|-----------------------------------------------|
 * |    0x0 |    4 | u32 BE — len_entry_bytes (24 per entry)       |
 * |    0x4 |    2 | u16 BE — mood (1=high, 2=mid, 3=low)         |
 * |    0x6 |    2 | u16 BE — end_beat                             |
 * |    0x8 |    2 | u16 BE — unknown                              |
 * |    0xa |    1 | u8 — bank (0–8)                               |
 * |    0xb |    1 | padding                                       |
 * |    0xc | n×24 | phrase entries                                |
 *
 * **Each phrase entry (24 bytes):**
 *
 * | Offset | Size | Meaning                                       |
 * |-------:|-----:|-----------------------------------------------|
 * |    0x0 |    2 | u16 BE — phrase number (1-based)              |
 * |    0x2 |    2 | u16 BE — beat number (phrase start)           |
 * |    0x4 |    2 | u16 BE — kind (meaning depends on mood)       |
 * |    0x6 |   14 | padding                                       |
 * |   0x14 |    1 | u8 — fill_in (nonzero = fill present)         |
 * |   0x15 |    1 | padding                                       |
 * |   0x16 |    2 | u16 BE — fill_in_beat_number                  |
 * |   0x18 |  (end of 24 bytes)                                   |
 *
 * Sources: `rekordbox_anlz.ksy` `song_structure_tag` /
 * `song_structure_body` / `song_structure_entry`,
 * `docs/protocol-reference.md` §5.
 */

import type { AnlzSectionHeader } from './anlz.js';
import type {
  HighPhraseKind,
  LowPhraseKind,
  MidPhraseKind,
  Phrase,
  PhraseAnalysis,
  PhraseKind,
  TrackBank,
  TrackMood,
} from './types.js';

// ---- XOR mask ----

/** The 19-byte base XOR mask from rekordbox_anlz.ksy. */
const BASE_MASK: readonly number[] = [
  0xcb, 0xe1, 0xee, 0xfa, 0xe5, 0xee, 0xad, 0xee, 0xe9, 0xd2, 0xe9, 0xeb, 0xe1, 0xe9, 0xf3, 0xe8,
  0xe9, 0xf4, 0xe1,
];

// ---- Body offsets ----

const BODY_HEADER_SIZE = 0x0c;
const OFFSET_LEN_ENTRY_BYTES = 0x00;
const OFFSET_MOOD = 0x04;
const OFFSET_END_BEAT = 0x06;
const OFFSET_BANK = 0x0a;

// ---- Entry offsets (within 24-byte entry) ----

const ENTRY_SIZE = 24;
const ENTRY_OFFSET_PHRASE_NUMBER = 0x00;
const ENTRY_OFFSET_BEAT_NUMBER = 0x02;
const ENTRY_OFFSET_KIND = 0x04;
const ENTRY_OFFSET_FILL_IN = 0x14;
const ENTRY_OFFSET_FILL_IN_BEAT = 0x16;

// ---- Byte helpers ----

function readU16BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset] ?? 0) << 8) | (buf[offset + 1] ?? 0);
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

// ---- Mood / bank / kind enums ----

const MOOD_MAP: Record<number, TrackMood> = {
  1: 'high',
  2: 'mid',
  3: 'low',
};

const MOOD_REVERSE: Record<TrackMood, number> = {
  high: 1,
  mid: 2,
  low: 3,
};

const BANK_MAP: Record<number, TrackBank> = {
  0: 'default',
  1: 'cool',
  2: 'natural',
  3: 'hot',
  4: 'subtle',
  5: 'warm',
  6: 'vivid',
  7: 'club1',
  8: 'club2',
};

const BANK_REVERSE: Record<TrackBank, number> = {
  default: 0,
  cool: 1,
  natural: 2,
  hot: 3,
  subtle: 4,
  warm: 5,
  vivid: 6,
  club1: 7,
  club2: 8,
};

/** High mood phrase kinds (EDM: intro → up → down → chorus → outro). */
const HIGH_KIND_MAP: Record<number, HighPhraseKind> = {
  1: 'intro',
  2: 'up',
  3: 'down',
  5: 'chorus',
  6: 'outro',
};

/** Mid mood phrase kinds. */
const MID_KIND_MAP: Record<number, MidPhraseKind> = {
  1: 'intro',
  2: 'verse1',
  3: 'verse2',
  4: 'verse3',
  5: 'verse4',
  6: 'verse5',
  7: 'verse6',
  8: 'bridge',
  9: 'chorus',
  10: 'outro',
};

/** Low mood phrase kinds. */
const LOW_KIND_MAP: Record<number, LowPhraseKind> = {
  1: 'intro',
  2: 'verse1a',
  3: 'verse1b',
  4: 'verse1c',
  5: 'verse2a',
  6: 'verse2b',
  7: 'verse2c',
  8: 'bridge',
  9: 'chorus',
  10: 'outro',
};

function resolveKind(rawKind: number, mood: TrackMood): PhraseKind {
  switch (mood) {
    case 'high':
      return HIGH_KIND_MAP[rawKind] ?? 'intro';
    case 'mid':
      return MID_KIND_MAP[rawKind] ?? 'intro';
    case 'low':
      return LOW_KIND_MAP[rawKind] ?? 'intro';
  }
}

/** Reverse: phrase kind string → raw number for a given mood. */
const HIGH_KIND_REVERSE: Record<HighPhraseKind, number> = {
  intro: 1,
  up: 2,
  down: 3,
  chorus: 5,
  outro: 6,
};

const MID_KIND_REVERSE: Record<MidPhraseKind, number> = {
  intro: 1,
  verse1: 2,
  verse2: 3,
  verse3: 4,
  verse4: 5,
  verse5: 6,
  verse6: 7,
  bridge: 8,
  chorus: 9,
  outro: 10,
};

const LOW_KIND_REVERSE: Record<LowPhraseKind, number> = {
  intro: 1,
  verse1a: 2,
  verse1b: 3,
  verse1c: 4,
  verse2a: 5,
  verse2b: 6,
  verse2c: 7,
  bridge: 8,
  chorus: 9,
  outro: 10,
};

function reverseKind(kind: PhraseKind, mood: TrackMood): number {
  switch (mood) {
    case 'high':
      return (HIGH_KIND_REVERSE as Record<string, number>)[kind] ?? 1;
    case 'mid':
      return (MID_KIND_REVERSE as Record<string, number>)[kind] ?? 1;
    case 'low':
      return (LOW_KIND_REVERSE as Record<string, number>)[kind] ?? 1;
  }
}

// ---- XOR obfuscation ----

/**
 * Apply or remove XOR obfuscation. The same operation deobfuscates
 * (XOR is its own inverse).
 */
function xorBody(buf: Uint8Array, lenEntries: number): Uint8Array {
  const result = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const maskByte = ((BASE_MASK[i % 19] ?? 0) + lenEntries) & 0xff;
    result[i] = (buf[i] ?? 0) ^ maskByte;
  }
  return result;
}

// ---- Parser ----

/**
 * Parse phrase analysis from a PSSI section body.
 *
 * @param body — the raw (still obfuscated) section body after the
 *   section header
 * @param header — the section header (needed for len_entries count
 *   from section header fields)
 * @returns parsed phrase analysis, or null if malformed
 */
export function parsePhrases(body: Uint8Array, _header: AnlzSectionHeader): PhraseAnalysis | null {
  if (body.length < BODY_HEADER_SIZE) return null;

  // The entry count is needed to compute the XOR mask before we can
  // read the body. In the ANLZ file, the PSSI section header (beyond
  // the standard 12-byte header) contains the entry count at offset
  // 0x10 from the section start = offset 0x04 in the header extension.
  // However, the header extension is not passed to us as `body` — it's
  // part of the header. We need a different approach.
  //
  // From rekordbox_anlz.ksy: the len_entry_bytes field in the body is
  // NOT obfuscated (it's before the XOR-protected range in some
  // interpretations), OR we can derive entry count from body length.
  //
  // Actually, per the Kaitai spec, the PSSI structure stores
  // `len_entries` at header offset 0x10 (i.e., 4 bytes into the
  // header extension beyond the standard 12-byte section header).
  // The XOR is applied to the body portion.
  //
  // Since we receive only the body (post-header), and the entry count
  // is in the header, we compute it from the body size. The body
  // consists of BODY_HEADER_SIZE (12 bytes) + entries (24 bytes each).
  // But this body IS obfuscated, so we need len_entries FIRST.
  //
  // Approach: len_entries = (body.length - BODY_HEADER_SIZE) / ENTRY_SIZE
  // This works because the section's tagLen is known and correct.

  const lenEntries = Math.floor((body.length - BODY_HEADER_SIZE) / ENTRY_SIZE);
  if (lenEntries < 0) return null;

  // Deobfuscate the body.
  const clear = xorBody(body, lenEntries);

  const mood = MOOD_MAP[readU16BE(clear, OFFSET_MOOD)];
  if (!mood) return null;

  const endBeat = readU16BE(clear, OFFSET_END_BEAT);
  const bankRaw = clear[OFFSET_BANK] ?? 0;
  const bank = BANK_MAP[bankRaw] ?? 'default';

  const phrases: Phrase[] = [];
  for (let i = 0; i < lenEntries; i++) {
    const base = BODY_HEADER_SIZE + i * ENTRY_SIZE;
    if (base + ENTRY_SIZE > clear.length) break;

    const rawKind = readU16BE(clear, base + ENTRY_OFFSET_KIND);
    const fillInByte = clear[base + ENTRY_OFFSET_FILL_IN] ?? 0;

    phrases.push({
      phraseNumber: readU16BE(clear, base + ENTRY_OFFSET_PHRASE_NUMBER),
      beatNumber: readU16BE(clear, base + ENTRY_OFFSET_BEAT_NUMBER),
      kind: resolveKind(rawKind, mood),
      rawKind,
      fillIn: fillInByte !== 0,
      fillInBeatNumber:
        fillInByte !== 0 ? readU16BE(clear, base + ENTRY_OFFSET_FILL_IN_BEAT) : null,
    });
  }

  return { mood, endBeat, bank, phrases };
}

// ---- Builder (for round-trip testing) ----

/** Options for building a PSSI section. */
export interface BuildPhrasesOptions {
  readonly mood?: TrackMood;
  readonly endBeat?: number;
  readonly bank?: TrackBank;
  readonly phrases?: readonly Phrase[];
}

/**
 * Build a complete PSSI ANLZ section (header + obfuscated body).
 * Used for round-trip testing.
 */
export function buildPhrasesSection(options: BuildPhrasesOptions = {}): Uint8Array {
  const mood = options.mood ?? 'high';
  const endBeat = options.endBeat ?? 0;
  const bank = options.bank ?? 'default';
  const phrases = options.phrases ?? [];

  const sectionHeaderLen = 12;
  const bodyLen = BODY_HEADER_SIZE + phrases.length * ENTRY_SIZE;
  const tagLen = sectionHeaderLen + bodyLen;

  // Build the cleartext body first.
  const clearBody = new Uint8Array(bodyLen);
  writeU32BE(clearBody, OFFSET_LEN_ENTRY_BYTES, ENTRY_SIZE);
  writeU16BE(clearBody, OFFSET_MOOD, MOOD_REVERSE[mood]);
  writeU16BE(clearBody, OFFSET_END_BEAT, endBeat);
  clearBody[OFFSET_BANK] = BANK_REVERSE[bank];

  for (const [i, p] of phrases.entries()) {
    const base = BODY_HEADER_SIZE + i * ENTRY_SIZE;
    writeU16BE(clearBody, base + ENTRY_OFFSET_PHRASE_NUMBER, p.phraseNumber);
    writeU16BE(clearBody, base + ENTRY_OFFSET_BEAT_NUMBER, p.beatNumber);
    writeU16BE(
      clearBody,
      base + ENTRY_OFFSET_KIND,
      p.rawKind > 0 ? p.rawKind : reverseKind(p.kind, mood),
    );
    clearBody[base + ENTRY_OFFSET_FILL_IN] = p.fillIn ? 1 : 0;
    if (p.fillIn && p.fillInBeatNumber !== null) {
      writeU16BE(clearBody, base + ENTRY_OFFSET_FILL_IN_BEAT, p.fillInBeatNumber);
    }
  }

  // Obfuscate the body.
  const obfuscatedBody = xorBody(clearBody, phrases.length);

  // Assemble the section.
  const buf = new Uint8Array(tagLen);

  // Section header: PSSI.
  buf[0] = 0x50; // P
  buf[1] = 0x53; // S
  buf[2] = 0x53; // S
  buf[3] = 0x49; // I
  writeU32BE(buf, 4, sectionHeaderLen);
  writeU32BE(buf, 8, tagLen);

  // Copy obfuscated body.
  buf.set(obfuscatedBody, sectionHeaderLen);

  return buf;
}
