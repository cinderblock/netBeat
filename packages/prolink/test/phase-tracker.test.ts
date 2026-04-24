import { describe, expect, test } from 'bun:test';
import { PhaseTracker } from '../src/observer/phase-tracker.ts';
import type { Beat } from '../src/packets/types.ts';

/** Minimal Beat with sane defaults for phase-tracker tests. */
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

describe('PhaseTracker', () => {
  test('returns null before any beats', () => {
    const tracker = new PhaseTracker({ now: () => 0 });
    expect(tracker.getPhase(1)).toBeNull();
  });

  test('returns 0 at exact beat boundary', () => {
    const t = 1000;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ beatInBar: 1 }), 1000);
    const phase = tracker.getPhase(1);
    expect(phase).not.toBeNull();
    expect(phase?.beat).toBeCloseTo(0, 5);
    expect(phase?.bar).toBeCloseTo(0, 5);
    expect(phase?.beatInBar).toBe(1);
    expect(phase?.bpm).toBe(120);
    expect(phase?.playerId).toBe(1);
  });

  // ---- Proportional phase ----

  test('beat reaches 0.5 at half-beat', () => {
    let t = 1000;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ effectiveBpm: 120, beatInBar: 1 }), 1000);
    // 120 BPM = 500 ms/beat, half = 250 ms
    t = 1250;
    expect(tracker.getPhase(1)?.beat).toBeCloseTo(0.5, 5);
  });

  test('beat reaches 0.25 at quarter-beat', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ effectiveBpm: 120 }), 0);
    t = 125; // 500 / 4
    expect(tracker.getPhase(1)?.beat).toBeCloseTo(0.25, 5);
  });

  test('bar advances 0.25 per beat', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ effectiveBpm: 120, beatInBar: 1 }), 0);

    t = 500; // 1 beat → beat 2 = 0.25
    expect(tracker.getPhase(1)?.bar).toBeCloseTo(0.25, 5);
    expect(tracker.getPhase(1)?.beatInBar).toBe(2);

    t = 1000; // 2 beats → beat 3 = 0.5
    expect(tracker.getPhase(1)?.bar).toBeCloseTo(0.5, 5);
    expect(tracker.getPhase(1)?.beatInBar).toBe(3);

    t = 1500; // 3 beats → beat 4 = 0.75
    expect(tracker.getPhase(1)?.bar).toBeCloseTo(0.75, 5);
    expect(tracker.getPhase(1)?.beatInBar).toBe(4);

    t = 2000; // 4 beats → wraps to 0
    expect(tracker.getPhase(1)?.bar).toBeCloseTo(0, 5);
    expect(tracker.getPhase(1)?.beatInBar).toBe(1);
  });

  test('bar starts from correct beat position', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    // Anchor at beat 3 → bar = 0.5
    tracker.ingest(makeBeat({ effectiveBpm: 120, beatInBar: 3 }), 0);
    expect(tracker.getPhase(1)?.bar).toBeCloseTo(0.5, 5);

    t = 500; // beat 4 → 0.75
    expect(tracker.getPhase(1)?.bar).toBeCloseTo(0.75, 5);

    t = 1000; // wraps to beat 1 → 0
    expect(tracker.getPhase(1)?.bar).toBeCloseTo(0, 5);
  });

  test('bar interpolates smoothly within a beat', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ effectiveBpm: 120, beatInBar: 1 }), 0);

    // Halfway through beat 1: bar = 0.125 (half of 0.25)
    t = 250;
    expect(tracker.getPhase(1)?.bar).toBeCloseTo(0.125, 5);

    // Halfway through beat 2: bar = 0.375
    t = 750;
    expect(tracker.getPhase(1)?.bar).toBeCloseTo(0.375, 5);
  });

  // ---- Real-time (seconds) ----

  test('beatElapsed and beatRemaining sum to beat interval', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    // 120 BPM → 0.5 s per beat
    tracker.ingest(makeBeat({ effectiveBpm: 120 }), 0);

    t = 200; // 0.2 s into a 0.5 s beat
    const p = tracker.getPhase(1);
    expect(p?.beatElapsed).toBeCloseTo(0.2, 3);
    expect(p?.beatRemaining).toBeCloseTo(0.3, 3);
  });

  test('beatElapsed is 0 at beat boundary', () => {
    const t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ effectiveBpm: 120 }), 0);
    expect(tracker.getPhase(1)?.beatElapsed).toBeCloseTo(0, 5);
    // Full beat interval remaining
    expect(tracker.getPhase(1)?.beatRemaining).toBeCloseTo(0.5, 5);
  });

  test('barElapsed and barRemaining sum to bar interval', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    // 120 BPM → 0.5 s/beat → 2.0 s/bar
    tracker.ingest(makeBeat({ effectiveBpm: 120, beatInBar: 1 }), 0);

    t = 800; // 0.8 s into a 2.0 s bar
    const p = tracker.getPhase(1);
    expect(p?.barElapsed).toBeCloseTo(0.8, 3);
    expect(p?.barRemaining).toBeCloseTo(1.2, 3);
  });

  test('barElapsed accounts for starting beat', () => {
    const t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    // Start at beat 3 → already 1.0 s into the bar
    tracker.ingest(makeBeat({ effectiveBpm: 120, beatInBar: 3 }), 0);
    expect(tracker.getPhase(1)?.barElapsed).toBeCloseTo(1.0, 3);
    expect(tracker.getPhase(1)?.barRemaining).toBeCloseTo(1.0, 3);
  });

  test('barRemaining approaches 0 near bar boundary', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ effectiveBpm: 120, beatInBar: 4 }), 0);
    // Beat 4, just before the next downbeat (499 ms of a 500 ms beat)
    t = 499;
    expect(tracker.getPhase(1)?.barRemaining).toBeCloseTo(0.001, 3);

    // At the exact downbeat, bar wraps to 0 → full bar remaining
    t = 500;
    expect(tracker.getPhase(1)?.barRemaining).toBeCloseTo(2.0, 3);
  });

  test('realtime values scale with BPM', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    // 60 BPM → 1.0 s/beat
    tracker.ingest(makeBeat({ effectiveBpm: 60 }), 0);
    t = 500; // 0.5 s
    expect(tracker.getPhase(1)?.beatElapsed).toBeCloseTo(0.5, 3);
    expect(tracker.getPhase(1)?.beatRemaining).toBeCloseTo(0.5, 3);
    // bar interval = 4.0 s
    expect(tracker.getPhase(1)?.barRemaining).toBeCloseTo(3.5, 3);
  });

  // ---- Pitch, multi-player, reset, staleness ----

  test('pitch-adjusted BPM changes intervals', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    // 120 BPM at +10% → 132 effective → ~454.5 ms/beat
    tracker.ingest(makeBeat({ trackBpm: 120, effectiveBpm: 132, pitch: 10 }), 0);

    t = 60000 / 132 / 2; // half beat
    expect(tracker.getPhase(1)?.beat).toBeCloseTo(0.5, 2);
    expect(tracker.getPhase(1)?.bpm).toBe(132);
  });

  test('tracks multiple players independently', () => {
    const t = 250;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ deviceId: 1, effectiveBpm: 120, beatInBar: 1 }), 0);
    tracker.ingest(makeBeat({ deviceId: 2, effectiveBpm: 140, beatInBar: 3 }), 0);

    const p1 = tracker.getPhase(1);
    const p2 = tracker.getPhase(2);
    expect(p1?.playerId).toBe(1);
    expect(p2?.playerId).toBe(2);
    // Player 1: 500 ms/beat, 250/500 = 0.5
    expect(p1?.beat).toBeCloseTo(0.5, 3);
    // Player 2: ~428.6 ms/beat
    expect(p2?.beat).toBeCloseTo(250 / (60000 / 140), 3);
    expect(p2?.bar).toBeCloseTo((2 + 250 / (60000 / 140)) / 4, 3);
  });

  test('new beat resets interpolation anchor', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });

    tracker.ingest(makeBeat({ effectiveBpm: 120, beatInBar: 1 }), 0);
    t = 250;
    expect(tracker.getPhase(1)?.beat).toBeCloseTo(0.5, 3);

    // New beat at t=250
    tracker.ingest(makeBeat({ effectiveBpm: 120, beatInBar: 2 }), 250);
    expect(tracker.getPhase(1)?.beat).toBeCloseTo(0, 5);
    expect(tracker.getPhase(1)?.bar).toBeCloseTo(0.25, 5); // beat 2
  });

  test('returns null for stale player', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t, staleAfterBeats: 8 });
    tracker.ingest(makeBeat({ effectiveBpm: 120 }), 0);
    t = 4001; // 8+ beats
    expect(tracker.getPhase(1)).toBeNull();
  });

  test('returns phase just inside staleness window', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t, staleAfterBeats: 8 });
    tracker.ingest(makeBeat({ effectiveBpm: 120 }), 0);
    t = 3999;
    expect(tracker.getPhase(1)).not.toBeNull();
  });

  test('default staleness is 64 beats', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ effectiveBpm: 120 }), 0);
    t = 63 * 500;
    expect(tracker.getPhase(1)).not.toBeNull();
    t = 65 * 500;
    expect(tracker.getPhase(1)).toBeNull();
  });

  test('all() returns phases for all active players', () => {
    const t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ deviceId: 1 }), 0);
    tracker.ingest(makeBeat({ deviceId: 2 }), 0);
    expect(tracker.all()).toHaveLength(2);
    expect(
      tracker
        .all()
        .map((p) => p.playerId)
        .sort(),
    ).toEqual([1, 2]);
  });

  test('all() excludes stale players', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t, staleAfterBeats: 4 });
    tracker.ingest(makeBeat({ deviceId: 1, effectiveBpm: 120 }), 0);
    tracker.ingest(makeBeat({ deviceId: 2, effectiveBpm: 120 }), 0);
    t = 5 * 500;
    tracker.ingest(makeBeat({ deviceId: 2, effectiveBpm: 120 }), t);
    expect(tracker.all()).toHaveLength(1);
    expect(tracker.all()[0]?.playerId).toBe(2);
  });

  test('remove() drops a player', () => {
    const tracker = new PhaseTracker({ now: () => 0 });
    tracker.ingest(makeBeat({ deviceId: 1 }), 0);
    tracker.remove(1);
    expect(tracker.getPhase(1)).toBeNull();
  });

  test('clear() drops all players', () => {
    const tracker = new PhaseTracker({ now: () => 0 });
    tracker.ingest(makeBeat({ deviceId: 1 }), 0);
    tracker.ingest(makeBeat({ deviceId: 2 }), 0);
    tracker.clear();
    expect(tracker.all()).toHaveLength(0);
  });

  test('ignores beats with zero effectiveBpm', () => {
    const tracker = new PhaseTracker({ now: () => 0 });
    tracker.ingest(makeBeat({ effectiveBpm: 0 }));
    expect(tracker.getPhase(1)).toBeNull();
  });

  test('ignores beats with negative effectiveBpm', () => {
    const tracker = new PhaseTracker({ now: () => 0 });
    tracker.ingest(makeBeat({ effectiveBpm: -10 }));
    expect(tracker.getPhase(1)).toBeNull();
  });

  test('beat wraps correctly over multiple beats', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ effectiveBpm: 120, beatInBar: 1 }), 0);
    t = 1250; // 2.5 beats
    const phase = tracker.getPhase(1);
    expect(phase?.beat).toBeCloseTo(0.5, 5);
    expect(phase?.beatInBar).toBe(3);
  });

  test('bpm field reflects the latest beat', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ effectiveBpm: 128 }), 0);
    expect(tracker.getPhase(1)?.bpm).toBe(128);
    t = 469;
    tracker.ingest(makeBeat({ effectiveBpm: 130 }), t);
    expect(tracker.getPhase(1)?.bpm).toBe(130);
  });

  test('bar wraps correctly across many bars', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat({ effectiveBpm: 120, beatInBar: 1 }), 0);

    t = 4000; // 8 beats = 2 bars → wraps to 0
    expect(tracker.getPhase(1)?.bar).toBeCloseTo(0, 5);

    t = 4750; // 9.5 beats → beat 2 + 0.5 → bar = (1 + 0.5)/4 = 0.375
    expect(tracker.getPhase(1)?.bar).toBeCloseTo(0.375, 3);
  });

  test('returns null for negative elapsed time', () => {
    let t = 1000;
    const tracker = new PhaseTracker({ now: () => t });
    tracker.ingest(makeBeat(), 1000);
    t = 999;
    expect(tracker.getPhase(1)).toBeNull();
  });

  test('phase at real-world BPMs', () => {
    let t = 0;
    const tracker = new PhaseTracker({ now: () => t });
    const effectiveBpm = 141.44 * 0.9; // 127.296
    tracker.ingest(makeBeat({ effectiveBpm, beatInBar: 2 }), 0);

    const interval = 60000 / effectiveBpm;
    t = interval; // 1 beat later
    const phase = tracker.getPhase(1);
    expect(phase?.beat).toBeCloseTo(0, 2);
    expect(phase?.beatInBar).toBe(3);
    expect(phase?.bar).toBeCloseTo(0.5, 2);
    // Realtime: at beat boundary, elapsed ≈ 0, remaining ≈ full interval
    expect(phase?.beatElapsed).toBeCloseTo(0, 1);
    expect(phase?.beatRemaining).toBeCloseTo(interval / 1000, 2);
  });
});
