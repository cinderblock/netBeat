/**
 * Public types for the StageLinQ observer.
 */

import type { DeviceId } from '../protocol/device-id.js';
import type { DeviceCategory, DeviceModel } from '../protocol/devices.js';
import type { DeckBeatInfo } from '../services/beat-info.js';

/** A discovered StageLinQ device on the network. */
export interface StageLinqDevice {
  /** 16-byte UUID identifying the device. */
  readonly deviceId: DeviceId;
  /** Source identifier from discovery (usually hostname). */
  readonly source: string;
  /** Device model info (name, category, deck count). */
  readonly model: DeviceModel;
  /** Software version string. */
  readonly softwareVersion: string;
  /** Network address of the device. */
  readonly address: string;
  /** TCP port for the device's Directory service. */
  readonly directoryPort: number;
  /** Timestamp (ms) when last seen via discovery. */
  readonly lastSeen: number;
}

/** Device lifecycle event type. */
export type DeviceEventType = 'added' | 'updated' | 'removed';

/** Callback for device lifecycle events. */
export type DeviceListener = (event: DeviceEventType, device: StageLinqDevice) => void;

/** Per-deck state snapshot from StateMap subscriptions. */
export interface DeckState {
  /** Deck number (1-based). */
  readonly deckNumber: number;
  /** Whether the deck is currently playing. */
  readonly isPlaying: boolean;
  /** Current BPM (0 if unknown). */
  readonly bpm: number;
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
  /** Mixer crossfader position (0.0–1.0), if available. */
  readonly crossfaderPosition: number | null;
  /** Per-channel fader positions (0.0–1.0), keyed by channel number. */
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
export type { DeviceCategory, DeviceModel };
