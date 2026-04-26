/**
 * Media reader — reads rekordbox PDB + ANLZ files from a mounted
 * filesystem (USB stick, SD card, or rekordbox export directory).
 *
 * This module provides:
 * - `MediaReader` interface — abstraction over I/O (filesystem, NFS)
 * - `FilesystemMediaReader` — reads from local paths via `node:fs`
 * - `MetadataStore` — caching orchestrator that loads PDB + ANLZ files,
 *   resolves track metadata, and caches per-track analysis
 *
 * **Usage:**
 * ```ts
 * const reader = new FilesystemMediaReader();
 * const store = new MetadataStore(reader);
 * await store.loadDatabase('/media/usb');
 * const analysis = await store.getTrackAnalysis(42);
 * ```
 */

import { readFile } from 'node:fs/promises';
import { parseAnlzFile } from './anlz.js';
import { anlzExtPath, parsePdb } from './pdb.js';
import type { AnlzFile, TrackAnalysis, TrackMetadata } from './types.js';

// ---- MediaReader interface ----

/**
 * Abstraction for reading files from a media source.
 * Implemented by FilesystemMediaReader (local) and NfsMediaReader (network).
 */
export interface MediaReader {
  /** Read a file and return its contents. Throws if not found. */
  readFile(path: string): Promise<Uint8Array>;
  /** Clean up any resources (connections, handles). */
  close(): Promise<void>;
}

// ---- FilesystemMediaReader ----

/**
 * Reads files from the local filesystem.
 *
 * The `basePath` is prepended to all paths. For a mounted USB stick at
 * `/media/usb`, set basePath to `/media/usb` and then request paths
 * like `/PIONEER/rekordbox/export.pdb`.
 */
export class FilesystemMediaReader implements MediaReader {
  constructor(private readonly basePath: string = '') {}

  async readFile(path: string): Promise<Uint8Array> {
    const fullPath = this.basePath ? `${this.basePath}${path}` : path;
    const buffer = await readFile(fullPath);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  async close(): Promise<void> {
    // Nothing to clean up for filesystem reads.
  }
}

// ---- MetadataStore ----

/** Standard PDB location on rekordbox-prepared media. */
const PDB_PATH = '/PIONEER/rekordbox/export.pdb';

/**
 * Caching metadata store — loads PDB + ANLZ files, resolves tracks,
 * and caches per-track analysis results.
 */
export class MetadataStore {
  private trackMap = new Map<number, TrackMetadata>();
  private analysisCache = new Map<number, TrackAnalysis>();
  private loaded = false;

  constructor(private readonly reader: MediaReader) {}

  /** Whether the PDB database has been loaded. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /** All tracks in the database. */
  get tracks(): readonly TrackMetadata[] {
    return [...this.trackMap.values()];
  }

  /**
   * Load the PDB database from the media root.
   *
   * @param mediaRoot — root path prefix (e.g. '' for a reader that
   *   already includes the mount point, or '/C' for NFS)
   * @returns the number of tracks found
   */
  async loadDatabase(mediaRoot = ''): Promise<number> {
    const pdbPath = `${mediaRoot}${PDB_PATH}`;
    const pdbData = await this.reader.readFile(pdbPath);
    const db = parsePdb(pdbData);
    if (!db) throw new Error(`Failed to parse PDB at ${pdbPath}`);

    this.trackMap.clear();
    this.analysisCache.clear();

    for (const track of db.tracks) {
      this.trackMap.set(track.trackId, track);
    }

    this.loaded = true;
    return db.tracks.length;
  }

  /** Look up track metadata by ID (PDB must be loaded). */
  getTrackMetadata(trackId: number): TrackMetadata | null {
    return this.trackMap.get(trackId) ?? null;
  }

  /**
   * Get full track analysis (metadata + beat grid + cues + phrases).
   *
   * Reads and parses the ANLZ .DAT and .EXT files on first access,
   * then caches the result.
   */
  async getTrackAnalysis(trackId: number): Promise<TrackAnalysis | null> {
    const cached = this.analysisCache.get(trackId);
    if (cached) return cached;

    const metadata = this.trackMap.get(trackId);
    if (!metadata) return null;

    // Parse ANLZ files.
    let datFile: AnlzFile | null = null;
    let extFile: AnlzFile | null = null;

    if (metadata.anlzPath) {
      try {
        const datData = await this.reader.readFile(metadata.anlzPath);
        datFile = parseAnlzFile(datData);
      } catch {
        // .DAT not found — continue without it.
      }

      const extPath = anlzExtPath(metadata.anlzPath);
      if (extPath) {
        try {
          const extData = await this.reader.readFile(extPath);
          extFile = parseAnlzFile(extData);
        } catch {
          // .EXT not found — continue without it.
        }
      }
    }

    // Merge results: prefer .EXT data where available.
    const analysis: TrackAnalysis = {
      metadata,
      beatGrid: extFile?.beatGrid ?? datFile?.beatGrid ?? null,
      cuePoints: [
        ...(extFile?.cuePoints ?? []),
        // Add legacy cues that aren't duplicated by extended cues.
        ...(datFile?.cuePoints ?? []).filter(
          (legacyCue) =>
            !extFile?.cuePoints.some(
              (extCue) => extCue.timeMs === legacyCue.timeMs && extCue.type === legacyCue.type,
            ),
        ),
      ],
      phrases: extFile?.phrases ?? null,
    };

    this.analysisCache.set(trackId, analysis);
    return analysis;
  }

  /** Clear the analysis cache (keeps the PDB track map). */
  clearCache(): void {
    this.analysisCache.clear();
  }
}
