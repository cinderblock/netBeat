#!/usr/bin/env node
/**
 * `netbeat` — diagnostic and data-capture CLI.
 *
 * Primary subcommand is `observe`, which starts observer mode and streams
 * parsed events (devices, beats, status, phase) to stdout. Two output
 * modes:
 *
 *   - **Human-readable** (default): compact log lines per event.
 *   - **JSON** (`--json`): one JSONL object per event, suitable for piping
 *     to files for offline analysis or to lighting/show-control tools.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  buildIdentity,
  type CdjStatus,
  FilesystemMediaReader,
  listInterfaces,
  MetadataStore,
  type PhaseState,
  PORTS,
  PROTOCOL as PROLINK_PROTOCOL,
  Observer as ProlinkObserver,
  type TrackAnalysis,
} from '@netbeat/prolink';
import {
  type DeckBeatInfo,
  formatDeviceId,
  PROTOCOL as STAGELINQ_PROTOCOL,
  type StageLinqDevice,
  Observer as StageLinqObserver,
} from '@netbeat/stagelinq';

function printHelp(): void {
  console.log('netbeat — pre-alpha');
  console.log(`  protocols: ${PROLINK_PROTOCOL}, ${STAGELINQ_PROTOCOL}`);
  console.log(
    `  prolink udp ports: ${Object.values(PORTS)
      .sort((a, b) => a - b)
      .join(', ')}`,
  );
  console.log('');
  console.log('Usage: netbeat <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  observe           Log discovered devices and real-time events');
  console.log('  pulse             Live track display with pulsing beat indicator');
  console.log('  interfaces        List IPv4 interfaces netbeat could announce from');
  console.log('');
  console.log('Common options:');
  console.log('  --protocol <p>    Protocol: prolink (default) or stagelinq');
  console.log('  --interface <n>   Interface name or IP to bind to');
  console.log('  --name <s>        Device name to broadcast');
  console.log('');
  console.log('`observe` options (prolink):');
  console.log('  --id <n>          Player number to claim (default 7, avoid 1..4)');
  console.log('  --passive         Receive only, do not announce');
  console.log('  --json            Output events as JSONL (one JSON object per line)');
  console.log('  --raw             Also log raw inbound packet kinds');
  console.log('  --dump <file>     Write JSONL raw packet capture to <file>');
  console.log('');
  console.log('`observe` options (stagelinq):');
  console.log('  --json            Output events as JSONL (one JSON object per line)');
  console.log('');
  console.log('`pulse` options (prolink):');
  console.log('  --id <n>          Player number to claim (default 7, avoid 1..4)');
  console.log('  --passive         Receive only, do not announce');
  console.log('  --media <path>    Path to USB export for track metadata + phrases');
}

function printInterfaces(): void {
  const infos = listInterfaces();
  if (infos.length === 0) {
    console.log('No non-loopback IPv4 interfaces detected.');
    return;
  }
  console.log('Available IPv4 interfaces:');
  for (const info of infos) {
    const macHex = Array.from(info.mac)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(':');
    console.log(`  ${info.name.padEnd(20)} ${info.ip.padEnd(16)} mac=${macHex}`);
  }
}

// ---- Output helpers ----

function ts(): string {
  return new Date().toISOString();
}

function fmtBpm(bpm: number): string {
  return bpm.toFixed(2);
}

function fmtPitch(pitch: number): string {
  return `${pitch >= 0 ? '+' : ''}${pitch.toFixed(2)}%`;
}

// ---- ANSI terminal helpers ----

const ANSI_RESET = '\x1b[0m';
const ANSI_DIM = '\x1b[2m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_HIDE_CURSOR = '\x1b[?25l';
const ANSI_SHOW_CURSOR = '\x1b[?25h';
const ANSI_CLEAR_LINE = '\x1b[2K';

/**
 * 24-bit ANSI foreground color for a pulsing beat dot.
 *
 * `beatFrac` runs 0 → ~1 within each beat (0 = just hit).
 * Cubic decay produces a sharp flash that quickly fades —
 * perceptually similar to a lighting-desk beat flash.
 *
 * Downbeat (beat 1) pulses cyan; beats 2–4 pulse white.
 */
function pulseColor(beatFrac: number, isDownbeat: boolean): string {
  const intensity = (1 - beatFrac) ** 3;
  if (isDownbeat) {
    const ch = Math.round(30 + 225 * intensity);
    return `\x1b[38;2;0;${ch};${ch}m`;
  }
  const v = Math.round(50 + 205 * intensity);
  return `\x1b[38;2;${v};${v};${v}m`;
}

/** Track last-known play state per player to detect changes. */
const lastPlayState = new Map<number, number>();
const lastMasterId: { value: number | null } = { value: null };

function isStatusChange(status: CdjStatus): boolean {
  const prev = lastPlayState.get(status.deviceId);
  lastPlayState.set(status.deviceId, status.playState);

  const masterChanged =
    (status.isMaster && lastMasterId.value !== status.deviceId) ||
    (!status.isMaster && lastMasterId.value === status.deviceId);
  if (status.isMaster) lastMasterId.value = status.deviceId;
  else if (lastMasterId.value === status.deviceId) lastMasterId.value = null;

  return prev !== status.playState || masterChanged;
}

// ---- JSON output helpers ----

function jsonBeat(beat: {
  deviceId: number;
  trackBpm: number;
  effectiveBpm: number;
  pitch: number;
  beatInBar: number;
}): object {
  return {
    type: 'beat',
    ts: Date.now(),
    playerId: beat.deviceId,
    trackBpm: beat.trackBpm,
    effectiveBpm: +beat.effectiveBpm.toFixed(2),
    pitch: +beat.pitch.toFixed(2),
    beatInBar: beat.beatInBar,
  };
}

function jsonStatus(s: CdjStatus): object {
  return {
    type: 'status',
    ts: Date.now(),
    playerId: s.deviceId,
    playState: s.playState,
    isPlaying: s.isPlaying,
    isMaster: s.isMaster,
    isSync: s.isSync,
    isOnAir: s.isOnAir,
    trackBpm: s.trackBpm,
    effectiveBpm: +s.effectiveBpm.toFixed(2),
    pitch: +s.pitch.toFixed(2),
    trackId: s.trackId,
    beatInBar: s.beatInBar,
  };
}

function jsonPhase(p: PhaseState): object {
  return {
    type: 'phase',
    ts: Date.now(),
    playerId: p.playerId,
    beat: +p.beat.toFixed(4),
    bar: +p.bar.toFixed(4),
    beatInBar: p.beatInBar,
    bpm: p.bpm,
    beatElapsed: +p.beatElapsed.toFixed(4),
    beatRemaining: +p.beatRemaining.toFixed(4),
    barElapsed: +p.barElapsed.toFixed(4),
    barRemaining: +p.barRemaining.toFixed(4),
  };
}

// ---- Observe command ----

async function runObserve(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      protocol: { type: 'string', default: 'prolink' },
      interface: { type: 'string' },
      id: { type: 'string' },
      name: { type: 'string' },
      passive: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      raw: { type: 'boolean', default: false },
      dump: { type: 'string' },
    },
  });

  if (values.protocol === 'stagelinq') {
    await runStageLinqObserve(values);
    return;
  }
  if (values.protocol !== 'prolink') {
    throw new Error(`Unknown protocol: ${values.protocol} (expected "prolink" or "stagelinq")`);
  }

  let id: number | undefined;
  if (values.id !== undefined) {
    id = Number.parseInt(values.id, 10);
    if (!Number.isInteger(id) || id < 0 || id > 0xff) {
      throw new Error(`--id must be 0..255, got ${JSON.stringify(values.id)}`);
    }
  }

  // Build the identity-options object with only the keys that were supplied,
  // so defaults inside `buildIdentity` apply for anything omitted. The
  // `exactOptionalPropertyTypes` compiler flag means we can't just pass
  // `{ interface: undefined }` — omit keys whose values would be undefined.
  const identity = buildIdentity({
    ...(values.interface !== undefined ? { interface: values.interface } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(values.name !== undefined ? { name: values.name } : {}),
  });

  const jsonMode = values.json;

  if (!jsonMode) {
    const mode = values.passive ? 'passive' : 'observer';
    console.log(`Starting ${mode} mode…`);
    console.log(`  announce identity: id=${identity.id} name=${JSON.stringify(identity.name)}`);
    console.log(`  interface: ${identity.ip}`);
    console.log('');
    console.log('Press Ctrl+C to stop.');
    console.log('');
  }

  const observer = new ProlinkObserver({ identity, passive: values.passive });

  // ---- Device events ----

  observer.onDevice((event, device) => {
    if (jsonMode) {
      console.log(
        JSON.stringify({
          type: 'device',
          ts: Date.now(),
          event,
          playerId: device.id,
          name: device.name,
          ip: device.ip,
          deviceType: device.type,
        }),
      );
    } else {
      console.log(
        `${ts()} device  ${event.padEnd(7)} id=${String(device.id).padStart(3)} ` +
          `type=${device.type.padEnd(9)} ${device.ip.padEnd(16)} ${JSON.stringify(device.name)}`,
      );
    }
  });

  // ---- Beat events ----

  observer.onBeat((beat) => {
    if (jsonMode) {
      console.log(JSON.stringify(jsonBeat(beat)));
      // Also emit the interpolated phase at beat boundary
      const phase = observer.getPhase(`prolink:${beat.deviceId}`);
      if (phase) console.log(JSON.stringify(jsonPhase(phase)));
    } else {
      console.log(
        `${ts()} beat    player=${beat.deviceId} ${beat.beatInBar}/4 ` +
          `bpm=${fmtBpm(beat.effectiveBpm)} pitch=${fmtPitch(beat.pitch)}`,
      );
    }
  });

  // ---- CDJ status events (log changes only in human mode, all in JSON) ----

  observer.onStatus((status) => {
    if (jsonMode) {
      console.log(JSON.stringify(jsonStatus(status)));
    } else if (isStatusChange(status)) {
      const stateNames: Record<number, string> = {
        0: 'empty',
        2: 'loading',
        3: 'playing',
        4: 'looping',
        5: 'paused',
        6: 'cued',
        7: 'cuing',
        8: 'held',
        9: 'searching',
        14: 'spun-down',
        17: 'ended',
      };
      const state = stateNames[status.playState] ?? `0x${status.playState.toString(16)}`;
      const flags = [
        status.isMaster ? 'MASTER' : null,
        status.isSync ? 'sync' : null,
        status.isOnAir ? 'on-air' : null,
      ]
        .filter(Boolean)
        .join(',');
      console.log(
        `${ts()} status  player=${status.deviceId} ${state.padEnd(9)} ` +
          `bpm=${fmtBpm(status.effectiveBpm)} ${flags ? `[${flags}]` : ''} ` +
          `track=${status.trackId}`,
      );
    }
  });

  // ---- Mixer status events ----

  observer.onMixerStatus((mixerStatus) => {
    if (jsonMode) {
      console.log(
        JSON.stringify({
          type: 'mixerStatus',
          ts: Date.now(),
          playerId: mixerStatus.deviceId,
          isMaster: mixerStatus.isMaster,
          bpm: mixerStatus.bpm,
        }),
      );
    } else {
      console.log(
        `${ts()} mixer   id=${mixerStatus.deviceId} bpm=${fmtBpm(mixerStatus.bpm)} ` +
          `${mixerStatus.isMaster ? '[MASTER]' : ''}`,
      );
    }
  });

  // ---- Channels-on-air events ----

  observer.onOnAir((onAir) => {
    const active = onAir.channels
      .map((on, i) => (on ? i + 1 : null))
      .filter((ch): ch is number => ch !== null);
    if (jsonMode) {
      console.log(
        JSON.stringify({
          type: 'onAir',
          ts: Date.now(),
          channels: onAir.channels,
          activeChannels: active,
        }),
      );
    } else {
      console.log(`${ts()} on-air  channels: ${active.length > 0 ? active.join(', ') : 'none'}`);
    }
  });

  // ---- Absolute position events (CDJ-3000) ----
  // These fire every ~30ms — only emit in JSON mode to avoid flooding.

  observer.onAbsolutePosition((pos) => {
    if (jsonMode) {
      console.log(
        JSON.stringify({
          type: 'position',
          ts: Date.now(),
          playerId: pos.deviceId,
          playhead: pos.playhead,
          trackLength: pos.trackLength,
          pitch: +pos.pitch.toFixed(2),
          trackBpm: pos.trackBpm,
        }),
      );
    }
  });

  // ---- Transport errors ----

  observer.onTransportError((err, port) => {
    if (jsonMode) {
      console.log(JSON.stringify({ type: 'error', ts: Date.now(), port, message: err.message }));
    } else {
      console.error(`[transport:${port}] ${err.message}`);
    }
  });

  // ---- Raw packet dump ----

  let dumpStream: WriteStream | undefined;
  if (values.dump) {
    dumpStream = createWriteStream(values.dump, { flags: 'a' });
    if (!jsonMode) console.log(`Dumping packets to ${values.dump}`);
  }

  if (values.raw || dumpStream) {
    observer.onPacket((kind, packet, remote, port) => {
      const kindHex = kind.toString(16).padStart(2, '0');
      if (values.raw && !jsonMode) {
        console.log(
          `  raw port=${port} kind=0x${kindHex} from ${remote.address}:${remote.port} len=${packet.length}`,
        );
      }
      if (dumpStream) {
        const record = {
          ts: Date.now(),
          kind: `0x${kindHex}`,
          port,
          src: `${remote.address}:${remote.port}`,
          len: packet.length,
          data: Buffer.from(packet).toString('base64'),
        };
        dumpStream.write(`${JSON.stringify(record)}\n`);
      }
    });
  }

  await observer.start();

  // Keep the process alive until SIGINT. The announcer and device-manager
  // timers are `.unref()`d, so we need an explicit block here.
  const shutdown = async (signal: string): Promise<void> => {
    if (!jsonMode) console.log(`\nReceived ${signal}, stopping…`);
    await observer.stop();
    if (dumpStream) {
      dumpStream.end();
      await new Promise<void>((resolve) => dumpStream?.on('finish', resolve));
      if (!jsonMode) console.log(`Capture written to ${values.dump}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // A never-resolving promise parks us here without busy-waiting.
  await new Promise<void>(() => {});
}

// ---- StageLinQ observe command ----

async function runStageLinqObserve(values: {
  interface?: string;
  name?: string;
  json?: boolean;
}): Promise<void> {
  const jsonMode = values.json ?? false;
  const observerName = values.name ?? 'netbeat';

  if (!jsonMode) {
    console.log('Starting StageLinQ observer mode\u2026');
    console.log(`  name: ${JSON.stringify(observerName)}`);
    if (values.interface) console.log(`  interface: ${values.interface}`);
    console.log('');
    console.log('Press Ctrl+C to stop.');
    console.log('');
  }

  const observer = new StageLinqObserver({
    name: observerName,
    ...(values.interface !== undefined ? { bindAddress: values.interface } : {}),
  });

  // ---- Device events ----

  observer.onDevice((event, dev) => {
    const device = dev as StageLinqDevice;
    if (jsonMode) {
      console.log(
        JSON.stringify({
          type: 'device',
          ts: Date.now(),
          event,
          deviceId: formatDeviceId(device.deviceId),
          name: device.model.name,
          source: device.source,
          address: device.address,
          category: device.model.category,
          deckCount: device.model.deckCount,
          softwareVersion: device.softwareVersion,
        }),
      );
    } else {
      console.log(
        `${ts()} device  ${event.padEnd(7)} ${device.model.name.padEnd(16)} ` +
          `${device.address.padEnd(16)} ${JSON.stringify(device.source)}`,
      );
    }
  });

  // ---- State changes ----

  observer.onStateChange((device, path, value) => {
    if (jsonMode) {
      console.log(
        JSON.stringify({
          type: 'state',
          ts: Date.now(),
          deviceId: formatDeviceId(device.deviceId),
          device: device.model.name,
          path,
          value,
        }),
      );
    } else {
      const displayValue = typeof value === 'string' ? JSON.stringify(value) : String(value);
      console.log(
        `${ts()} state   ${device.model.name.padEnd(12)} ${path.padEnd(45)} ${displayValue}`,
      );
    }
  });

  // ---- Beat info ----

  observer.onBeatInfo((device, decks, clock) => {
    if (jsonMode) {
      console.log(
        JSON.stringify({
          type: 'beatInfo',
          ts: Date.now(),
          deviceId: formatDeviceId(device.deviceId),
          device: device.model.name,
          clock: clock.toString(),
          decks: decks.map((d) => ({
            beat: +d.beat.toFixed(4),
            totalBeats: +d.totalBeats.toFixed(2),
            bpm: +d.bpm.toFixed(2),
            samples: +d.samples.toFixed(0),
          })),
        }),
      );
    }
    // Human mode: beat info fires very frequently — skip to avoid flooding.
    // Use `pulse` for live beat visualization.
  });

  await observer.start();

  const shutdown = async (signal: string): Promise<void> => {
    if (!jsonMode) console.log(`\nReceived ${signal}, stopping\u2026`);
    await observer.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await new Promise<void>(() => {});
}

// ---- StageLinQ pulse command ----

async function runStageLinqPulse(values: { interface?: string; name?: string }): Promise<void> {
  const observerName = values.name ?? 'netbeat';

  const observer = new StageLinqObserver({
    name: observerName,
    ...(values.interface !== undefined ? { bindAddress: values.interface } : {}),
  });

  // ---- State tracking ----

  /** Latest beat info per device (keyed by formatted DeviceId). */
  const deviceBeats = new Map<string, { decks: readonly DeckBeatInfo[]; clock: bigint }>();
  /** Latest state values per device, for track name display. */
  const deviceStates = new Map<string, Map<string, unknown>>();
  /** Track names we've already printed (to avoid re-printing). */
  const printedTracks = new Map<string, string>();
  let pulseLineCount = 0;

  // ---- Terminal helpers ----

  function clearPulseArea(): void {
    if (pulseLineCount > 0) {
      let buf = `\x1b[${pulseLineCount}A`;
      for (let i = 0; i < pulseLineCount; i++) {
        buf += `${ANSI_CLEAR_LINE}\n`;
      }
      buf += `\x1b[${pulseLineCount}A`;
      process.stdout.write(buf);
      pulseLineCount = 0;
    }
  }

  function printTrackLine(line: string): void {
    clearPulseArea();
    process.stdout.write(`${line}\n`);
  }

  // ---- Device events ----

  observer.onDevice((event, dev) => {
    const device = dev as StageLinqDevice;
    if (event === 'added') {
      printTrackLine(
        `${ANSI_DIM}${new Date().toLocaleTimeString('en-US', { hour12: false })}${ANSI_RESET}` +
          `  ${device.model.name} connected ${ANSI_DIM}(${device.address})${ANSI_RESET}`,
      );
    } else if (event === 'removed') {
      printTrackLine(
        `${ANSI_DIM}${new Date().toLocaleTimeString('en-US', { hour12: false })}${ANSI_RESET}` +
          `  ${device.model.name} disconnected`,
      );
      deviceBeats.delete(formatDeviceId(device.deviceId));
      deviceStates.delete(formatDeviceId(device.deviceId));
    }
  });

  // ---- State changes (track names) ----

  observer.onStateChange((device, path, value) => {
    const key = formatDeviceId(device.deviceId);
    let states = deviceStates.get(key);
    if (!states) {
      states = new Map();
      deviceStates.set(key, states);
    }
    states.set(path, value);

    // Detect track loads by SongName changes.
    if (path.endsWith('/Track/SongName') && typeof value === 'string' && value.length > 0) {
      const deckMatch = /Deck(\d+)/.exec(path);
      const deckNum = deckMatch ? deckMatch[1] : '?';
      const trackKey = `${key}:${deckNum}`;
      if (printedTracks.get(trackKey) !== value) {
        printedTracks.set(trackKey, value);
        const artist = states.get(path.replace('SongName', 'ArtistName'));
        const titleParts = [artist, value]
          .filter((s) => typeof s === 'string' && s.length > 0)
          .join(' \u2014 ');
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        printTrackLine(
          `${ANSI_DIM}${time}${ANSI_RESET}  Deck ${deckNum} ${ANSI_DIM}\u25b8${ANSI_RESET} ` +
            `${ANSI_BOLD}${titleParts}${ANSI_RESET}`,
        );
      }
    }
  });

  // ---- Beat info ----

  observer.onBeatInfo((device, decks, clock) => {
    const key = formatDeviceId(device.deviceId);
    deviceBeats.set(key, { decks, clock });
  });

  // ---- Render loop (30 fps) ----

  function renderPulse(): void {
    // Collect all decks with active beat data across all devices.
    const activeDeckLines: { label: string; beat: number; bpm: number }[] = [];

    for (const [, beatData] of deviceBeats) {
      for (let i = 0; i < beatData.decks.length; i++) {
        const deck = beatData.decks[i];
        if (!deck || deck.bpm <= 0) continue;
        activeDeckLines.push({
          label: `D${i + 1}`,
          beat: deck.beat,
          bpm: deck.bpm,
        });
      }
    }

    if (activeDeckLines.length === 0) {
      if (pulseLineCount > 0) clearPulseArea();
      return;
    }

    // Build the entire frame in one string to avoid flicker.
    let frame = '';

    if (pulseLineCount > 0) {
      frame += `\x1b[${pulseLineCount}A`;
    }

    let lines = 0;
    for (const dl of activeDeckLines) {
      frame += ANSI_CLEAR_LINE;

      // BeatInfo gives us the absolute beat position. The fractional part
      // tells us where we are within the current beat (0 = just hit, ~1 = about to hit next).
      // Beat-in-bar is beat mod 4 (1-indexed).
      const beatFrac = dl.beat - Math.floor(dl.beat);
      const beatInBar = (Math.floor(dl.beat) % 4) + 1;

      let bar = '';
      for (let b = 1; b <= 4; b++) {
        if (b === beatInBar) {
          bar += `${pulseColor(beatFrac, b === 1)}\u25cf${ANSI_RESET}`;
        } else {
          bar += `\x1b[38;2;50;50;50m\u00b7${ANSI_RESET}`;
        }
        if (b < 4) bar += ' ';
      }

      frame += `  ${dl.label}  ${bar}  ${dl.bpm.toFixed(1)}\n`;
      lines++;
    }

    // Clear leftover lines from a previous frame that had more decks.
    const staleLines = pulseLineCount - lines;
    if (staleLines > 0) {
      for (let i = 0; i < staleLines; i++) {
        frame += `${ANSI_CLEAR_LINE}\n`;
      }
      frame += `\x1b[${staleLines}A`;
    }

    process.stdout.write(frame);
    pulseLineCount = lines;
  }

  // ---- Start ----

  await observer.start();

  console.log(`netbeat pulse \u2014 stagelinq mode`);
  if (values.interface) console.log(`  interface: ${values.interface}`);
  console.log('Listening for StageLinQ devices\u2026 Press Ctrl+C to stop.\n');

  process.stdout.write(ANSI_HIDE_CURSOR);

  const renderInterval = setInterval(renderPulse, 33);

  const shutdown = async (signal: string): Promise<void> => {
    clearInterval(renderInterval);
    clearPulseArea();
    process.stdout.write(ANSI_SHOW_CURSOR);
    console.log(`Received ${signal}, stopping.`);
    await observer.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await new Promise<void>(() => {});
}

// ---- Pulse command ----

async function runPulse(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      protocol: { type: 'string', default: 'prolink' },
      interface: { type: 'string' },
      id: { type: 'string' },
      name: { type: 'string' },
      passive: { type: 'boolean', default: false },
      media: { type: 'string' },
    },
  });

  if (values.protocol === 'stagelinq') {
    await runStageLinqPulse(values);
    return;
  }
  if (values.protocol !== 'prolink') {
    throw new Error(`Unknown protocol: ${values.protocol} (expected "prolink" or "stagelinq")`);
  }

  let id: number | undefined;
  if (values.id !== undefined) {
    id = Number.parseInt(values.id, 10);
    if (!Number.isInteger(id) || id < 0 || id > 0xff) {
      throw new Error(`--id must be 0..255, got ${JSON.stringify(values.id)}`);
    }
  }

  const identity = buildIdentity({
    ...(values.interface !== undefined ? { interface: values.interface } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(values.name !== undefined ? { name: values.name } : {}),
  });

  // Optional local metadata source (USB export / rekordbox library)
  let metadataStore: MetadataStore | undefined;
  if (values.media) {
    const reader = new FilesystemMediaReader(values.media);
    metadataStore = new MetadataStore(reader);
    try {
      const count = await metadataStore.loadDatabase();
      console.log(`Loaded ${count} tracks from ${values.media}`);
    } catch (err) {
      console.error(
        `Warning: could not load PDB from ${values.media}: ${err instanceof Error ? err.message : err}`,
      );
      metadataStore = undefined;
    }
  }

  const observer = new ProlinkObserver({
    identity,
    passive: values.passive,
    ...(metadataStore !== undefined ? { metadataStore } : {}),
  });

  // ---- State ----

  const pulseLastTrackId = new Map<number, number>();
  const deckAnalysis = new Map<number, TrackAnalysis>();
  const deckBeatCounter = new Map<number, number>();
  let pulseLineCount = 0;

  // ---- Terminal helpers ----

  function clearPulseArea(): void {
    if (pulseLineCount > 0) {
      let buf = `\x1b[${pulseLineCount}A`;
      for (let i = 0; i < pulseLineCount; i++) {
        buf += `${ANSI_CLEAR_LINE}\n`;
      }
      buf += `\x1b[${pulseLineCount}A`;
      process.stdout.write(buf);
      pulseLineCount = 0;
    }
  }

  function printTrackLine(line: string): void {
    clearPulseArea();
    process.stdout.write(`${line}\n`);
  }

  // ---- Track change detection ----

  observer.onStatus((status) => {
    deckBeatCounter.set(status.deviceId, status.beatCounter);

    const prev = pulseLastTrackId.get(status.deviceId);
    pulseLastTrackId.set(status.deviceId, status.trackId);

    // Print a track-change line when no metadata store is configured.
    // With a metadata store, onTrackAnalysis prints the richer version.
    if (status.trackId !== prev && status.trackId > 0 && !metadataStore) {
      const time = new Date().toLocaleTimeString('en-US', { hour12: false });
      printTrackLine(
        `${ANSI_DIM}${time}${ANSI_RESET}  Deck ${status.deviceId} ${ANSI_DIM}▸${ANSI_RESET} ` +
          `Track ${status.trackId}  ${ANSI_DIM}${fmtBpm(status.effectiveBpm)} BPM${ANSI_RESET}`,
      );
    }
  });

  // ---- Metadata enrichment ----

  observer.onTrackAnalysis((playerId, analysis) => {
    deckAnalysis.set(playerId, analysis);
    if (analysis.metadata) {
      const m = analysis.metadata;
      const time = new Date().toLocaleTimeString('en-US', { hour12: false });
      const titleParts = [m.artist, m.title].filter(Boolean).join(' \u2014 ');
      const extras = [m.bpm ? `${fmtBpm(m.bpm)} BPM` : null, m.key || null]
        .filter(Boolean)
        .join('  ');
      printTrackLine(
        `${ANSI_DIM}${time}${ANSI_RESET}  Deck ${playerId} ${ANSI_DIM}\u25b8${ANSI_RESET} ` +
          `${ANSI_BOLD}${titleParts}${ANSI_RESET}  ${ANSI_DIM}${extras}${ANSI_RESET}`,
      );
    }
  });

  // ---- Phrase lookup ----

  function findCurrentPhrase(analysis: TrackAnalysis, beatCounter: number): string | null {
    if (!analysis.phrases || beatCounter === 0 || beatCounter >= 0xffffffff) return null;
    let currentKind: string | null = null;
    for (const p of analysis.phrases.phrases) {
      if (p.beatNumber <= beatCounter) {
        currentKind = p.kind;
      } else {
        break;
      }
    }
    return currentKind;
  }

  // ---- Render loop (30 fps) ----

  function renderPulse(): void {
    const phases = observer.phases();
    if (phases.length === 0) {
      if (pulseLineCount > 0) clearPulseArea();
      return;
    }

    phases.sort((a, b) => a.playerId - b.playerId);

    // Build the entire frame in one string to avoid flicker from
    // multiple writes (each write triggers a terminal repaint).
    let frame = '';

    if (pulseLineCount > 0) {
      frame += `\x1b[${pulseLineCount}A`;
    }

    let lines = 0;
    for (const phase of phases) {
      frame += ANSI_CLEAR_LINE;

      // 4-beat bar: active beat pulses with 24-bit color, others dim.
      let bar = '';
      for (let b = 1; b <= 4; b++) {
        if (b === phase.beatInBar) {
          bar += `${pulseColor(phase.beat, b === 1)}\u25cf${ANSI_RESET}`;
        } else {
          bar += `\x1b[38;2;50;50;50m\u00b7${ANSI_RESET}`;
        }
        if (b < 4) bar += ' ';
      }

      // Current phrase section (if metadata available).
      const analysis = deckAnalysis.get(phase.playerId);
      const beatCount = deckBeatCounter.get(phase.playerId) ?? 0;
      let phraseStr = '';
      if (analysis) {
        const phrase = findCurrentPhrase(analysis, beatCount);
        if (phrase) phraseStr = `  ${ANSI_DIM}${phrase}${ANSI_RESET}`;
      }

      frame += `  ${phase.playerId}  ${bar}  ${phase.bpm.toFixed(1)}${phraseStr}\n`;
      lines++;
    }

    // Clear leftover lines from a previous frame that had more decks.
    const staleLines = pulseLineCount - lines;
    if (staleLines > 0) {
      for (let i = 0; i < staleLines; i++) {
        frame += `${ANSI_CLEAR_LINE}\n`;
      }
      frame += `\x1b[${staleLines}A`;
    }

    process.stdout.write(frame);
    pulseLineCount = lines;
  }

  // ---- Start ----

  await observer.start();

  const mode = values.passive ? 'passive' : 'observer';
  console.log(`netbeat pulse \u2014 ${mode} mode on ${identity.ip}`);
  console.log('Listening for beats\u2026 Press Ctrl+C to stop.\n');

  process.stdout.write(ANSI_HIDE_CURSOR);

  const renderInterval = setInterval(renderPulse, 33);

  const shutdown = async (signal: string): Promise<void> => {
    clearInterval(renderInterval);
    clearPulseArea();
    process.stdout.write(ANSI_SHOW_CURSOR);
    console.log(`Received ${signal}, stopping.`);
    await observer.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await new Promise<void>(() => {});
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === 'interfaces') {
    printInterfaces();
    return;
  }
  if (command === 'observe') {
    await runObserve(rest);
    return;
  }
  if (command === 'pulse') {
    await runPulse(rest);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run `netbeat help` for usage.');
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
