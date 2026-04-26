/**
 * `UnifiedObserver` — composite that delegates to multiple protocol-specific
 * observers, presenting a single `Observer` interface.
 *
 * ```ts
 * import { UnifiedObserver } from '@netbeat/core';
 * import { Observer as Prolink } from '@netbeat/prolink';
 * import { Observer as StageLinq } from '@netbeat/stagelinq';
 *
 * const observer = new UnifiedObserver([
 *   new Prolink({ identity: buildIdentity({ interface: 'Ethernet' }) }),
 *   new StageLinq(),
 * ]);
 * await observer.start();
 * // observer.phase works across both Pioneer and Denon gear
 * ```
 */

import type {
  DeckState,
  DeckUpdateListener,
  Device,
  DeviceListener,
  Observer,
  PhaseState,
} from './types.js';

export class UnifiedObserver implements Observer {
  private readonly observers: readonly Observer[];

  constructor(observers: readonly Observer[]) {
    this.observers = observers;
  }

  async start(): Promise<void> {
    const results = await Promise.allSettled(this.observers.map((o) => o.start()));

    // If ALL observers failed, throw the first error. If at least one
    // succeeded, continue — partial coverage is better than none.
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length === results.length && failures.length > 0) {
      throw failures[0]?.reason as Error;
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.observers.map((o) => o.stop()));
  }

  onDevice(listener: DeviceListener): () => void {
    const unsubs = this.observers.map((o) => o.onDevice(listener));
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }

  onDeckUpdate(listener: DeckUpdateListener): () => void {
    const unsubs = this.observers.map((o) => o.onDeckUpdate(listener));
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }

  devices(): Device[] {
    return this.observers.flatMap((o) => o.devices());
  }

  decks(): DeckState[] {
    return this.observers.flatMap((o) => o.decks());
  }

  getDeck(deckId: string): DeckState | null {
    for (const o of this.observers) {
      const deck = o.getDeck(deckId);
      if (deck) return deck;
    }
    return null;
  }

  /**
   * Best-available phase across all protocol observers.
   *
   * Tries each observer's `phase` getter and returns the first non-null.
   * Observers are checked in constructor order — put higher-priority
   * protocols first if needed.
   */
  get phase(): PhaseState | null {
    for (const o of this.observers) {
      const p = o.phase;
      if (p) return p;
    }
    return null;
  }

  getPhase(deckId: string): PhaseState | null {
    for (const o of this.observers) {
      const p = o.getPhase(deckId);
      if (p) return p;
    }
    return null;
  }

  phases(): PhaseState[] {
    return this.observers.flatMap((o) => o.phases());
  }
}
