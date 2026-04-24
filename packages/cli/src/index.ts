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
  listInterfaces,
  Observer,
  type PhaseState,
  PORTS,
  PROTOCOL,
} from '@netbeat/prolink';

function printHelp(): void {
  console.log('netbeat — pre-alpha');
  console.log(`  protocol: ${PROTOCOL}`);
  console.log(
    `  udp ports: ${Object.values(PORTS)
      .sort((a, b) => a - b)
      .join(', ')}`,
  );
  console.log('');
  console.log('Usage: netbeat <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  observe           Announce as a virtual CDJ and log discovered devices');
  console.log('  interfaces        List IPv4 interfaces netbeat could announce from');
  console.log('');
  console.log('`observe` options:');
  console.log('  --interface <n>   Interface name or IP to announce from');
  console.log('  --id <n>          Player number to claim (default 7, avoid 1..4)');
  console.log('  --name <s>        Device name to broadcast (≤ 20 ASCII chars)');
  console.log('  --passive         Receive only, do not announce');
  console.log('  --json            Output events as JSONL (one JSON object per line)');
  console.log('  --raw             Also log raw inbound packet kinds');
  console.log('  --dump <file>     Write JSONL raw packet capture to <file>');
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
      interface: { type: 'string' },
      id: { type: 'string' },
      name: { type: 'string' },
      passive: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      raw: { type: 'boolean', default: false },
      dump: { type: 'string' },
    },
  });

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

  const observer = new Observer({ identity, passive: values.passive });

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
      const phase = observer.getPhase(beat.deviceId);
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

  console.error(`Unknown command: ${command}`);
  console.error('Run `netbeat help` for usage.');
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
