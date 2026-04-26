/**
 * Cue point parsers + builders — PCOB and PCO2 sections.
 *
 * PCOB (legacy, `cue_tag`): memory cues and hot cues A–C.
 * PCO2 (extended, `cue_extended_tag`, nexus2+): adds hot cues D–H,
 * DJ comment labels (UTF-16BE), and RGB color data.
 *
 * **PCOB body layout** (after 12-byte section header):
 *
 * | Offset | Size | Meaning                                          |
 * |-------:|-----:|--------------------------------------------------|
 * |    0x0 |    4 | u32 BE — cue list type (0 = memory, 1 = hot cue) |
 * |    0x4 |    2 | u16 BE — unknown                                 |
 * |    0x6 |    2 | u16 BE — entry count                             |
 * |    0x8 |    4 | u32 BE — unknown/memory_count                    |
 * |    0xc | n×… | cue entries (variable, each has own header)       |
 *
 * **Each PCOB cue entry:**
 *
 * | Offset | Size | Meaning                                       |
 * |-------:|-----:|-----------------------------------------------|
 * |    0x0 |    4 | ASCII magic "PCPT"                            |
 * |    0x4 |    4 | u32 BE — entry header len                     |
 * |    0x8 |    4 | u32 BE — entry total len                      |
 * |    0xc |    4 | u32 BE — hot cue number (0 = memory cue)      |
 * |   0x10 |    4 | u32 BE — status (0 = disabled, others active) |
 * |   0x14 |    4 | u32 BE — unknown                              |
 * |   0x18 |    2 | u16 BE — order index                          |
 * |   0x1a |    2 | u16 BE — unknown                              |
 * |   0x1c |    1 | u8 — type (1 = point, 2 = loop)               |
 * |   0x1d |    3 | padding                                       |
 * |   0x20 |    4 | u32 BE — time (ms)                            |
 * |   0x24 |    4 | u32 BE — loop time (ms), 0xFFFFFFFF if none   |
 *
 * **PCO2 extended cue entry (PCP2):**
 *
 * | Offset | Size | Meaning                                       |
 * |-------:|-----:|-----------------------------------------------|
 * |    0x0 |    4 | ASCII magic "PCP2"                            |
 * |    0x4 |    4 | u32 BE — entry header len                     |
 * |    0x8 |    4 | u32 BE — entry total len                      |
 * |    0xc |    4 | u32 BE — hot cue number (0 = memory cue)      |
 * |   0x10 |    1 | u8 — type (1 = point, 2 = loop)               |
 * |   0x11 |    3 | padding                                       |
 * |   0x14 |    4 | u32 BE — time (ms)                            |
 * |   0x18 |    4 | u32 BE — loop time (ms), 0xFFFFFFFF if none   |
 * |   0x1c |    4 | u32 BE — color_id                             |
 * |   0x20 |    2 | u16 BE — loop numerator (ignored here)        |
 * |   0x22 |    2 | u16 BE — loop denominator (ignored here)      |
 * |   0x24 |    4 | u32 BE — len_comment (bytes, UTF-16BE)        |
 * |   0x28 | var  | comment bytes (UTF-16BE)                      |
 * |  after |    1 | u8 — color_code                               |
 * |     +1 |    1 | u8 — color_red                                |
 * |     +2 |    1 | u8 — color_green                              |
 * |     +3 |    1 | u8 — color_blue                               |
 *
 * Sources: `rekordbox_anlz.ksy` `cue_tag` / `cue_extended_tag`,
 * `docs/protocol-reference.md` §6.
 */

import type { CuePoint, CueType } from './types.js';

// ---- Byte helpers ----

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

/** Sentinel value for "no loop end" in cue entries. */
const NO_LOOP = 0xffffffff;

/** PCOB cue entry magic. */
const CUE_ENTRY_MAGIC = 'PCPT';

/** PCO2 extended cue entry magic. */
const CUE_ENTRY_EXT_MAGIC = 'PCP2';

// ---- PCOB body offsets ----
const PCOB_OFFSET_LIST_TYPE = 0x00;
const PCOB_OFFSET_COUNT = 0x06;
const PCOB_BODY_HEADER_SIZE = 0x0c;

// ---- PCPT (legacy cue entry) offsets ----
const PCPT_OFFSET_HOT_CUE = 0x0c;
const PCPT_OFFSET_STATUS = 0x10;
const PCPT_OFFSET_TYPE = 0x1c;
const PCPT_OFFSET_TIME = 0x20;
const PCPT_OFFSET_LOOP_TIME = 0x24;
const PCPT_MIN_SIZE = 0x28;

// ---- PCP2 (extended cue entry) offsets ----
const PCP2_OFFSET_HOT_CUE = 0x0c;
const PCP2_OFFSET_TYPE = 0x10;
const PCP2_OFFSET_TIME = 0x14;
const PCP2_OFFSET_LOOP_TIME = 0x18;
const PCP2_OFFSET_COLOR_ID = 0x1c;
const PCP2_OFFSET_LEN_COMMENT = 0x24;
const PCP2_OFFSET_COMMENT = 0x28;
const PCP2_MIN_SIZE = 0x28;

function classifyCueType(entryType: number, hotCue: number): CueType {
  const isLoop = entryType === 2;
  const isHot = hotCue !== 0;
  if (isHot && isLoop) return 'hotloop';
  if (isHot) return 'hotcue';
  if (isLoop) return 'loop';
  return 'memory';
}

/**
 * Decode a UTF-16BE byte array to a string.
 * Strips trailing NUL if present.
 */
function decodeUtf16BE(buf: Uint8Array): string {
  const chars: string[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = ((buf[i] ?? 0) << 8) | (buf[i + 1] ?? 0);
    if (code === 0) break; // NUL terminator
    chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

/**
 * Encode a string to UTF-16BE bytes (with trailing NUL).
 */
function encodeUtf16BE(str: string): Uint8Array {
  const buf = new Uint8Array((str.length + 1) * 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    buf[i * 2] = (code >>> 8) & 0xff;
    buf[i * 2 + 1] = code & 0xff;
  }
  // Trailing NUL is already 0x00 0x00 from Uint8Array init.
  return buf;
}

// ---- PCOB (legacy cues) ----

/**
 * Parse legacy cue entries from a PCOB section body.
 * Returns null if the body is malformed.
 */
export function parseCuesLegacy(body: Uint8Array): readonly CuePoint[] | null {
  if (body.length < PCOB_BODY_HEADER_SIZE) return null;

  const count = readU16BE(body, PCOB_OFFSET_COUNT);
  const cues: CuePoint[] = [];

  let offset = PCOB_BODY_HEADER_SIZE;
  for (let i = 0; i < count; i++) {
    if (offset + PCPT_MIN_SIZE > body.length) break;

    // Validate entry magic.
    const magic = String.fromCharCode(
      body[offset] ?? 0,
      body[offset + 1] ?? 0,
      body[offset + 2] ?? 0,
      body[offset + 3] ?? 0,
    );
    if (magic !== CUE_ENTRY_MAGIC) break;

    const entryLen = readU32BE(body, offset + 8);
    if (offset + entryLen > body.length) break;

    const hotCue = readU32BE(body, offset + PCPT_OFFSET_HOT_CUE);
    const status = readU32BE(body, offset + PCPT_OFFSET_STATUS);
    const entryType = body[offset + PCPT_OFFSET_TYPE] ?? 0;
    const timeMs = readU32BE(body, offset + PCPT_OFFSET_TIME);
    const loopTimeRaw = readU32BE(body, offset + PCPT_OFFSET_LOOP_TIME);

    // Skip disabled entries.
    if (status === 0 && hotCue === 0) {
      offset += entryLen;
      continue;
    }

    const type = classifyCueType(entryType, hotCue);
    cues.push({
      type,
      timeMs,
      loopEndMs: loopTimeRaw !== NO_LOOP ? loopTimeRaw : null,
      hotCueSlot: hotCue > 0 ? hotCue : null,
      comment: null,
      color: null,
      colorId: null,
    });

    offset += entryLen;
  }

  return cues;
}

// ---- PCO2 (extended cues) ----

/**
 * Parse extended cue entries from a PCO2 section body.
 * Returns null if the body is malformed.
 */
export function parseCuesExtended(body: Uint8Array): readonly CuePoint[] | null {
  if (body.length < PCOB_BODY_HEADER_SIZE) return null;

  const count = readU16BE(body, PCOB_OFFSET_COUNT);
  const cues: CuePoint[] = [];

  let offset = PCOB_BODY_HEADER_SIZE;
  for (let i = 0; i < count; i++) {
    if (offset + PCP2_MIN_SIZE > body.length) break;

    const magic = String.fromCharCode(
      body[offset] ?? 0,
      body[offset + 1] ?? 0,
      body[offset + 2] ?? 0,
      body[offset + 3] ?? 0,
    );
    if (magic !== CUE_ENTRY_EXT_MAGIC) break;

    const entryLen = readU32BE(body, offset + 8);
    if (offset + entryLen > body.length) break;

    const hotCue = readU32BE(body, offset + PCP2_OFFSET_HOT_CUE);
    const entryType = body[offset + PCP2_OFFSET_TYPE] ?? 0;
    const timeMs = readU32BE(body, offset + PCP2_OFFSET_TIME);
    const loopTimeRaw = readU32BE(body, offset + PCP2_OFFSET_LOOP_TIME);
    const colorId = readU32BE(body, offset + PCP2_OFFSET_COLOR_ID);

    // Parse comment if present.
    let comment: string | null = null;
    let colorR = 0;
    let colorG = 0;
    let colorB = 0;

    if (offset + PCP2_OFFSET_COMMENT <= body.length) {
      const lenComment = readU32BE(body, offset + PCP2_OFFSET_LEN_COMMENT);
      if (lenComment > 0 && offset + PCP2_OFFSET_COMMENT + lenComment <= body.length) {
        const commentBytes = body.subarray(
          offset + PCP2_OFFSET_COMMENT,
          offset + PCP2_OFFSET_COMMENT + lenComment,
        );
        comment = decodeUtf16BE(commentBytes);

        // Color bytes follow the comment.
        const colorOffset = offset + PCP2_OFFSET_COMMENT + lenComment;
        if (colorOffset + 4 <= body.length) {
          // colorOffset+0 is color_code (skip), +1 is R, +2 is G, +3 is B
          colorR = body[colorOffset + 1] ?? 0;
          colorG = body[colorOffset + 2] ?? 0;
          colorB = body[colorOffset + 3] ?? 0;
        }
      }
    }

    const type = classifyCueType(entryType, hotCue);
    cues.push({
      type,
      timeMs,
      loopEndMs: loopTimeRaw !== NO_LOOP ? loopTimeRaw : null,
      hotCueSlot: hotCue > 0 ? hotCue : null,
      comment: comment || null,
      color: colorR || colorG || colorB ? { r: colorR, g: colorG, b: colorB } : null,
      colorId: colorId > 0 ? colorId : null,
    });

    offset += entryLen;
  }

  return cues;
}

// ---- Builders (for round-trip testing) ----

/** Options for a single cue entry. */
export interface BuildCueEntryOptions {
  readonly type?: CueType;
  readonly timeMs?: number;
  readonly loopEndMs?: number | null;
  readonly hotCueSlot?: number | null;
}

/** Build a complete PCOB section (header + body) for testing. */
export function buildCuesLegacySection(entries: readonly BuildCueEntryOptions[]): Uint8Array {
  const sectionHeaderLen = 12;
  const entrySize = PCPT_MIN_SIZE;
  const bodyHeaderLen = PCOB_BODY_HEADER_SIZE;
  const bodyLen = bodyHeaderLen + entries.length * entrySize;
  const tagLen = sectionHeaderLen + bodyLen;

  const buf = new Uint8Array(tagLen);

  // Section header.
  buf[0] = 0x50; // P
  buf[1] = 0x43; // C
  buf[2] = 0x4f; // O
  buf[3] = 0x42; // B
  writeU32BE(buf, 4, sectionHeaderLen);
  writeU32BE(buf, 8, tagLen);

  // Body header.
  const bodyBase = sectionHeaderLen;
  const listType = entries.some((e) => e.hotCueSlot && e.hotCueSlot > 0) ? 1 : 0;
  writeU32BE(buf, bodyBase + PCOB_OFFSET_LIST_TYPE, listType);
  writeU16BE(buf, bodyBase + PCOB_OFFSET_COUNT, entries.length);

  // Entries.
  let offset = bodyBase + bodyHeaderLen;
  for (const entry of entries) {
    const type = entry.type ?? 'memory';
    const hotCue = entry.hotCueSlot ?? 0;
    const entryType = type === 'loop' || type === 'hotloop' ? 2 : 1;
    const loopEnd = entry.loopEndMs ?? NO_LOOP;

    // PCPT magic.
    buf[offset] = 0x50; // P
    buf[offset + 1] = 0x43; // C
    buf[offset + 2] = 0x50; // P
    buf[offset + 3] = 0x54; // T
    writeU32BE(buf, offset + 4, entrySize); // entry header len
    writeU32BE(buf, offset + 8, entrySize); // entry total len
    writeU32BE(buf, offset + PCPT_OFFSET_HOT_CUE, hotCue);
    writeU32BE(buf, offset + PCPT_OFFSET_STATUS, 1); // active
    buf[offset + PCPT_OFFSET_TYPE] = entryType;
    writeU32BE(buf, offset + PCPT_OFFSET_TIME, entry.timeMs ?? 0);
    writeU32BE(buf, offset + PCPT_OFFSET_LOOP_TIME, loopEnd);

    offset += entrySize;
  }

  return buf;
}

/** Options for an extended cue entry (PCO2). */
export interface BuildCueEntryExtOptions extends BuildCueEntryOptions {
  readonly comment?: string | null;
  readonly color?: { readonly r: number; readonly g: number; readonly b: number } | null;
  readonly colorId?: number | null;
}

/** Build a complete PCO2 section (header + body) for testing. */
export function buildCuesExtendedSection(entries: readonly BuildCueEntryExtOptions[]): Uint8Array {
  // Calculate total size.
  const sectionHeaderLen = 12;
  const bodyHeaderLen = PCOB_BODY_HEADER_SIZE;

  let totalEntryBytes = 0;
  const encodedComments: Uint8Array[] = [];
  for (const entry of entries) {
    const commentBytes = encodeUtf16BE(entry.comment ?? '');
    encodedComments.push(commentBytes);
    // PCP2 base (0x28) + comment bytes + 4 color bytes
    totalEntryBytes += PCP2_MIN_SIZE + commentBytes.length + 4;
  }

  const tagLen = sectionHeaderLen + bodyHeaderLen + totalEntryBytes;
  const buf = new Uint8Array(tagLen);

  // Section header: PCO2.
  buf[0] = 0x50; // P
  buf[1] = 0x43; // C
  buf[2] = 0x4f; // O
  buf[3] = 0x32; // 2
  writeU32BE(buf, 4, sectionHeaderLen);
  writeU32BE(buf, 8, tagLen);

  // Body header.
  const bodyBase = sectionHeaderLen;
  writeU16BE(buf, bodyBase + PCOB_OFFSET_COUNT, entries.length);

  // Entries.
  let offset = bodyBase + bodyHeaderLen;
  let commentIdx = 0;
  for (const entry of entries) {
    const commentBytes = encodedComments[commentIdx++] ?? new Uint8Array(0);
    const entryLen = PCP2_MIN_SIZE + commentBytes.length + 4;

    const type = entry.type ?? 'memory';
    const hotCue = entry.hotCueSlot ?? 0;
    const entryType = type === 'loop' || type === 'hotloop' ? 2 : 1;
    const loopEnd = entry.loopEndMs ?? NO_LOOP;

    // PCP2 magic.
    buf[offset] = 0x50; // P
    buf[offset + 1] = 0x43; // C
    buf[offset + 2] = 0x50; // P
    buf[offset + 3] = 0x32; // 2
    writeU32BE(buf, offset + 4, entryLen); // entry header len
    writeU32BE(buf, offset + 8, entryLen); // entry total len
    writeU32BE(buf, offset + PCP2_OFFSET_HOT_CUE, hotCue);
    buf[offset + PCP2_OFFSET_TYPE] = entryType;
    writeU32BE(buf, offset + PCP2_OFFSET_TIME, entry.timeMs ?? 0);
    writeU32BE(buf, offset + PCP2_OFFSET_LOOP_TIME, loopEnd);
    writeU32BE(buf, offset + PCP2_OFFSET_COLOR_ID, entry.colorId ?? 0);
    writeU32BE(buf, offset + PCP2_OFFSET_LEN_COMMENT, commentBytes.length);

    // Comment bytes.
    buf.set(commentBytes, offset + PCP2_OFFSET_COMMENT);

    // Color bytes after comment.
    const colorOffset = offset + PCP2_OFFSET_COMMENT + commentBytes.length;
    buf[colorOffset] = 0; // color_code
    buf[colorOffset + 1] = entry.color?.r ?? 0;
    buf[colorOffset + 2] = entry.color?.g ?? 0;
    buf[colorOffset + 3] = entry.color?.b ?? 0;

    offset += entryLen;
  }

  return buf;
}
