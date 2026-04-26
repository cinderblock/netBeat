/**
 * ANLZ file parser — top-level dispatcher for rekordbox analysis files.
 *
 * Rekordbox analysis files (.DAT for basic, .EXT for extended/nexus2+)
 * contain a sequence of tagged sections. Each section starts with:
 *
 * | Offset | Size | Meaning                                       |
 * |-------:|-----:|-----------------------------------------------|
 * |    0x0 |    4 | ASCII magic (e.g. "PQTZ", "PCOB", "PSSI")    |
 * |    0x4 |    4 | u32 BE `len_header` (header length incl magic)|
 * |    0x8 |    4 | u32 BE `len_tag` (total section length)       |
 *
 * The body starts at `len_header` bytes from the section start and
 * extends for `len_tag - len_header` bytes. Unknown sections are
 * skipped by advancing `len_tag` bytes.
 *
 * The file itself starts with an "PMAI" header section (the file
 * envelope). After that, content sections follow one after another.
 *
 * Sources: `rekordbox_anlz.ksy`, `docs/protocol-reference.md` §5–6.
 */

import { parseBeatGrid } from './beat-grid.js';
import { parseCuesExtended, parseCuesLegacy } from './cues.js';
import { parsePhrases } from './phrases.js';
import type { AnlzFile, BeatGridEntry, CuePoint, PhraseAnalysis } from './types.js';

/** Minimum section header size (magic + len_header + len_tag). */
export const SECTION_HEADER_SIZE = 12;

/** ANLZ file envelope magic ("PMAI"). */
export const FILE_MAGIC = 'PMAI';

/** Known section magic strings. */
export const SectionMagic = {
  FILE_HEADER: 'PMAI',
  BEAT_GRID: 'PQTZ',
  CUES_LEGACY: 'PCOB',
  CUES_EXTENDED: 'PCO2',
  PHRASES: 'PSSI',
  WAVE_PREVIEW: 'PWAV',
  WAVE_TINY: 'PWV2',
  WAVE_SCROLL: 'PWV3',
  WAVE_COLOR_PREVIEW: 'PWV4',
  WAVE_COLOR_SCROLL: 'PWV5',
} as const;

/** Parsed section header — common to all ANLZ sections. */
export interface AnlzSectionHeader {
  /** 4-character ASCII magic identifying the section type. */
  readonly magic: string;
  /** Header length in bytes (includes the magic + length fields). */
  readonly headerLen: number;
  /** Total section length in bytes (header + body). */
  readonly tagLen: number;
}

/** Read a u32 big-endian at the given offset. */
function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    (((buf[offset] ?? 0) << 24) |
      ((buf[offset + 1] ?? 0) << 16) |
      ((buf[offset + 2] ?? 0) << 8) |
      (buf[offset + 3] ?? 0)) >>>
    0
  );
}

/**
 * Parse a section header at the given offset within the buffer.
 * Returns null if the buffer is too short.
 */
export function parseSectionHeader(buf: Uint8Array, offset: number): AnlzSectionHeader | null {
  if (offset + SECTION_HEADER_SIZE > buf.length) return null;

  const magic = String.fromCharCode(
    buf[offset] ?? 0,
    buf[offset + 1] ?? 0,
    buf[offset + 2] ?? 0,
    buf[offset + 3] ?? 0,
  );
  const headerLen = readU32BE(buf, offset + 4);
  const tagLen = readU32BE(buf, offset + 8);

  // Sanity: header must fit within tag, and tag must fit within buffer.
  if (headerLen < SECTION_HEADER_SIZE) return null;
  if (tagLen < headerLen) return null;
  if (offset + tagLen > buf.length) return null;

  return { magic, headerLen, tagLen };
}

/**
 * Parse a complete ANLZ analysis file (.DAT or .EXT).
 *
 * Walks section by section, dispatching to the appropriate parser for
 * known sections and skipping unknown ones. Returns null if the file
 * header is missing or invalid.
 */
export function parseAnlzFile(buf: Uint8Array): AnlzFile | null {
  // Validate file envelope — must start with PMAI section.
  const fileHeader = parseSectionHeader(buf, 0);
  if (!fileHeader || fileHeader.magic !== FILE_MAGIC) return null;

  let beatGrid: readonly BeatGridEntry[] | null = null;
  const cuePoints: CuePoint[] = [];
  let phrases: PhraseAnalysis | null = null;

  // Walk sections starting after the file header.
  let offset = fileHeader.tagLen;

  while (offset < buf.length) {
    const header = parseSectionHeader(buf, offset);
    if (!header) break; // Malformed or truncated — stop parsing.

    const bodyOffset = offset + header.headerLen;
    const bodyLen = header.tagLen - header.headerLen;
    const body = buf.subarray(bodyOffset, bodyOffset + bodyLen);

    switch (header.magic) {
      case SectionMagic.BEAT_GRID: {
        const parsed = parseBeatGrid(body, buf.subarray(offset, offset + header.tagLen));
        if (parsed) beatGrid = parsed;
        break;
      }
      case SectionMagic.CUES_LEGACY: {
        const parsed = parseCuesLegacy(body);
        if (parsed) cuePoints.push(...parsed);
        break;
      }
      case SectionMagic.CUES_EXTENDED: {
        const parsed = parseCuesExtended(body);
        if (parsed) cuePoints.push(...parsed);
        break;
      }
      case SectionMagic.PHRASES: {
        const parsed = parsePhrases(body, header);
        if (parsed) phrases = parsed;
        break;
      }
      // Waveform sections — skip for now (lower priority for lighting).
      default:
        break;
    }

    offset += header.tagLen;
  }

  return { beatGrid, cuePoints, phrases };
}
