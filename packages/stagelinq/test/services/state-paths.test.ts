import { describe, expect, test } from 'bun:test';
import { deckPaths, defaultStatePaths, mixerPaths } from '../../src/services/state-paths.js';

describe('State paths', () => {
  test('deckPaths generates paths for a specific deck', () => {
    const paths = deckPaths(1);
    expect(paths.length).toBeGreaterThan(0);
    // All paths should reference Deck1
    for (const p of paths) {
      expect(p).toContain('Deck1');
    }
    // Should include essential paths
    expect(paths).toContain('/Engine/Deck1/Play');
    expect(paths).toContain('/Engine/Deck1/CurrentBPM');
    expect(paths).toContain('/Engine/Deck1/Track/SongName');
  });

  test('deckPaths for deck 3', () => {
    const paths = deckPaths(3);
    expect(paths).toContain('/Engine/Deck3/Play');
    expect(paths).toContain('/Engine/Deck3/Track/ArtistName');
  });

  test('mixerPaths includes crossfader and channel faders', () => {
    const paths = mixerPaths();
    expect(paths).toContain('/Mixer/CrossfaderPosition');
    expect(paths).toContain('/Mixer/NumberOfChannels');
    expect(paths).toContain('/Mixer/CH1faderPosition');
    expect(paths).toContain('/Mixer/CH4faderPosition');
  });

  test('mixerPaths respects channel count', () => {
    const paths = mixerPaths(2);
    expect(paths).toContain('/Mixer/CH1faderPosition');
    expect(paths).toContain('/Mixer/CH2faderPosition');
    expect(paths).not.toContain('/Mixer/CH3faderPosition');
  });

  test('defaultStatePaths generates paths for all decks + mixer', () => {
    const paths = defaultStatePaths(4);
    // Should have paths for decks 1-4
    expect(paths.some((p) => p.includes('Deck1'))).toBe(true);
    expect(paths.some((p) => p.includes('Deck2'))).toBe(true);
    expect(paths.some((p) => p.includes('Deck3'))).toBe(true);
    expect(paths.some((p) => p.includes('Deck4'))).toBe(true);
    // Should have mixer paths
    expect(paths.some((p) => p.includes('Mixer'))).toBe(true);
  });

  test('defaultStatePaths with 2 decks has no Deck3/Deck4', () => {
    const paths = defaultStatePaths(2);
    expect(paths.some((p) => p.includes('Deck1'))).toBe(true);
    expect(paths.some((p) => p.includes('Deck2'))).toBe(true);
    expect(paths.some((p) => p.includes('Deck3'))).toBe(false);
    expect(paths.some((p) => p.includes('Deck4'))).toBe(false);
  });
});
