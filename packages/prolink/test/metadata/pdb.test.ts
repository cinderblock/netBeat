import { describe, expect, test } from 'bun:test';
import { anlzExtPath, buildPdb, parsePdb } from '../../src/metadata/pdb.ts';

describe('parsePdb', () => {
  test('returns null for empty buffer', () => {
    expect(parsePdb(new Uint8Array(0))).toBeNull();
  });

  test('returns null for too-short buffer', () => {
    expect(parsePdb(new Uint8Array(16))).toBeNull();
  });

  test('returns null for zero page size', () => {
    const buf = new Uint8Array(4096);
    // page_size = 0, num_tables = 1
    buf[0x08] = 1;
    expect(parsePdb(buf)).toBeNull();
  });

  test('parses empty database (no tables)', () => {
    const buf = buildPdb({ tracks: [], artists: [], genres: [] });
    const result = parsePdb(buf);
    // No tables → parsePdb returns null because numTables is 0
    // Actually buildPdb with empty arrays won't create tables.
    // Let's verify:
    expect(result).toBeNull();
  });

  test('round-trip: single track with no lookups', () => {
    const buf = buildPdb({
      tracks: [
        {
          id: 42,
          title: 'Test Track',
          bpm: 128.0,
          duration: 300,
          rating: 5,
          year: 2024,
          bitrate: 320,
          comment: 'Great track',
          anlzPath: '/PIONEER/USBANLZ/P001/0001.DAT',
        },
      ],
    });

    const result = parsePdb(buf);
    expect(result).not.toBeNull();
    expect(result?.tracks.length).toBe(1);

    const track = result?.tracks[0];
    expect(track?.trackId).toBe(42);
    expect(track?.title).toBe('Test Track');
    expect(track?.bpm).toBeCloseTo(128.0, 1);
    expect(track?.duration).toBe(300);
    expect(track?.rating).toBe(5);
    expect(track?.year).toBe(2024);
    expect(track?.bitrate).toBe(320);
    expect(track?.comment).toBe('Great track');
    expect(track?.anlzPath).toBe('/PIONEER/USBANLZ/P001/0001.DAT');
  });

  test('round-trip: track with artist lookup', () => {
    const buf = buildPdb({
      artists: [{ id: 10, name: 'Deadmau5' }],
      tracks: [
        {
          id: 1,
          title: 'Strobe',
          artistId: 10,
          bpm: 128.0,
          duration: 600,
        },
      ],
    });

    const result = parsePdb(buf);
    expect(result).not.toBeNull();
    expect(result?.tracks[0]?.artist).toBe('Deadmau5');
  });

  test('round-trip: track with album lookup', () => {
    const buf = buildPdb({
      albums: [{ id: 20, name: 'Random Album Title' }],
      tracks: [
        {
          id: 1,
          title: 'FML',
          albumId: 20,
          bpm: 130.0,
          duration: 420,
        },
      ],
    });

    const result = parsePdb(buf);
    expect(result).not.toBeNull();
    expect(result?.tracks[0]?.album).toBe('Random Album Title');
  });

  test('round-trip: track with genre lookup', () => {
    const buf = buildPdb({
      genres: [{ id: 5, name: 'Techno' }],
      tracks: [
        {
          id: 1,
          title: 'Acid',
          genreId: 5,
          bpm: 140.0,
          duration: 360,
        },
      ],
    });

    const result = parsePdb(buf);
    expect(result).not.toBeNull();
    expect(result?.tracks[0]?.genre).toBe('Techno');
  });

  test('round-trip: track with key lookup', () => {
    const buf = buildPdb({
      keys: [{ id: 3, name: 'Ab' }],
      tracks: [
        {
          id: 1,
          title: 'Drop',
          keyId: 3,
          bpm: 126.0,
          duration: 240,
        },
      ],
    });

    const result = parsePdb(buf);
    expect(result).not.toBeNull();
    expect(result?.tracks[0]?.key).toBe('Ab');
  });

  test('round-trip: track with label lookup', () => {
    const buf = buildPdb({
      labels: [{ id: 7, name: 'Anjunabeats' }],
      tracks: [
        {
          id: 1,
          title: 'Sun & Moon',
          labelId: 7,
          bpm: 138.0,
          duration: 480,
        },
      ],
    });

    const result = parsePdb(buf);
    expect(result).not.toBeNull();
    expect(result?.tracks[0]?.label).toBe('Anjunabeats');
  });

  test('round-trip: multiple tracks', () => {
    const buf = buildPdb({
      artists: [
        { id: 1, name: 'Artist A' },
        { id: 2, name: 'Artist B' },
      ],
      genres: [{ id: 1, name: 'House' }],
      tracks: [
        {
          id: 100,
          title: 'Track One',
          artistId: 1,
          genreId: 1,
          bpm: 124.0,
          duration: 300,
        },
        {
          id: 200,
          title: 'Track Two',
          artistId: 2,
          genreId: 1,
          bpm: 126.5,
          duration: 360,
        },
      ],
    });

    const result = parsePdb(buf);
    expect(result).not.toBeNull();
    expect(result?.tracks.length).toBe(2);

    expect(result?.tracks[0]?.trackId).toBe(100);
    expect(result?.tracks[0]?.title).toBe('Track One');
    expect(result?.tracks[0]?.artist).toBe('Artist A');
    expect(result?.tracks[0]?.genre).toBe('House');

    expect(result?.tracks[1]?.trackId).toBe(200);
    expect(result?.tracks[1]?.title).toBe('Track Two');
    expect(result?.tracks[1]?.artist).toBe('Artist B');
  });

  test('round-trip: full metadata resolution', () => {
    const buf = buildPdb({
      artists: [{ id: 10, name: 'Skrillex' }],
      albums: [{ id: 20, name: 'Scary Monsters' }],
      genres: [{ id: 5, name: 'Dubstep' }],
      keys: [{ id: 8, name: 'Fm' }],
      labels: [{ id: 3, name: 'OWSLA' }],
      tracks: [
        {
          id: 42,
          title: 'Scary Monsters',
          artistId: 10,
          albumId: 20,
          genreId: 5,
          keyId: 8,
          labelId: 3,
          bpm: 140.5,
          duration: 280,
          rating: 4,
          year: 2010,
          bitrate: 320,
          comment: 'Classic',
          anlzPath: '/PIONEER/USBANLZ/P001/0042.DAT',
        },
      ],
    });

    const result = parsePdb(buf);
    expect(result).not.toBeNull();
    const track = result?.tracks[0];
    expect(track?.trackId).toBe(42);
    expect(track?.title).toBe('Scary Monsters');
    expect(track?.artist).toBe('Skrillex');
    expect(track?.album).toBe('Scary Monsters');
    expect(track?.genre).toBe('Dubstep');
    expect(track?.key).toBe('Fm');
    expect(track?.label).toBe('OWSLA');
    expect(track?.bpm).toBeCloseTo(140.5, 1);
    expect(track?.duration).toBe(280);
    expect(track?.rating).toBe(4);
    expect(track?.year).toBe(2010);
    expect(track?.bitrate).toBe(320);
    expect(track?.comment).toBe('Classic');
    expect(track?.anlzPath).toBe('/PIONEER/USBANLZ/P001/0042.DAT');
  });

  test('trackById map is populated', () => {
    const buf = buildPdb({
      tracks: [
        { id: 1, title: 'A' },
        { id: 2, title: 'B' },
        { id: 3, title: 'C' },
      ],
    });

    const result = parsePdb(buf);
    expect(result).not.toBeNull();
    expect(result?.trackById.get(1)?.title).toBe('A');
    expect(result?.trackById.get(2)?.title).toBe('B');
    expect(result?.trackById.get(3)?.title).toBe('C');
    expect(result?.trackById.get(999)).toBeUndefined();
  });

  test('missing foreign key resolves to empty string', () => {
    const buf = buildPdb({
      tracks: [
        {
          id: 1,
          title: 'Orphan',
          artistId: 999,
          genreId: 888,
        },
      ],
    });

    const result = parsePdb(buf);
    expect(result).not.toBeNull();
    expect(result?.tracks[0]?.artist).toBe('');
    expect(result?.tracks[0]?.genre).toBe('');
  });

  test('colorId is null when zero', () => {
    const buf = buildPdb({
      tracks: [{ id: 1, title: 'No Color', colorId: 0 }],
    });

    const result = parsePdb(buf);
    expect(result?.tracks[0]?.colorId).toBeNull();
  });

  test('colorId is preserved when nonzero', () => {
    const buf = buildPdb({
      tracks: [{ id: 1, title: 'Pink', colorId: 3 }],
    });

    const result = parsePdb(buf);
    expect(result?.tracks[0]?.colorId).toBe(3);
  });
});

describe('anlzExtPath', () => {
  test('converts .DAT to .EXT', () => {
    expect(anlzExtPath('/PIONEER/USBANLZ/P001/0001.DAT')).toBe('/PIONEER/USBANLZ/P001/0001.EXT');
  });

  test('handles lowercase .dat', () => {
    expect(anlzExtPath('/path/to/file.dat')).toBe('/path/to/file.EXT');
  });

  test('returns null for non-.DAT path', () => {
    expect(anlzExtPath('/path/to/file.txt')).toBeNull();
  });

  test('returns null for empty path', () => {
    expect(anlzExtPath('')).toBeNull();
  });
});
