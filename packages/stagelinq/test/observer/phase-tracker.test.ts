import { describe, expect, test } from 'bun:test';
import { PhaseTracker } from '../../src/observer/phase-tracker.js';
import type { DeckBeatInfo } from '../../src/services/beat-info.js';

function makeBeatInfo(overrides: Partial<DeckBeatInfo> = {}): DeckBeatInfo {
  return {
    beat: 0,
    totalBeats: 400,
    bpm: 120,
    samples: 0,
    ...overrides,
  };
}

describe('PhaseTracker', () => {
  test('returns null for unknown deck', () => {
    const tracker = new PhaseTracker();
    expect(tracker.getPhase('stagelinq:abc:1')).toBeNull();
  });

  test('returns phase immediately after update (zero elapsed)', () => {
    const clock = 1000;
    const tracker = new PhaseTracker({ now: () => clock });

    tracker.update('deck:1', makeBeatInfo({ beat: 4.0, bpm: 120 }));
    const phase = tracker.getPhase('deck:1');

    expect(phase).not.toBeNull();
    expect(phase?.beat).toBeCloseTo(0, 5); // exactly on the beat
    expect(phase?.beatInBar).toBe(1); // beat 4 mod 4 = 0, +1 = 1
    expect(phase?.bar).toBeCloseTo(0, 5);
    expect(phase?.bpm).toBe(120);
  });

  test('interpolates forward in time', () => {
    let clock = 1000;
    const tracker = new PhaseTracker({ now: () => clock });

    // 120 BPM = 500ms per beat
    tracker.update('deck:1', makeBeatInfo({ beat: 0.0, bpm: 120 }));

    // Advance 250ms → half a beat
    clock = 1250;
    const phase = tracker.getPhase('deck:1');
    expect(phase).not.toBeNull();
    expect(phase?.beat).toBeCloseTo(0.5, 2);
    expect(phase?.beatInBar).toBe(1); // still in beat 0, which is beat-in-bar 1
    expect(phase?.beatElapsed).toBeCloseTo(0.25, 2); // 0.25s
    expect(phase?.beatRemaining).toBeCloseTo(0.25, 2);
  });

  test('beatInBar cycles 1-2-3-4', () => {
    let clock = 1000;
    const tracker = new PhaseTracker({ now: () => clock });

    // 120 BPM = 500ms per beat
    tracker.update('deck:1', makeBeatInfo({ beat: 0.0, bpm: 120 }));

    // Advance to each beat boundary
    const expected = [1, 2, 3, 4, 1];
    for (let i = 0; i < expected.length; i++) {
      clock = 1000 + i * 500 + 10; // just past the beat
      const phase = tracker.getPhase('deck:1');
      expect(phase?.beatInBar).toBe(expected[i]);
    }
  });

  test('bar progresses through [0, 1)', () => {
    let clock = 1000;
    const tracker = new PhaseTracker({ now: () => clock });

    // 120 BPM = 500ms per beat, 2000ms per bar
    tracker.update('deck:1', makeBeatInfo({ beat: 0.0, bpm: 120 }));

    // At beat 0 → bar = 0
    expect(tracker.getPhase('deck:1')?.bar).toBeCloseTo(0, 2);

    // At beat 1 → bar = 0.25
    clock = 1500;
    expect(tracker.getPhase('deck:1')?.bar).toBeCloseTo(0.25, 2);

    // At beat 2 → bar = 0.5
    clock = 2000;
    expect(tracker.getPhase('deck:1')?.bar).toBeCloseTo(0.5, 2);

    // At beat 3 → bar = 0.75
    clock = 2500;
    expect(tracker.getPhase('deck:1')?.bar).toBeCloseTo(0.75, 2);

    // At beat 4 → bar wraps to 0
    clock = 3000;
    expect(tracker.getPhase('deck:1')?.bar).toBeCloseTo(0, 2);
  });

  test('barElapsed and barRemaining are correct', () => {
    let clock = 1000;
    const tracker = new PhaseTracker({ now: () => clock });

    // 120 BPM = 0.5s per beat, 2.0s per bar
    tracker.update('deck:1', makeBeatInfo({ beat: 0.0, bpm: 120 }));

    // Advance 1 beat (0.5s into bar)
    clock = 1500;
    const phase = tracker.getPhase('deck:1');
    expect(phase?.barElapsed).toBeCloseTo(0.5, 2);
    expect(phase?.barRemaining).toBeCloseTo(1.5, 2);
  });

  test('drops entry when BPM <= 0', () => {
    const clock = 1000;
    const tracker = new PhaseTracker({ now: () => clock });

    tracker.update('deck:1', makeBeatInfo({ beat: 4.0, bpm: 120 }));
    expect(tracker.getPhase('deck:1')).not.toBeNull();

    tracker.update('deck:1', makeBeatInfo({ beat: 4.0, bpm: 0 }));
    expect(tracker.getPhase('deck:1')).toBeNull();
  });

  test('returns null when stale', () => {
    let clock = 1000;
    const tracker = new PhaseTracker({ staleMs: 2000, now: () => clock });

    tracker.update('deck:1', makeBeatInfo({ beat: 0, bpm: 120 }));
    expect(tracker.getPhase('deck:1')).not.toBeNull();

    // Advance past staleness window
    clock = 4000;
    expect(tracker.getPhase('deck:1')).toBeNull();
  });

  test('remove() clears a deck', () => {
    const tracker = new PhaseTracker();
    tracker.update('deck:1', makeBeatInfo({ bpm: 120 }));
    expect(tracker.getPhase('deck:1')).not.toBeNull();

    tracker.remove('deck:1');
    expect(tracker.getPhase('deck:1')).toBeNull();
  });

  test('trackedDecks() lists active decks', () => {
    const tracker = new PhaseTracker();
    tracker.update('deck:1', makeBeatInfo({ bpm: 120 }));
    tracker.update('deck:2', makeBeatInfo({ bpm: 130 }));
    expect(tracker.trackedDecks().sort()).toEqual(['deck:1', 'deck:2']);
  });

  test('update replaces previous snapshot', () => {
    let clock = 1000;
    const tracker = new PhaseTracker({ now: () => clock });

    tracker.update('deck:1', makeBeatInfo({ beat: 0, bpm: 120 }));
    clock = 1200;
    // New update resets the interpolation baseline
    tracker.update('deck:1', makeBeatInfo({ beat: 10.0, bpm: 140 }));
    clock = 1200; // same instant as update
    const phase = tracker.getPhase('deck:1');
    expect(phase?.bpm).toBe(140);
    expect(phase?.beat).toBeCloseTo(0, 2); // beat 10.0 → fraction = 0
  });
});
