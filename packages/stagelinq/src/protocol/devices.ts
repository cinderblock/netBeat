/**
 * Known Denon DJ / AlphaTheta device models and their classification.
 *
 * The software name field in discovery messages contains a model code
 * (e.g. "JP13" for SC6000). We map these to human-readable names and
 * device categories.
 */

import type { DeviceCategory } from '@netbeat/core';

export type { DeviceCategory };

export interface DeviceModel {
  /** Internal model code from the software name field (e.g. "JP13"). */
  readonly code: string;
  /** Human-readable model name (e.g. "SC6000"). */
  readonly name: string;
  /** Device category. */
  readonly category: DeviceCategory;
  /** Number of playback decks (0 for mixers). */
  readonly deckCount: number;
}

/**
 * Map of known model codes to device info. Sourced from community
 * reverse-engineering efforts (chrisle/StageLinq, icedream/go-stagelinq).
 */
const MODEL_MAP: ReadonlyMap<string, DeviceModel> = new Map([
  // Controllers (integrated mixer + decks)
  ['JC11', { code: 'JC11', name: 'PRIME 4', category: 'controller', deckCount: 4 }],
  ['JC16', { code: 'JC16', name: 'PRIME 2', category: 'controller', deckCount: 2 }],
  ['JP11', { code: 'JP11', name: 'PRIME GO', category: 'controller', deckCount: 2 }],
  ['JP20', { code: 'JP20', name: 'SC LIVE 2', category: 'controller', deckCount: 2 }],
  ['JP21', { code: 'JP21', name: 'SC LIVE 4', category: 'controller', deckCount: 4 }],
  ['NH08', { code: 'NH08', name: 'Mixstream Pro', category: 'controller', deckCount: 2 }],
  ['NH09', { code: 'NH09', name: 'Mixstream Pro+', category: 'controller', deckCount: 2 }],
  ['NH10', { code: 'NH10', name: 'Mixstream Pro Go', category: 'controller', deckCount: 2 }],

  // Players (standalone decks, typically 2 layers each)
  ['JP07', { code: 'JP07', name: 'SC5000', category: 'player', deckCount: 2 }],
  ['JP08', { code: 'JP08', name: 'SC5000M', category: 'player', deckCount: 2 }],
  ['JP13', { code: 'JP13', name: 'SC6000', category: 'player', deckCount: 2 }],
  ['JP14', { code: 'JP14', name: 'SC6000M', category: 'player', deckCount: 2 }],

  // Mixers (no decks)
  ['JM08', { code: 'JM08', name: 'X1800', category: 'mixer', deckCount: 0 }],
  ['JM10', { code: 'JM10', name: 'X1850', category: 'mixer', deckCount: 0 }],

  // Other
  ['JC20', { code: 'JC20', name: 'LC6000', category: 'unknown', deckCount: 0 }],
]);

/**
 * Look up a device model by its software name code.
 * Returns `undefined` for unrecognized codes.
 */
export function lookupModel(code: string): DeviceModel | undefined {
  return MODEL_MAP.get(code);
}

/**
 * Classify a software name into a device model. For unrecognized codes,
 * returns a generic entry with the raw code as the name.
 */
export function classifyDevice(softwareName: string): DeviceModel {
  return (
    MODEL_MAP.get(softwareName) ?? {
      code: softwareName,
      name: softwareName,
      category: 'unknown' as const,
      deckCount: 0,
    }
  );
}
