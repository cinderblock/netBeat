/**
 * Curated catalog of StateMap paths relevant for observer/sync use cases.
 *
 * StageLinQ devices expose 300+ state paths. We subscribe to a focused subset
 * that maps to the data our consumers need: play state, BPM, track info,
 * fader positions, and sync mode. Consumers can subscribe to additional paths
 * via the Observer API.
 *
 * Paths use a `/Engine/Deck{N}/...` hierarchy where N is 1-based.
 */

/**
 * Generate the core state paths for a single deck. These cover the essentials
 * for beat sync and track identification.
 */
export function deckPaths(deck: number): readonly string[] {
  const d = `Deck${deck}`;
  return [
    // Playback
    `/Engine/${d}/Play`,
    `/Engine/${d}/PlayState`,
    `/Engine/${d}/PlayStatePath`,
    `/Engine/${d}/Speed`,
    `/Engine/${d}/CurrentBPM`,

    // Track identity
    `/Engine/${d}/Track/SongLoaded`,
    `/Engine/${d}/Track/SongName`,
    `/Engine/${d}/Track/ArtistName`,
    `/Engine/${d}/Track/TrackNetworkPath`,
    `/Engine/${d}/Track/TrackData`,
    `/Engine/${d}/Track/TrackName`,
    `/Engine/${d}/Track/TrackLength`,
    `/Engine/${d}/Track/CurrentBPM`,
    `/Engine/${d}/Track/KeyLock`,

    // Beat / phase
    `/Engine/${d}/Track/CuePosition`,
    `/Engine/${d}/Track/CurrentLoopSizeInBeats`,
    `/Engine/${d}/Track/SyncMode`,

    // Misc
    `/Engine/${d}/ExternalMixerVolume`,
    `/Engine/${d}/ExternalScratchWheelTouch`,
  ] as const;
}

/**
 * Generate mixer state paths. These cover fader positions and crossfader.
 */
export function mixerPaths(channelCount = 4): readonly string[] {
  const paths: string[] = ['/Mixer/CrossfaderPosition', '/Mixer/NumberOfChannels'];
  for (let ch = 1; ch <= channelCount; ch++) {
    paths.push(`/Mixer/CH${ch}faderPosition`);
  }
  return paths;
}

/**
 * Generate the default set of state paths for a device with the given deck
 * count. This is the curated "observe everything useful" set.
 */
export function defaultStatePaths(deckCount: number, mixerChannels = 4): readonly string[] {
  const paths: string[] = [];
  for (let d = 1; d <= deckCount; d++) {
    paths.push(...deckPaths(d));
  }
  paths.push(...mixerPaths(mixerChannels));
  return paths;
}
