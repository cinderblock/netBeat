/**
 * `@netbeat/stagelinq` — read-only observer for Denon StageLinQ.
 *
 * Discovers Denon Prime-series DJ hardware on the network and surfaces
 * real-time deck state (beat position, BPM, track info, fader positions)
 * without sending control or sync commands.
 *
 * ```ts
 * import { Observer } from '@netbeat/stagelinq';
 *
 * const observer = new Observer({ name: 'my-light-show' });
 * observer.onDevice((event, device) => {
 *   console.log(event, device.model.name, device.address);
 * });
 * observer.onBeatInfo((device, decks, clock) => {
 *   for (const deck of decks) {
 *     if (deck.bpm > 0) console.log(`BPM: ${deck.bpm.toFixed(1)}`);
 *   }
 * });
 * await observer.start();
 * ```
 *
 * See `docs/research.md` §"Denon StageLinQ" and `plans/denon-stagelinq.md`
 * for protocol details and implementation status.
 */

/** Protocol identifier this package implements. */
export const PROTOCOL = 'stagelinq' as const;

export {
  DeviceManager,
  type DeviceManagerOptions,
} from './observer/device-manager.js';
// Observer
export { Observer, type ObserverOptions } from './observer/index.js';
export { PhaseTracker, type PhaseTrackerOptions } from './observer/phase-tracker.js';
export type {
  BeatInfoHandler,
  DeckState,
  DeviceEventType,
  DeviceListener,
  DeviceState,
  StageLinqDevice,
  StateChangeHandler,
} from './observer/types.js';
export {
  DEVICE_ID_LENGTH,
  type DeviceId,
  deviceIdEquals,
  formatDeviceId,
  KNOWN_TOKENS,
  parseDeviceId,
  randomDeviceId,
  readDeviceId,
  writeDeviceId,
} from './protocol/device-id.js';
export {
  classifyDevice,
  type DeviceCategory,
  type DeviceModel,
  lookupModel,
} from './protocol/devices.js';
// Directory service
export {
  buildServiceHandshake,
  buildServicesRequest,
  DIRECTORY_MSG,
  type DirectoryMessage,
  parseDirectoryMessage,
  type ServiceEntry,
  type ServicesAnnouncement,
  type ServicesRequest,
  type TimeStampMessage,
} from './protocol/directory.js';
// Discovery
export {
  type BuildDiscoveryOptions,
  buildDiscovery,
  DISCOVERY_ACTION,
  type DiscoveryAction,
  type DiscoveryMessage,
  hasDiscoveryMagic,
  parseDiscovery,
} from './protocol/discovery.js';
export { DISCOVERY_MAGIC, DISCOVERY_MAGIC_LENGTH, DISCOVERY_PORT } from './protocol/ports.js';
// Protocol primitives
export { ReadContext } from './protocol/read-context.js';
// Service constants
export {
  SERVICE_MAGIC,
  SERVICE_NAME,
  SERVICE_TIMEOUT_MS,
  type ServiceName,
} from './protocol/services.js';
// TCP framing
export { FRAME_HEADER_SIZE, frameMessage, MessageFramer } from './protocol/tcp-framing.js';
export { WriteContext } from './protocol/write-context.js';
// BeatInfo service
export {
  type BeatInfoMessage,
  buildBeatInfoSubscription,
  type DeckBeatInfo,
  parseBeatInfoMessage,
} from './services/beat-info.js';
// StateMap service
export {
  buildStateMapSubscribe,
  buildStateMapSubscriptions,
  hasStateMapMagic,
  parseStateMapMessage,
  parseStateValue,
  STATE_MAP_MSG,
  type StateUpdate,
} from './services/state-map.js';
// State path catalog
export { deckPaths, defaultStatePaths, mixerPaths } from './services/state-paths.js';
