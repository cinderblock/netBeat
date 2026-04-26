import { describe, expect, test } from 'bun:test';
import { buildBeatGridSection } from '../../src/metadata/beat-grid.ts';
import { buildCuesExtendedSection, buildCuesLegacySection } from '../../src/metadata/cues.ts';
import type { MediaReader } from '../../src/metadata/media-reader.ts';
import { MetadataStore } from '../../src/metadata/media-reader.ts';
import { buildPdb } from '../../src/metadata/pdb.ts';
import { buildPhrasesSection } from '../../src/metadata/phrases.ts';
import type { Phrase } from '../../src/metadata/types.ts';

// ---- In-memory MediaReader for testing ----

class MockMediaReader implements MediaReader {
  private files = new Map<string, Uint8Array>();

  addFile(path: string, data: Uint8Array): void {
    this.files.set(path, data);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error(`File not found: ${path}`);
    return data;
  }

  async close(): Promise<void> {}
}

/** Build a minimal PMAI file envelope. */
function buildAnlzEnvelope(...sections: Uint8Array[]): Uint8Array {
  let totalLen = 12; // PMAI header
  for (const s of sections) totalLen += s.length;

  const buf = new Uint8Array(totalLen);
  // PMAI magic
  buf[0] = 0x50;
  buf[1] = 0x4d;
  buf[2] = 0x41;
  buf[3] = 0x49;
  // len_header = 12
  buf[7] = 12;
  // len_tag = 12
  buf[11] = 12;

  let offset = 12;
  for (const s of sections) {
    buf.set(s, offset);
    offset += s.length;
  }
  return buf;
}

describe('MetadataStore', () => {
  test('isLoaded is false before loadDatabase', () => {
    const reader = new MockMediaReader();
    const store = new MetadataStore(reader);
    expect(store.isLoaded).toBe(false);
  });

  test('loadDatabase parses PDB and sets isLoaded', async () => {
    const reader = new MockMediaReader();
    const pdb = buildPdb({
      tracks: [{ id: 1, title: 'Track 1' }],
    });
    reader.addFile('/PIONEER/rekordbox/export.pdb', pdb);

    const store = new MetadataStore(reader);
    const count = await store.loadDatabase();
    expect(count).toBe(1);
    expect(store.isLoaded).toBe(true);
  });

  test('getTrackMetadata returns track after loadDatabase', async () => {
    const reader = new MockMediaReader();
    const pdb = buildPdb({
      artists: [{ id: 10, name: 'Artist' }],
      tracks: [{ id: 42, title: 'Song', artistId: 10, bpm: 128 }],
    });
    reader.addFile('/PIONEER/rekordbox/export.pdb', pdb);

    const store = new MetadataStore(reader);
    await store.loadDatabase();

    const meta = store.getTrackMetadata(42);
    expect(meta).not.toBeNull();
    expect(meta?.title).toBe('Song');
    expect(meta?.artist).toBe('Artist');
    expect(meta?.bpm).toBeCloseTo(128, 1);
  });

  test('getTrackMetadata returns null for unknown ID', async () => {
    const reader = new MockMediaReader();
    reader.addFile('/PIONEER/rekordbox/export.pdb', buildPdb({ tracks: [{ id: 1, title: 'X' }] }));

    const store = new MetadataStore(reader);
    await store.loadDatabase();
    expect(store.getTrackMetadata(999)).toBeNull();
  });

  test('getTrackAnalysis returns null for unknown ID', async () => {
    const reader = new MockMediaReader();
    reader.addFile('/PIONEER/rekordbox/export.pdb', buildPdb({ tracks: [{ id: 1, title: 'X' }] }));

    const store = new MetadataStore(reader);
    await store.loadDatabase();
    const result = await store.getTrackAnalysis(999);
    expect(result).toBeNull();
  });

  test('getTrackAnalysis loads .DAT file', async () => {
    const reader = new MockMediaReader();
    const anlzPath = '/PIONEER/USBANLZ/P001/0001.DAT';
    reader.addFile(
      '/PIONEER/rekordbox/export.pdb',
      buildPdb({ tracks: [{ id: 1, title: 'Beat Track', anlzPath }] }),
    );

    // Build a .DAT file with a beat grid.
    const beatGrid = buildBeatGridSection({
      entries: [
        { beatInBar: 1, bpm: 126.0, timeMs: 0 },
        { beatInBar: 2, bpm: 126.0, timeMs: 476 },
      ],
    });
    reader.addFile(anlzPath, buildAnlzEnvelope(beatGrid));

    const store = new MetadataStore(reader);
    await store.loadDatabase();
    const analysis = await store.getTrackAnalysis(1);

    expect(analysis).not.toBeNull();
    expect(analysis?.metadata?.title).toBe('Beat Track');
    expect(analysis?.beatGrid?.length).toBe(2);
    expect(analysis?.beatGrid?.[0]?.bpm).toBeCloseTo(126.0, 2);
  });

  test('getTrackAnalysis loads .EXT file for phrases', async () => {
    const reader = new MockMediaReader();
    const anlzPath = '/PIONEER/USBANLZ/P001/0001.DAT';
    const extPath = '/PIONEER/USBANLZ/P001/0001.EXT';

    reader.addFile(
      '/PIONEER/rekordbox/export.pdb',
      buildPdb({ tracks: [{ id: 1, title: 'EDM Track', anlzPath }] }),
    );

    // .DAT has beat grid.
    reader.addFile(
      anlzPath,
      buildAnlzEnvelope(
        buildBeatGridSection({
          entries: [{ beatInBar: 1, bpm: 128.0, timeMs: 0 }],
        }),
      ),
    );

    // .EXT has phrases.
    const phrases: Phrase[] = [
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
        kind: 'chorus',
        rawKind: 5,
        fillIn: false,
        fillInBeatNumber: null,
      },
    ];
    reader.addFile(
      extPath,
      buildAnlzEnvelope(buildPhrasesSection({ mood: 'high', endBeat: 128, phrases })),
    );

    const store = new MetadataStore(reader);
    await store.loadDatabase();
    const analysis = await store.getTrackAnalysis(1);

    expect(analysis?.phrases).not.toBeNull();
    expect(analysis?.phrases?.mood).toBe('high');
    expect(analysis?.phrases?.phrases.length).toBe(2);
    expect(analysis?.phrases?.phrases[0]?.kind).toBe('intro');
    expect(analysis?.phrases?.phrases[1]?.kind).toBe('chorus');
  });

  test('getTrackAnalysis merges .DAT and .EXT cues without duplicates', async () => {
    const reader = new MockMediaReader();
    const anlzPath = '/PIONEER/USBANLZ/P001/0001.DAT';
    const extPath = '/PIONEER/USBANLZ/P001/0001.EXT';

    reader.addFile(
      '/PIONEER/rekordbox/export.pdb',
      buildPdb({ tracks: [{ id: 1, title: 'Mixed Cues', anlzPath }] }),
    );

    // .DAT has legacy cues.
    reader.addFile(
      anlzPath,
      buildAnlzEnvelope(
        buildCuesLegacySection([
          { type: 'memory', timeMs: 0 },
          { type: 'hotcue', timeMs: 30000, hotCueSlot: 1 },
        ]),
      ),
    );

    // .EXT has extended cues (including hot cue A at same position).
    reader.addFile(
      extPath,
      buildAnlzEnvelope(
        buildCuesExtendedSection([
          { type: 'hotcue', timeMs: 30000, hotCueSlot: 1, comment: 'Drop' },
          { type: 'hotcue', timeMs: 90000, hotCueSlot: 4, comment: 'Break' },
        ]),
      ),
    );

    const store = new MetadataStore(reader);
    await store.loadDatabase();
    const analysis = await store.getTrackAnalysis(1);

    // Extended cues (2) + non-duplicate legacy cues (1 memory cue).
    // The hotcue at 30000 from .DAT should be deduplicated.
    expect(analysis?.cuePoints.length).toBe(3);
    expect(analysis?.cuePoints[0]?.comment).toBe('Drop');
    expect(analysis?.cuePoints[2]?.type).toBe('memory');
  });

  test('getTrackAnalysis caches results', async () => {
    const reader = new MockMediaReader();
    const anlzPath = '/PIONEER/USBANLZ/P001/0001.DAT';

    reader.addFile(
      '/PIONEER/rekordbox/export.pdb',
      buildPdb({ tracks: [{ id: 1, title: 'Cached', anlzPath }] }),
    );
    reader.addFile(
      anlzPath,
      buildAnlzEnvelope(
        buildBeatGridSection({
          entries: [{ beatInBar: 1, bpm: 120.0, timeMs: 0 }],
        }),
      ),
    );

    const store = new MetadataStore(reader);
    await store.loadDatabase();

    const first = await store.getTrackAnalysis(1);
    const second = await store.getTrackAnalysis(1);
    // Should be the exact same object (cached).
    expect(first).toBe(second);
  });

  test('clearCache removes analysis cache but keeps tracks', async () => {
    const reader = new MockMediaReader();
    const anlzPath = '/PIONEER/USBANLZ/P001/0001.DAT';

    reader.addFile(
      '/PIONEER/rekordbox/export.pdb',
      buildPdb({ tracks: [{ id: 1, title: 'Track', anlzPath }] }),
    );
    reader.addFile(
      anlzPath,
      buildAnlzEnvelope(
        buildBeatGridSection({
          entries: [{ beatInBar: 1, bpm: 120.0, timeMs: 0 }],
        }),
      ),
    );

    const store = new MetadataStore(reader);
    await store.loadDatabase();

    const first = await store.getTrackAnalysis(1);
    store.clearCache();
    const second = await store.getTrackAnalysis(1);

    // After clearing, a new analysis object is created.
    expect(first).not.toBe(second);
    // Track metadata is still available.
    expect(store.getTrackMetadata(1)).not.toBeNull();
  });

  test('getTrackAnalysis handles missing .DAT gracefully', async () => {
    const reader = new MockMediaReader();

    reader.addFile(
      '/PIONEER/rekordbox/export.pdb',
      buildPdb({
        tracks: [{ id: 1, title: 'No ANLZ', anlzPath: '/PIONEER/USBANLZ/missing.DAT' }],
      }),
    );

    const store = new MetadataStore(reader);
    await store.loadDatabase();
    const analysis = await store.getTrackAnalysis(1);

    expect(analysis).not.toBeNull();
    expect(analysis?.metadata?.title).toBe('No ANLZ');
    expect(analysis?.beatGrid).toBeNull();
    expect(analysis?.cuePoints).toEqual([]);
    expect(analysis?.phrases).toBeNull();
  });

  test('tracks property returns all loaded tracks', async () => {
    const reader = new MockMediaReader();
    reader.addFile(
      '/PIONEER/rekordbox/export.pdb',
      buildPdb({
        tracks: [
          { id: 1, title: 'A' },
          { id: 2, title: 'B' },
        ],
      }),
    );

    const store = new MetadataStore(reader);
    await store.loadDatabase();
    expect(store.tracks.length).toBe(2);
  });

  test('loadDatabase with mediaRoot prefix', async () => {
    const reader = new MockMediaReader();
    reader.addFile(
      '/C/PIONEER/rekordbox/export.pdb',
      buildPdb({ tracks: [{ id: 1, title: 'X' }] }),
    );

    const store = new MetadataStore(reader);
    const count = await store.loadDatabase('/C');
    expect(count).toBe(1);
  });
});
