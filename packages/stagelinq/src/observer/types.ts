/**
 * Public types for the StageLinQ observer.
 *
 * `StageLinqDevice` and `DeckState` extend the common types from
 * `@netbeat/core`, adding StageLinQ-specific fields. Thanks to structural
 * typing, they satisfy the common interfaces automatically.
 */

import type { DeckState as CoreDeckState, Device as CoreDevice, DeviceEvent } from '@netbeat/core';
import type { DeviceId } from '../protocol/device-id.js';
import type { DeviceModel } from '../protocol/devices.js';
import type { DeckBeatInfo } from '../services/beat-info.js';

/** A discovered StageLinQ device on the network. */
export interface StageLinqDevice extends CoreDevice {
  readonly protocol: 'stagelinq';
  /** 16-byte UUID identifying the device. */
  readonly deviceId: DeviceId;
  /** Source identifier from discovery (usually hostname). */
  readonly source: string;
  /** Device model info (name, category, deck count). */
  readonly model: DeviceModel;
  /** Software version string. */
  readonly softwareVersion: string;
  /** TCP port for the device's Directory service. */
  readonly directoryPort: number;
  /** Timestamp (ms) when last seen via discovery. */
  readonly lastSeen: number;
}

/** Device lifecycle event type. */
export type DeviceEventType = DeviceEvent;

/** Callback for device lifecycle events. */
export type DeviceListener = (event: DeviceEventType, device: StageLinqDevice) => void;

/** Per-deck state snapshot, extending the common DeckState with StageLinQ specifics. */
export interface DeckState extends CoreDeckState {
  /** The StageLinQ device this deck belongs to. */
  readonly device: StageLinqDevice;
  /** Playback speed / pitch (1.0 = normal). */
  readonly speed: number;
  /** Track name, if loaded. */
  readonly trackName: string | null;
  /** Artist name, if loaded. */
  readonly artistName: string | null;
  /** Track length in seconds (0 if unknown). */
  readonly trackLength: number;
  /** Whether a track is loaded on this deck. */
  readonly trackLoaded: boolean;
  /** Sync mode string. */
  readonly syncMode: string | null;
  /** Latest beat info from BeatInfo service, if available. */
  readonly beatInfo: DeckBeatInfo | null;
}

/** Aggregated state for a device and all its decks. */
export interface DeviceState {
  /** The device identity. */
  readonly device: StageLinqDevice;
  /** Per-deck state snapshots. */
  readonly decks: readonly DeckState[];
  /** Mixer crossfader position (0.0-1.0), if available. */
  readonly crossfaderPosition: number | null;
  /** Per-channel fader positions (0.0-1.0), keyed by channel number. */
  readonly channelFaders: ReadonlyMap<number, number>;
}

/** Callback for state changes from StateMap. */
export type StateChangeHandler = (device: StageLinqDevice, path: string, value: unknown) => void;

/** Callback for beat info updates. */
export type BeatInfoHandler = (
  device: StageLinqDevice,
  decks: readonly DeckBeatInfo[],
  clock: bigint,
) => void;

/** Device category re-export for consumers. */
export type { DeviceCategory, DeviceModel } from '../protocol/devices.js';
