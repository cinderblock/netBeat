/**
 * `@netbeat/core` — common types and unified observer for netBeat.
 *
 * This package defines the `Observer` interface that both `@netbeat/prolink`
 * and `@netbeat/stagelinq` implement, plus a `UnifiedObserver` that runs
 * multiple protocol observers simultaneously.
 *
 * Consumer quick-start:
 *
 * ```ts
 * import { UnifiedObserver } from '@netbeat/core';
 * import { Observer as Prolink } from '@netbeat/prolink';
 * import { Observer as StageLinq } from '@netbeat/stagelinq';
 *
 * const observer = new UnifiedObserver([new Prolink(opts), new StageLinq()]);
 * await observer.start();
 *
 * // Poll in a render loop — works for both Pioneer and Denon gear:
 * const phase = observer.phase;
 * if (phase) setIntensity(Math.sin(phase.beat * 2 * Math.PI));
 * ```
 */

export type {
  DeckState,
  DeckUpdateListener,
  Device,
  DeviceCategory,
  DeviceEvent,
  DeviceListener,
  Observer,
  PhaseState,
  Protocol,
  TrackInfo,
} from './types.js';

export { UnifiedObserver } from './unified.js';
