import { describe, expect, test } from 'bun:test';
import { resolveBestPhase } from '../src/observer/index.ts';
import { PhaseTracker } from '../src/observer/phase-tracker.ts';
import type { Beat } from '../src/packets/types.ts';

function makeBeat(overrides: Partial<Beat> = {}): Beat {
  return {
    deviceId: 1,
    deviceName: 'CDJ-TEST',
    trackBpm: 120,
    effectiveBpm: 120,
    pitch: 0,
    beatInBar: 1,
    nextBeat: 500,
    secondBeat: 1000,
    nextBar: 2000,
    fourthBeat: 2000,
    secondBar: 4000,
    eighthBeat: 4000,
    timestamp: new Date(),
    ...overrides,
  };
}

describe('resolveBestPhase', () => {
  test('returns null when no players are active', () => {
    const tracker = new PhaseTracker({ now: () => 0 });
    expect(resolveBestPhase(null, tracker)).toBeNull();
  });

  test('returns null when no players active even with master set', () => {
    const tracker = new PhaseTracker({ now: () => 0 });
    expect(resolveBestPhase(2, tracker)).toBeNull();
  });

  test('returns master phase when master is known and active', () => {
    const t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ deviceId: 1 }), 0);
    tracker.ingest(makeBeat({ deviceId: 2 }), 0);
    tracker.ingest(makeBeat({ deviceId: 3 }), 0);

    const result = resolveBestPhase(2, tracker);
    expect(result).not.toBeNull();
    expect(result?.playerId).toBe(2);
  });

  test('falls back when master is known but stale', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t, staleAfterBeats: 4 });
    tracker.ingest(makeBeat({ deviceId: 1 }), 0);
    tracker.ingest(makeBeat({ deviceId: 2 }), 0);
    tracker.ingest(makeBeat({ deviceId: 3 }), 0);

    // Advance past staleness for all, then refresh only 1 and 3
    t = 5 * 500;
    tracker.ingest(makeBeat({ deviceId: 1 }), t);
    tracker.ingest(makeBeat({ deviceId: 3 }), t);

    // Master 2 is stale — should fall back to lowest active ID (1)
    const result = resolveBestPhase(2, tracker);
    expect(result?.playerId).toBe(1);
  });

  test('returns sole active player when no master is known', () => {
    const t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ deviceId: 3 }), 0);

    const result = resolveBestPhase(null, tracker);
    expect(result?.playerId).toBe(3);
  });

  test('returns lowest player ID when multiple active and no master', () => {
    const t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ deviceId: 3 }), 0);
    tracker.ingest(makeBeat({ deviceId: 1 }), 0);
    tracker.ingest(makeBeat({ deviceId: 2 }), 0);

    const result = resolveBestPhase(null, tracker);
    expect(result?.playerId).toBe(1);
  });

  test('switches to master once identified', () => {
    const t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ deviceId: 1 }), 0);
    tracker.ingest(makeBeat({ deviceId: 2, effectiveBpm: 140 }), 0);

    // Before master is known: lowest ID wins
    expect(resolveBestPhase(null, tracker)?.playerId).toBe(1);

    // Master identified as player 2
    expect(resolveBestPhase(2, tracker)?.playerId).toBe(2);
  });

  test('phase values are interpolated correctly through resolution', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ deviceId: 1, effectiveBpm: 120, beatInBar: 1 }), 0);

    // Half a beat later
    t = 250;
    const result = resolveBestPhase(null, tracker);
    expect(result?.beat).toBeCloseTo(0.5, 5);
    expect(result?.bar).toBeCloseTo(0.125, 5);
    expect(result?.bpm).toBe(120);
  });
});
