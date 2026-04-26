/**
 * Rekordbox PDB database parser.
 *
 * The PDB file (`export.pdb`) is a page-based binary database stored on
 * USB/SD media prepared by rekordbox. It contains multiple tables (tracks,
 * artists, albums, genres, keys, colors, labels) organized as linked
 * lists of pages. Each page has fixed-size rows with field offsets stored
 * in a row-presence/offset section.
 *
 * **This is NOT SQLite.** It's a custom Pioneer format described by the
 * `rekordbox_pdb.ksy` Kaitai Struct spec.
 *
 * **File layout:**
 *
 * | Offset | Size  | Meaning                                        |
 * |-------:|------:|------------------------------------------------|
 * |    0x0 |     4 | u32 LE — unknown (always 0)                    |
 * |    0x4 |     4 | u32 LE — page_size (usually 4096)              |
 * |    0x8 |     4 | u32 LE — num_tables                            |
 * |    0xc |     4 | u32 LE — next_unused_page                      |
 * |   0x10 |     4 | u32 LE — unknown                               |
 * |   0x14 |     4 | u32 LE — sequence                              |
 * |   0x18 |   gap | padding / unknown                              |
 * |   0x1c | n×12  | table pointers (first_page, last_page, type)   |
 *
 * **Each table pointer (12 bytes):**
 *
 * | Offset | Size | Meaning                                         |
 * |-------:|-----:|-------------------------------------------------|
 * |    0x0 |    4 | u32 LE — first_page index                       |
 * |    0x4 |    4 | u32 LE — last_page index                        |
 * |    0x8 |    4 | u32 LE — table type                             |
 *
 * **Page layout:**
 *
 * | Offset | Size | Meaning                                         |
 * |-------:|-----:|-------------------------------------------------|
 * |    0x0 |    4 | u32 LE — unknown (gap)                          |
 * |    0x4 |    4 | u32 LE — page_index                             |
 * |    0x8 |    4 | u32 LE — type                                   |
 * |    0xc |    4 | u32 LE — next_page (0xFFFFFFFF = none)          |
 * |   0x10 |    4 | u32 LE — unknown                                |
 * |   0x14 |    2 | u16 LE — unknown                                |
 * |   0x16 |    2 | u16 LE — unknown                                |
 * |   0x18 |    1 | u8 — num_rows_small (used for heap pages)       |
 * |   0x19 |    1 | u8 — unknown                                    |
 * |   0x1a |    1 | u8 — unknown                                    |
 * |   0x1b |    1 | u8 — page_flags                                 |
 * |   0x1c |    2 | u16 LE — free_size                              |
 * |   0x1e |    2 | u16 LE — used_size                              |
 * |   0x20 |    2 | u16 LE — unknown                                |
 * |   0x22 |    2 | u16 LE — num_rows_large (total rows)            |
 * |   0x24 |    2 | u16 LE — unknown                                |
 * |   0x26 |    2 | u16 LE — unknown                                |
 * |   0x28 |  var | row_offset groups + row data                    |
 *
 * **Row offset groups:**
 * Each group: u16 LE presence_flags, then up to 16 u16 LE offsets.
 * The number of groups = ceil(num_rows / 16). Each row offset is
 * relative to the page start (offset 0x00 of the page). A set bit in
 * presence_flags means the corresponding row slot is occupied.
 *
 * **Track row layout** (table type 0, variable-length strings via
 * DeviceSQL offset pointers):
 *
 * Strings in rows use a "DeviceSQL string" encoding: each string field
 * stores a u16 LE offset from the row start to the string data. The
 * string data has a 1-4 byte header indicating encoding (ASCII or
 * UTF-16LE) and length.
 *
 * Sources: `rekordbox_pdb.ksy`, Deep Symmetry "DJ Link" protocol analysis.
 */

import type { TrackMetadata } from './types.js';

// ---- Byte helpers (little-endian) ----

function readU8(buf: Uint8Array, offset: number): number {
  return buf[offset] ?? 0;
}

function readU16LE(buf: Uint8Array, offset: number): number {
  return ((buf[offset + 1] ?? 0) << 8) | (buf[offset] ?? 0);
}

function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    (((buf[offset + 3] ?? 0) << 24) |
      ((buf[offset + 2] ?? 0) << 16) |
      ((buf[offset + 1] ?? 0) << 8) |
      (buf[offset] ?? 0)) >>>
    0
  );
}

// ---- File header ----

const FILE_HEADER_SIZE = 0x1c;
const OFFSET_PAGE_SIZE = 0x04;
const OFFSET_NUM_TABLES = 0x08;

// ---- Table pointer ----

const TABLE_PTR_SIZE = 12;
const TABLE_PTR_OFFSET_FIRST_PAGE = 0x00;
const TABLE_PTR_OFFSET_LAST_PAGE = 0x04;
const TABLE_PTR_OFFSET_TYPE = 0x08;

// ---- Table types ----

const TABLE_TYPE_TRACKS = 0;
const TABLE_TYPE_GENRES = 1;
const TABLE_TYPE_ARTISTS = 2;
const TABLE_TYPE_ALBUMS = 3;
const TABLE_TYPE_LABELS = 4;
const TABLE_TYPE_KEYS = 5;
const TABLE_TYPE_COLORS = 6;

// ---- Page layout ----

const PAGE_HEADER_SIZE = 0x28;
const PAGE_OFFSET_TYPE = 0x08;
const PAGE_OFFSET_NEXT_PAGE = 0x0c;
const PAGE_OFFSET_NUM_ROWS_SMALL = 0x18;
const PAGE_OFFSET_PAGE_FLAGS = 0x1b;
const PAGE_OFFSET_NUM_ROWS_LARGE = 0x22;
const NO_NEXT_PAGE = 0xffffffff;

/** Page flag: if set, use num_rows_large instead of num_rows_small. */
const PAGE_FLAG_HAS_DATA = 0x40;

// ---- Track row offsets (used fields only) ----

const TRACK_OFFSET_KEY_ID = 0x20;
const TRACK_OFFSET_LABEL_ID = 0x28;
const TRACK_OFFSET_BITRATE = 0x30;
const TRACK_OFFSET_TEMPO = 0x38;
const TRACK_OFFSET_GENRE_ID = 0x3c;
const TRACK_OFFSET_ALBUM_ID = 0x40;
const TRACK_OFFSET_ARTIST_ID = 0x44;
const TRACK_OFFSET_ID = 0x48;
const TRACK_OFFSET_YEAR = 0x50;
const TRACK_OFFSET_DURATION = 0x54;
const TRACK_OFFSET_COLOR_ID = 0x58;
const TRACK_OFFSET_RATING = 0x59;

// String offset pointers within the track row (u16 LE offsets from
// row start pointing to DeviceSQL string data):
const TRACK_STRING_ANLZ_PATH = 0x78;
const TRACK_STRING_COMMENT = 0x7c;
const TRACK_STRING_TITLE = 0x7e;

// ---- DeviceSQL string decoding ----

/**
 * Read a DeviceSQL encoded string from a row buffer.
 *
 * DeviceSQL strings have a small header:
 * - If first byte has bit 6 set: "long" header (4 bytes: flag, length_u16_le, data)
 * - Otherwise: "short" header (1–2 bytes depending on encoding)
 *
 * Encoding indicator (after adjusting for header):
 * - 0x03 or 0x90 = ASCII (1 byte per char)
 * - 0x40 = UTF-16LE (2 bytes per char)
 *
 * The offset is from the row start.
 */
function readDeviceSqlString(row: Uint8Array, stringOffset: number): string {
  if (stringOffset === 0 || stringOffset >= row.length) return '';

  const firstByte = row[stringOffset] ?? 0;

  // Check for "long" header (bit 6 set = 0x40 flag in the descriptor).
  // Per rekordbox_pdb.ksy: device_sql_long_ascii / device_sql_long_utf16le
  // have a u8 descriptor where bit 6 distinguishes encoding.
  // But the actual encoding is:
  // - Byte 0: if >= 0x40 → check further
  //   - 0x40 = UTF-16LE "short" (2 bytes header: 0x40, then length in chars)
  //   - 0x90 = ASCII "short" (1 byte header, rest is ASCII)
  //   - 0x03 = ASCII "short"
  //
  // Actually the Kaitai spec distinguishes by the "length_and_kind" byte:
  //   Bit 6 set → "isascii" switch:
  //     if true  → device_sql_long_ascii (body after 4-byte header)
  //     if false → device_sql_long_utf16le (body after 4-byte header)
  //   Bit 6 not set → "short" form:
  //     0x40 → UTF-16LE, next byte = length
  //     0x90/0x03 → ASCII, data follows immediately
  //
  // Simplified approach: just check the header byte and decode accordingly.

  if (firstByte === 0x26 || firstByte === 0x06) {
    // "Long" string with 4-byte header.
    // Byte 0: descriptor, byte 1-2: u16 LE length in bytes, byte 3: encoding
    if (stringOffset + 4 > row.length) return '';
    const lenBytes = readU16LE(row, stringOffset + 1);
    const encoding = row[stringOffset + 3] ?? 0;
    const dataStart = stringOffset + 4;
    const dataEnd = Math.min(dataStart + lenBytes, row.length);
    const data = row.subarray(dataStart, dataEnd);

    if (encoding === 0x04) {
      // UTF-16LE
      return decodeUtf16LE(data);
    }
    // ASCII
    return decodeAscii(data);
  }

  if (firstByte === 0x40) {
    // UTF-16LE "short" form: byte 0 = 0x40, byte 1 = length in chars
    const lenChars = row[stringOffset + 1] ?? 0;
    const dataStart = stringOffset + 2;
    const dataEnd = Math.min(dataStart + lenChars * 2, row.length);
    return decodeUtf16LE(row.subarray(dataStart, dataEnd));
  }

  if (firstByte === 0x90 || firstByte === 0x03) {
    // ASCII "short" form: byte 0 = 0x90/0x03, remaining bytes are ASCII.
    // Length is determined by the row boundary or a NUL terminator.
    const dataStart = stringOffset + 1;
    return decodeAscii(row.subarray(dataStart));
  }

  // Try treating as "isascii" long form (bit 6 set in first byte).
  if ((firstByte & 0x40) !== 0) {
    // Long ASCII: 4-byte header
    if (stringOffset + 4 > row.length) return '';
    const lenBytes = readU16LE(row, stringOffset + 1);
    const dataStart = stringOffset + 4;
    const dataEnd = Math.min(dataStart + lenBytes, row.length);
    return decodeAscii(row.subarray(dataStart, dataEnd));
  }

  // Unknown encoding — try ASCII.
  return decodeAscii(row.subarray(stringOffset + 1));
}

function decodeAscii(buf: Uint8Array): string {
  const chars: string[] = [];
  for (const byte of buf) {
    if (byte === 0) break;
    chars.push(String.fromCharCode(byte));
  }
  return chars.join('');
}

function decodeUtf16LE(buf: Uint8Array): string {
  const chars: string[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = ((buf[i + 1] ?? 0) << 8) | (buf[i] ?? 0);
    if (code === 0) break;
    chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

/** Encode a string as a DeviceSQL "short ASCII" string (0x90 header). */
export function encodeDeviceSqlString(
  str: string,
  encoding: 'ascii' | 'utf16le' = 'ascii',
): Uint8Array {
  if (encoding === 'utf16le') {
    // Long UTF-16LE: 0x06, u16 LE length_in_bytes, 0x04, then UTF-16LE data
    const lenBytes = str.length * 2;
    const buf = new Uint8Array(4 + lenBytes);
    buf[0] = 0x06;
    buf[1] = lenBytes & 0xff;
    buf[2] = (lenBytes >>> 8) & 0xff;
    buf[3] = 0x04;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      buf[4 + i * 2] = code & 0xff;
      buf[4 + i * 2 + 1] = (code >>> 8) & 0xff;
    }
    return buf;
  }
  // Short ASCII: 0x90, then ASCII bytes + NUL terminator
  const buf = new Uint8Array(1 + str.length + 1);
  buf[0] = 0x90;
  for (let i = 0; i < str.length; i++) {
    buf[1 + i] = str.charCodeAt(i);
  }
  // Trailing NUL is already 0x00 from Uint8Array init.
  return buf;
}

// ---- Table/page structures ----

interface TablePointer {
  firstPage: number;
  lastPage: number;
  type: number;
}

interface PageInfo {
  type: number;
  nextPage: number;
  numRows: number;
  flags: number;
  /** Byte offset of this page within the file. */
  fileOffset: number;
}

// ---- Lookup table types ----

interface NameRow {
  id: number;
  name: string;
}

/** A raw track row before resolving foreign keys. */
interface RawTrackRow {
  id: number;
  artistId: number;
  albumId: number;
  genreId: number;
  keyId: number;
  labelId: number;
  colorId: number;
  title: string;
  comment: string;
  anlzPath: string;
  bpm: number;
  duration: number;
  rating: number;
  year: number;
  bitrate: number;
}

// ---- Page walking ----

function readTablePointers(buf: Uint8Array, numTables: number): TablePointer[] {
  const ptrs: TablePointer[] = [];
  for (let i = 0; i < numTables; i++) {
    const base = FILE_HEADER_SIZE + i * TABLE_PTR_SIZE;
    if (base + TABLE_PTR_SIZE > buf.length) break;
    ptrs.push({
      firstPage: readU32LE(buf, base + TABLE_PTR_OFFSET_FIRST_PAGE),
      lastPage: readU32LE(buf, base + TABLE_PTR_OFFSET_LAST_PAGE),
      type: readU32LE(buf, base + TABLE_PTR_OFFSET_TYPE),
    });
  }
  return ptrs;
}

function readPageHeader(buf: Uint8Array, pageOffset: number): PageInfo | null {
  if (pageOffset + PAGE_HEADER_SIZE > buf.length) return null;

  const flags = readU8(buf, pageOffset + PAGE_OFFSET_PAGE_FLAGS);
  const numRows =
    flags & PAGE_FLAG_HAS_DATA
      ? readU16LE(buf, pageOffset + PAGE_OFFSET_NUM_ROWS_LARGE)
      : readU8(buf, pageOffset + PAGE_OFFSET_NUM_ROWS_SMALL);

  return {
    type: readU32LE(buf, pageOffset + PAGE_OFFSET_TYPE),
    nextPage: readU32LE(buf, pageOffset + PAGE_OFFSET_NEXT_PAGE),
    numRows,
    flags,
    fileOffset: pageOffset,
  };
}

/**
 * Read row offsets from a page. Each group of 16 rows has:
 * - u16 LE presence_flags (1 bit per row: bit set = row present)
 * - up to 16 × u16 LE row offsets (from page start)
 *
 * The groups start at pageOffset + PAGE_HEADER_SIZE.
 */
function readRowOffsets(buf: Uint8Array, pageOffset: number, numRows: number): number[] {
  const offsets: number[] = [];
  const numGroups = Math.ceil(numRows / 16) || 0;
  let groupBase = pageOffset + PAGE_HEADER_SIZE;

  for (let g = 0; g < numGroups; g++) {
    if (groupBase + 2 > buf.length) break;
    const presenceFlags = readU16LE(buf, groupBase);
    groupBase += 2;

    const rowsInGroup = Math.min(16, numRows - g * 16);
    for (let r = 0; r < rowsInGroup; r++) {
      if (groupBase + 2 > buf.length) break;
      const rowOffset = readU16LE(buf, groupBase);
      groupBase += 2;

      // Only include present rows.
      if (presenceFlags & (1 << r)) {
        offsets.push(pageOffset + rowOffset);
      }
    }
  }

  return offsets;
}

/**
 * Iterate all rows of a given table type across its page chain.
 * Calls `visitor` with each row's absolute offset and the page size.
 */
function walkTableRows(
  buf: Uint8Array,
  tablePtr: TablePointer,
  pageSize: number,
  visitor: (rowOffset: number, pageEnd: number) => void,
): void {
  let pageIndex = tablePtr.firstPage;
  const visited = new Set<number>();

  while (pageIndex !== NO_NEXT_PAGE) {
    if (visited.has(pageIndex)) break; // Cycle guard.
    visited.add(pageIndex);

    const pageOffset = pageIndex * pageSize;
    const page = readPageHeader(buf, pageOffset);
    if (!page) break;

    // Skip pages that don't have data.
    if (page.flags & PAGE_FLAG_HAS_DATA) {
      const rowOffsets = readRowOffsets(buf, pageOffset, page.numRows);
      const pageEnd = pageOffset + pageSize;
      for (const rowOfs of rowOffsets) {
        if (rowOfs >= pageOffset && rowOfs < pageEnd) {
          visitor(rowOfs, pageEnd);
        }
      }
    }

    pageIndex = page.nextPage;
  }
}

// ---- Row parsers ----

/**
 * Read a "name" row (artists, genres, albums, labels, keys).
 *
 * Different table types have slightly different layouts, but they all
 * store an ID and a name string. We parameterize the offsets.
 */
function readNameRow(
  buf: Uint8Array,
  rowOffset: number,
  pageEnd: number,
  idOffset: number,
  nameOfsOffset: number,
  nameOfsIsU8: boolean,
): NameRow | null {
  if (rowOffset + idOffset + 4 > pageEnd) return null;
  const id = readU32LE(buf, rowOffset + idOffset);

  let nameStringOffset: number;
  if (nameOfsIsU8) {
    // The u8 at nameOfsOffset is the offset from row start to the name string.
    if (rowOffset + nameOfsOffset + 1 > pageEnd) return null;
    nameStringOffset = readU8(buf, rowOffset + nameOfsOffset);
  } else {
    if (rowOffset + nameOfsOffset + 2 > pageEnd) return null;
    nameStringOffset = readU16LE(buf, rowOffset + nameOfsOffset);
  }

  const rowSlice = buf.subarray(rowOffset, pageEnd);
  const name = readDeviceSqlString(rowSlice, nameStringOffset);

  return { id, name };
}

function readTrackRow(buf: Uint8Array, rowOffset: number, pageEnd: number): RawTrackRow | null {
  // Minimum track row size is ~0x86 bytes.
  if (rowOffset + 0x86 > pageEnd) return null;

  const rowSlice = buf.subarray(rowOffset, pageEnd);

  const id = readU32LE(buf, rowOffset + TRACK_OFFSET_ID);
  const artistId = readU32LE(buf, rowOffset + TRACK_OFFSET_ARTIST_ID);
  const albumId = readU32LE(buf, rowOffset + TRACK_OFFSET_ALBUM_ID);
  const genreId = readU32LE(buf, rowOffset + TRACK_OFFSET_GENRE_ID);
  const keyId = readU32LE(buf, rowOffset + TRACK_OFFSET_KEY_ID);
  const labelId = readU32LE(buf, rowOffset + TRACK_OFFSET_LABEL_ID);
  const colorId = readU8(buf, rowOffset + TRACK_OFFSET_COLOR_ID);
  const bpmRaw = readU32LE(buf, rowOffset + TRACK_OFFSET_TEMPO);
  const duration = readU16LE(buf, rowOffset + TRACK_OFFSET_DURATION);
  const rating = readU8(buf, rowOffset + TRACK_OFFSET_RATING);
  const year = readU16LE(buf, rowOffset + TRACK_OFFSET_YEAR);
  const bitrate = readU32LE(buf, rowOffset + TRACK_OFFSET_BITRATE);

  // Read string fields via their u16 LE offset pointers.
  const titleOfs = readU16LE(rowSlice, TRACK_STRING_TITLE);
  const commentOfs = readU16LE(rowSlice, TRACK_STRING_COMMENT);
  const anlzPathOfs = readU16LE(rowSlice, TRACK_STRING_ANLZ_PATH);

  const title = readDeviceSqlString(rowSlice, titleOfs);
  const comment = readDeviceSqlString(rowSlice, commentOfs);
  const anlzPath = readDeviceSqlString(rowSlice, anlzPathOfs);

  return {
    id,
    artistId,
    albumId,
    genreId,
    keyId,
    labelId,
    colorId,
    title,
    comment,
    anlzPath,
    bpm: bpmRaw / 100,
    duration,
    rating,
    year,
    bitrate,
  };
}

// ---- Public API ----

/** Parsed PDB database — lookup tables resolved, tracks hydrated. */
export interface PdbDatabase {
  readonly tracks: readonly TrackMetadata[];
  readonly trackById: ReadonlyMap<number, TrackMetadata>;
}

/**
 * Parse a rekordbox PDB database file.
 *
 * @param buf — the complete file buffer
 * @returns parsed database, or null if the file is malformed
 */
export function parsePdb(buf: Uint8Array): PdbDatabase | null {
  if (buf.length < FILE_HEADER_SIZE) return null;

  const pageSize = readU32LE(buf, OFFSET_PAGE_SIZE);
  const numTables = readU32LE(buf, OFFSET_NUM_TABLES);

  if (pageSize === 0 || numTables === 0) return null;

  const tablePtrs = readTablePointers(buf, numTables);

  // Build lookup tables first.
  const artists = new Map<number, string>();
  const albums = new Map<number, string>();
  const genres = new Map<number, string>();
  const keys = new Map<number, string>();
  const labels = new Map<number, string>();
  const colors = new Map<number, string>();

  for (const ptr of tablePtrs) {
    switch (ptr.type) {
      case TABLE_TYPE_ARTISTS:
        walkTableRows(buf, ptr, pageSize, (rowOfs, pageEnd) => {
          // Artist row: [u16 subtype, u16 index_shift, u32 id, u8 ofs_name_near, u8 name_ofs]
          const row = readNameRow(buf, rowOfs, pageEnd, 0x04, 0x09, true);
          if (row) artists.set(row.id, row.name);
        });
        break;

      case TABLE_TYPE_ALBUMS:
        walkTableRows(buf, ptr, pageSize, (rowOfs, pageEnd) => {
          // Album row: [u16 unknown, u16 shift, u32 artist_id, u32 id, u8 unknown, u8 ofs_name]
          const row = readNameRow(buf, rowOfs, pageEnd, 0x08, 0x0d, true);
          if (row) albums.set(row.id, row.name);
        });
        break;

      case TABLE_TYPE_GENRES:
        walkTableRows(buf, ptr, pageSize, (rowOfs, pageEnd) => {
          // Genre row: [u32 id, u8 ofs_name]
          const row = readNameRow(buf, rowOfs, pageEnd, 0x00, 0x04, true);
          if (row) genres.set(row.id, row.name);
        });
        break;

      case TABLE_TYPE_KEYS:
        walkTableRows(buf, ptr, pageSize, (rowOfs, pageEnd) => {
          // Key row: [u32 id, u8 ofs_name]
          const row = readNameRow(buf, rowOfs, pageEnd, 0x00, 0x04, true);
          if (row) keys.set(row.id, row.name);
        });
        break;

      case TABLE_TYPE_LABELS:
        walkTableRows(buf, ptr, pageSize, (rowOfs, pageEnd) => {
          // Label row: [u32 id, u8 ofs_name]
          const row = readNameRow(buf, rowOfs, pageEnd, 0x00, 0x04, true);
          if (row) labels.set(row.id, row.name);
        });
        break;

      case TABLE_TYPE_COLORS:
        walkTableRows(buf, ptr, pageSize, (rowOfs, pageEnd) => {
          // Color row: a bit different — but same concept
          // [u32 unknown, u8 ofs_name, u16 id]
          // Actually per spec: [u32 _unknown, u8 ofs_name]
          // id is an auto-increment, we use the offset-based id
          if (rowOfs + 7 > pageEnd) return;
          const id = readU8(buf, rowOfs + 0x05);
          const nameOfs = readU8(buf, rowOfs + 0x04);
          const rowSlice = buf.subarray(rowOfs, pageEnd);
          const name = readDeviceSqlString(rowSlice, nameOfs);
          colors.set(id, name);
        });
        break;
    }
  }

  // Now parse tracks.
  const tracks: TrackMetadata[] = [];
  const trackById = new Map<number, TrackMetadata>();

  for (const ptr of tablePtrs) {
    if (ptr.type !== TABLE_TYPE_TRACKS) continue;

    walkTableRows(buf, ptr, pageSize, (rowOfs, pageEnd) => {
      const raw = readTrackRow(buf, rowOfs, pageEnd);
      if (!raw) return;

      const track: TrackMetadata = {
        trackId: raw.id,
        title: raw.title,
        artist: artists.get(raw.artistId) ?? '',
        album: albums.get(raw.albumId) ?? '',
        genre: genres.get(raw.genreId) ?? '',
        label: labels.get(raw.labelId) ?? '',
        key: keys.get(raw.keyId) ?? '',
        bpm: raw.bpm,
        duration: raw.duration,
        rating: raw.rating,
        comment: raw.comment,
        year: raw.year,
        bitrate: raw.bitrate,
        colorId: raw.colorId > 0 ? raw.colorId : null,
        anlzPath: raw.anlzPath,
      };

      tracks.push(track);
      trackById.set(track.trackId, track);
    });
  }

  return { tracks, trackById };
}

// ---- Builder (for round-trip testing) ----

/** Options for building a test PDB file. */
export interface BuildPdbOptions {
  readonly pageSize?: number;
  readonly tracks?: readonly BuildPdbTrackOptions[];
  readonly artists?: readonly NameRow[];
  readonly albums?: readonly NameRow[];
  readonly genres?: readonly NameRow[];
  readonly keys?: readonly NameRow[];
  readonly labels?: readonly NameRow[];
}

export interface BuildPdbTrackOptions {
  readonly id: number;
  readonly title: string;
  readonly artistId?: number;
  readonly albumId?: number;
  readonly genreId?: number;
  readonly keyId?: number;
  readonly labelId?: number;
  readonly colorId?: number;
  readonly bpm?: number;
  readonly duration?: number;
  readonly rating?: number;
  readonly year?: number;
  readonly bitrate?: number;
  readonly comment?: string;
  readonly anlzPath?: string;
}

function writeU8(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
}

function writeU16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * Build a minimal PDB file for testing.
 *
 * Creates one page per table type that has data. All lookup tables use
 * simple "genre-style" rows (u32 id, u8 name_offset) except artists
 * and albums which have their own layouts.
 */
export function buildPdb(options: BuildPdbOptions = {}): Uint8Array {
  const pageSize = options.pageSize ?? 4096;
  const tracks = options.tracks ?? [];
  const artists = options.artists ?? [];
  const albums = options.albums ?? [];
  const genres = options.genres ?? [];
  const keys = options.keys ?? [];
  const labels = options.labels ?? [];

  // Figure out which tables we need.
  const tables: { type: number; rows: Uint8Array[] }[] = [];

  if (genres.length > 0) {
    tables.push({
      type: TABLE_TYPE_GENRES,
      rows: genres.map((g) => buildGenreRow(g.id, g.name)),
    });
  }
  if (artists.length > 0) {
    tables.push({
      type: TABLE_TYPE_ARTISTS,
      rows: artists.map((a) => buildArtistRow(a.id, a.name)),
    });
  }
  if (albums.length > 0) {
    tables.push({
      type: TABLE_TYPE_ALBUMS,
      rows: albums.map((a) => buildAlbumRow(a.id, a.name)),
    });
  }
  if (keys.length > 0) {
    tables.push({
      type: TABLE_TYPE_KEYS,
      rows: keys.map((k) => buildGenreRow(k.id, k.name)),
    });
  }
  if (labels.length > 0) {
    tables.push({
      type: TABLE_TYPE_LABELS,
      rows: labels.map((l) => buildGenreRow(l.id, l.name)),
    });
  }
  if (tracks.length > 0) {
    tables.push({
      type: TABLE_TYPE_TRACKS,
      rows: tracks.map((t) => buildTrackRow(t)),
    });
  }

  const numTables = tables.length;
  // Total pages: 1 header page + 1 page per table.
  const numPages = 1 + numTables;
  const fileSize = numPages * pageSize;
  const buf = new Uint8Array(fileSize);

  // File header (in page 0).
  writeU32LE(buf, 0x00, 0); // unknown
  writeU32LE(buf, OFFSET_PAGE_SIZE, pageSize);
  writeU32LE(buf, OFFSET_NUM_TABLES, numTables);
  writeU32LE(buf, 0x0c, numPages); // next_unused_page
  writeU32LE(buf, 0x10, 0); // unknown
  writeU32LE(buf, 0x14, 0); // sequence

  // Table pointers.
  for (let i = 0; i < numTables; i++) {
    const table = tables[i];
    if (!table) continue;
    const pageIdx = i + 1; // Page 0 is the header.
    const base = FILE_HEADER_SIZE + i * TABLE_PTR_SIZE;
    writeU32LE(buf, base + TABLE_PTR_OFFSET_FIRST_PAGE, pageIdx);
    writeU32LE(buf, base + TABLE_PTR_OFFSET_LAST_PAGE, pageIdx);
    writeU32LE(buf, base + TABLE_PTR_OFFSET_TYPE, table.type);
  }

  // Build each table's page.
  for (let i = 0; i < numTables; i++) {
    const table = tables[i];
    if (!table) continue;
    const pageIdx = i + 1;
    const pageOffset = pageIdx * pageSize;

    buildPage(buf, pageOffset, pageSize, table.type, table.rows);
  }

  return buf;
}

function buildPage(
  buf: Uint8Array,
  pageOffset: number,
  pageSize: number,
  tableType: number,
  rows: Uint8Array[],
): void {
  // Page header.
  writeU32LE(buf, pageOffset + 0x04, pageOffset / pageSize); // page_index
  writeU32LE(buf, pageOffset + PAGE_OFFSET_TYPE, tableType);
  writeU32LE(buf, pageOffset + PAGE_OFFSET_NEXT_PAGE, NO_NEXT_PAGE);
  writeU8(buf, pageOffset + PAGE_OFFSET_NUM_ROWS_SMALL, Math.min(rows.length, 255));
  writeU8(buf, pageOffset + PAGE_OFFSET_PAGE_FLAGS, PAGE_FLAG_HAS_DATA);
  writeU16LE(buf, pageOffset + PAGE_OFFSET_NUM_ROWS_LARGE, rows.length);

  // Row offset groups.
  const numGroups = Math.ceil(rows.length / 16) || 1;
  let groupOffset = pageOffset + PAGE_HEADER_SIZE;

  // Place rows at the end of the page, growing backwards (like the real format).
  // But for simplicity in testing, we'll place them after the offset groups, growing forward.
  const offsetSectionSize = numGroups * (2 + 16 * 2); // worst case
  let rowDataOffset = pageOffset + PAGE_HEADER_SIZE + offsetSectionSize;

  // First pass: assign row offsets.
  const rowOffsets: number[] = [];
  for (const row of rows) {
    rowOffsets.push(rowDataOffset - pageOffset); // offset from page start
    // Copy row data.
    buf.set(row, rowDataOffset);
    rowDataOffset += row.length;
  }

  // Second pass: write offset groups.
  for (let g = 0; g < numGroups; g++) {
    const rowsInGroup = Math.min(16, rows.length - g * 16);
    let presenceFlags = 0;
    for (let r = 0; r < rowsInGroup; r++) {
      presenceFlags |= 1 << r;
    }
    writeU16LE(buf, groupOffset, presenceFlags);
    groupOffset += 2;

    for (let r = 0; r < 16; r++) {
      const rowIdx = g * 16 + r;
      if (rowIdx < rowOffsets.length) {
        const ofs = rowOffsets[rowIdx];
        if (ofs !== undefined) {
          writeU16LE(buf, groupOffset, ofs);
        }
      }
      groupOffset += 2;
    }
  }
}

// ---- Row builders ----

/** Build a genre/key/label row: [u32 id, u8 name_ofs, ...name_string]. */
function buildGenreRow(id: number, name: string): Uint8Array {
  const nameStr = encodeDeviceSqlString(name);
  const buf = new Uint8Array(5 + nameStr.length);
  writeU32LE(buf, 0x00, id);
  writeU8(buf, 0x04, 5); // name offset = 5 (right after the header)
  buf.set(nameStr, 5);
  return buf;
}

/** Build an artist row: [u16 subtype, u16 index_shift, u32 id, u8 ofs_name_near, u8 name_ofs, ...name_string]. */
function buildArtistRow(id: number, name: string): Uint8Array {
  const nameStr = encodeDeviceSqlString(name);
  const nameOfs = 0x0a; // 10 bytes into the row
  const buf = new Uint8Array(nameOfs + nameStr.length);
  writeU16LE(buf, 0x00, 0x60); // subtype
  writeU16LE(buf, 0x02, 0); // index_shift
  writeU32LE(buf, 0x04, id);
  writeU8(buf, 0x08, nameOfs); // ofs_name_near (unused by us, but must be valid)
  writeU8(buf, 0x09, nameOfs); // name_ofs
  buf.set(nameStr, nameOfs);
  return buf;
}

/** Build an album row: [u16 unknown, u16 shift, u32 artist_id, u32 id, u8 unknown, u8 ofs_name, ...name_string]. */
function buildAlbumRow(id: number, name: string, artistId = 0): Uint8Array {
  const nameStr = encodeDeviceSqlString(name);
  const nameOfs = 0x0e; // 14 bytes into the row
  const buf = new Uint8Array(nameOfs + nameStr.length);
  writeU16LE(buf, 0x00, 0x80); // unknown
  writeU16LE(buf, 0x02, 0); // index_shift
  writeU32LE(buf, 0x04, artistId);
  writeU32LE(buf, 0x08, id);
  writeU8(buf, 0x0c, 0); // unknown
  writeU8(buf, 0x0d, nameOfs); // ofs_name
  buf.set(nameStr, nameOfs);
  return buf;
}

/** Build a track row. */
function buildTrackRow(opts: BuildPdbTrackOptions): Uint8Array {
  // We need at least 0x86 bytes for the fixed fields, then string data after.
  const titleStr = encodeDeviceSqlString(opts.title);
  const commentStr = encodeDeviceSqlString(opts.comment ?? '');
  const anlzPathStr = encodeDeviceSqlString(opts.anlzPath ?? '');

  // Fixed part is 0x86 bytes, then strings follow.
  const fixedSize = 0x86;
  const totalSize = fixedSize + titleStr.length + commentStr.length + anlzPathStr.length;
  const buf = new Uint8Array(totalSize);

  // Track fixed fields.
  writeU32LE(buf, TRACK_OFFSET_ID, opts.id);
  writeU32LE(buf, TRACK_OFFSET_ARTIST_ID, opts.artistId ?? 0);
  writeU32LE(buf, TRACK_OFFSET_ALBUM_ID, opts.albumId ?? 0);
  writeU32LE(buf, TRACK_OFFSET_GENRE_ID, opts.genreId ?? 0);
  writeU32LE(buf, TRACK_OFFSET_KEY_ID, opts.keyId ?? 0);
  writeU32LE(buf, TRACK_OFFSET_LABEL_ID, opts.labelId ?? 0);
  writeU8(buf, TRACK_OFFSET_COLOR_ID, opts.colorId ?? 0);
  writeU32LE(buf, TRACK_OFFSET_TEMPO, Math.round((opts.bpm ?? 0) * 100));
  writeU16LE(buf, TRACK_OFFSET_DURATION, opts.duration ?? 0);
  writeU8(buf, TRACK_OFFSET_RATING, opts.rating ?? 0);
  writeU16LE(buf, TRACK_OFFSET_YEAR, opts.year ?? 0);
  writeU32LE(buf, TRACK_OFFSET_BITRATE, opts.bitrate ?? 0);

  // String data: lay them out sequentially after the fixed fields.
  let strOffset = fixedSize;

  // Title string.
  writeU16LE(buf, TRACK_STRING_TITLE, strOffset);
  buf.set(titleStr, strOffset);
  strOffset += titleStr.length;

  // Comment string.
  writeU16LE(buf, TRACK_STRING_COMMENT, strOffset);
  buf.set(commentStr, strOffset);
  strOffset += commentStr.length;

  // ANLZ path string.
  writeU16LE(buf, TRACK_STRING_ANLZ_PATH, strOffset);
  buf.set(anlzPathStr, strOffset);

  return buf;
}

/**
 * Derive the .EXT analysis file path from a .DAT path.
 *
 * Rekordbox stores the .DAT path in the track row. The .EXT file is
 * at the same path with the extension replaced. If the path doesn't
 * end with `.DAT`, returns null.
 */
export function anlzExtPath(datPath: string): string | null {
  if (datPath.toUpperCase().endsWith('.DAT')) {
    return `${datPath.slice(0, -4)}.EXT`;
  }
  return null;
}
