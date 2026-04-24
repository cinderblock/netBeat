/**
 * `PhaseTracker` — continuous phase interpolation between beat events.
 *
 * Beat events only fire at beat boundaries. For smooth lighting / visual
 * sync the consumer needs to know *where* in the beat cycle the music is
 * right now, at an arbitrary point in time. PhaseTracker records the
 * high-resolution arrival time of each beat and extrapolates on demand.
 *
 * Two representations are provided:
 *
 *   - **Proportional** (`beat`, `bar`): [0, 1) fractions through the
 *     current beat or bar. Feed these into `Math.sin(beat * 2π)` for a
 *     smooth oscillator, or `beat * 255` for a linear DMX ramp.
 *
 *   - **Real-time** (`beatElapsed`, `beatRemaining`, `barElapsed`,
 *     `barRemaining`): seconds since / until the previous / next beat
 *     or downbeat. Use for countdown displays, trigger scheduling, or
 *     any logic that needs wall-clock durations.
 *
 * Phase is computed via linear extrapolation from the last beat using
 * `performance.now()` (or an injected clock for testing). The beat
 * interval is derived from `effectiveBpm` — the pitch-adjusted tempo.
 *
 * When no beat has arrived for many intervals (default 64 = 16 bars),
 * the player is considered stale and `getPhase()` returns `null`.
 */

import type { Beat } from '../packets/types.js';

/**
 * Interpolated phase state for a single player at a point in time.
 */
export interface PhaseState {
  // ---- Proportional phase [0, 1) ----

  /** Fraction through the current beat, [0, 1). 0 = on the beat. */
  readonly beat: number;
  /**
   * Fraction through the current bar (4 beats), [0, 1).
   * 0 = downbeat (beat 1), 0.25 = beat 2, 0.5 = beat 3, 0.75 = beat 4.
   */
  readonly bar: number;

  // ---- Real-time (seconds) ----

  /** Seconds elapsed since the last beat. */
  readonly beatElapsed: number;
  /** Seconds remaining until the next beat. */
  readonly beatRemaining: number;
  /** Seconds elapsed since the last downbeat (beat 1 of the current bar). */
  readonly barElapsed: number;
  /** Seconds remaining until the next downbeat (beat 1 of the next bar). */
  readonly barRemaining: number;

  // ---- Context ----

  /** Which beat in the bar we believe we're currently on (1–4). */
  readonly beatInBar: number;
  /** Effective BPM (track BPM × pitch adjustment) at last beat. */
  readonly bpm: number;
  /** Device/player ID this phase belongs to. */
  readonly playerId: number;
}

/** Per-player interpolation anchor, updated on each beat. */
interface PlayerState {
  /** High-resolution timestamp of last beat arrival (ms, monotonic). */
  hrTime: number;
  /** Real-time beat interval in ms, derived from effectiveBpm. */
  intervalMs: number;
  /** Beat-within-bar at last beat (1–4). */
  beatInBar: number;
  /** Effective BPM at last beat. */
  bpm: number;
}

export interface PhaseTrackerOptions {
  /**
   * High-resolution monotonic clock (milliseconds). Defaults to
   * `performance.now()`. Inject a mock for deterministic tests.
   */
  readonly now?: () => number;
  /**
   * After this many beat intervals without a new beat, `getPhase()`
   * returns `null` for that player. Default: 64 (16 bars at 4/4).
   */
  readonly staleAfterBeats?: number;
}

const DEFAULT_STALE_AFTER_BEATS = 64;

export class PhaseTracker {
  private readonly players = new Map<number, PlayerState>();
  private readonly now: () => number;
  private readonly staleAfterBeats: number;

  constructor(options?: PhaseTrackerOptions) {
    this.now = options?.now ?? (() => performance.now());
    this.staleAfterBeats = options?.staleAfterBeats ?? DEFAULT_STALE_AFTER_BEATS;
  }

  /**
   * Record a beat event. Call once per deduplicated beat.
   *
   * @param beat   Parsed beat from `parseBeat`.
   * @param hrTime High-resolution timestamp of packet arrival (ms,
   *               monotonic). Defaults to `this.now()`. Pass this
   *               explicitly when the caller already captured
   *               `performance.now()` at packet arrival.
   */
  ingest(beat: Beat, hrTime?: number): void {
    const t = hrTime ?? this.now();
    const intervalMs = beat.effectiveBpm > 0 ? 60_000 / beat.effectiveBpm : 0;
    if (intervalMs <= 0) return;

    this.players.set(beat.deviceId, {
      hrTime: t,
      intervalMs,
      beatInBar: beat.beatInBar,
      bpm: beat.effectiveBpm,
    });
  }

  /**
   * Interpolated phase for a player right now. Returns `null` if no
   * beats have been received or the player is stale.
   */
  getPhase(playerId: number): PhaseState | null {
    const s = this.players.get(playerId);
    if (!s) return null;

    const elapsed = this.now() - s.hrTime;
    const beatsElapsed = elapsed / s.intervalMs;

    if (beatsElapsed < 0 || beatsElapsed > this.staleAfterBeats) return null;

    // Fractional progress within the current beat [0, 1).
    const beat = beatsElapsed - Math.floor(beatsElapsed);

    // Which beat in the bar, accounting for beats elapsed since anchor.
    const wholeBeats = Math.floor(beatsElapsed);
    const beatInBar = ((s.beatInBar - 1 + wholeBeats) % 4) + 1;

    // Bar proportion [0, 1).
    const bar = ((beatInBar - 1 + beat) / 4) % 1;

    // Real-time values (seconds).
    const intervalSec = s.intervalMs / 1000;
    const beatElapsed = beat * intervalSec;
    const beatRemaining = (1 - beat) * intervalSec;
    const barElapsed = bar * 4 * intervalSec;
    const barRemaining = (1 - bar) * 4 * intervalSec;

    return {
      beat,
      bar,
      beatElapsed,
      beatRemaining,
      barElapsed,
      barRemaining,
      beatInBar,
      bpm: s.bpm,
      playerId,
    };
  }

  /** Phase for all known, non-stale players. */
  all(): PhaseState[] {
    const result: PhaseState[] = [];
    for (const id of this.players.keys()) {
      const phase = this.getPhase(id);
      if (phase) result.push(phase);
    }
    return result;
  }

  /** Remove a player's state (e.g. when it disappears from the network). */
  remove(playerId: number): void {
    this.players.delete(playerId);
  }

  /** Clear all player state. */
  clear(): void {
    this.players.clear();
  }
}
