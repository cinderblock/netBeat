/**
 * `PhaseTracker` — converts StageLinQ BeatInfo into interpolated `PhaseState`.
 *
 * BeatInfo delivers a continuous beat position (e.g., 5.75 = beat 5, 75%
 * through). Between updates, we interpolate forward using `performance.now()`
 * and the last known BPM, so consumers get smooth sub-millisecond phase
 * data on every poll.
 */

import type { PhaseState } from '@netbeat/core';
import type { DeckBeatInfo } from '../services/beat-info.js';

interface BeatSnapshot {
  /** Absolute beat position from BeatInfo. */
  beat: number;
  /** BPM at the time of the snapshot. */
  bpm: number;
  /** `performance.now()` when this snapshot was taken (ms). */
  timestamp: number;
}

export interface PhaseTrackerOptions {
  /** How long (ms) before a deck's phase is considered stale. Default: 5000. */
  readonly staleMs?: number;
  /** Monotonic clock for testing. Default: `performance.now`. */
  readonly now?: () => number;
}

export class PhaseTracker {
  private readonly entries = new Map<string, BeatSnapshot>();
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(options: PhaseTrackerOptions = {}) {
    this.staleMs = options.staleMs ?? 5000;
    this.now = options.now ?? (() => performance.now());
  }

  /** Record a BeatInfo update for a deck. Drops the entry if BPM <= 0. */
  update(deckId: string, beatInfo: DeckBeatInfo): void {
    if (beatInfo.bpm <= 0) {
      this.entries.delete(deckId);
      return;
    }
    this.entries.set(deckId, {
      beat: beatInfo.beat,
      bpm: beatInfo.bpm,
      timestamp: this.now(),
    });
  }

  /** Get interpolated phase for a deck. Returns `null` if missing or stale. */
  getPhase(deckId: string): PhaseState | null {
    const entry = this.entries.get(deckId);
    if (!entry) return null;

    const now = this.now();
    if (now - entry.timestamp > this.staleMs) return null;

    return interpolate(entry, now);
  }

  /** Remove tracking for a deck. */
  remove(deckId: string): void {
    this.entries.delete(deckId);
  }

  /** All deck IDs currently being tracked. */
  trackedDecks(): string[] {
    return [...this.entries.keys()];
  }
}

/** Pure interpolation — no side effects, easy to test. */
function interpolate(snap: BeatSnapshot, now: number): PhaseState {
  const elapsedSec = (now - snap.timestamp) / 1000;
  const beatsElapsed = elapsedSec * (snap.bpm / 60);
  const currentBeat = snap.beat + beatsElapsed;

  // Beat fraction [0, 1). The double-mod handles negative remainders.
  const beatFraction = ((currentBeat % 1) + 1) % 1;

  // Beat in bar: 1-4. Floor the beat, mod 4, +1.
  const beatInBar = (((Math.floor(currentBeat) % 4) + 4) % 4) + 1;

  // Bar position [0, 4) and bar fraction [0, 1).
  const barPosition = ((currentBeat % 4) + 4) % 4;
  const bar = barPosition / 4;

  const beatDuration = 60 / snap.bpm;

  return {
    beat: beatFraction,
    bar,
    beatInBar,
    bpm: snap.bpm,
    beatElapsed: beatFraction * beatDuration,
    beatRemaining: (1 - beatFraction) * beatDuration,
    barElapsed: barPosition * beatDuration,
    barRemaining: (4 - barPosition) * beatDuration,
  };
}
