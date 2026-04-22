#!/usr/bin/env node
/**
 * `netbeat` — diagnostic CLI.
 *
 * Status: pre-alpha. Currently exposes one meaningful subcommand,
 * `observe`, which starts observer mode and prints discovered devices
 * to stdout as they come and go. Beat / status parsing is not yet
 * implemented; those will get their own flags once the parsers land.
 */

import { parseArgs } from 'node:util';
import { buildIdentity, listInterfaces, Observer, PORTS, PROTOCOL } from '@netbeat/prolink';

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
  console.log('  --raw             Also log raw inbound packet kinds');
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

async function runObserve(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      interface: { type: 'string' },
      id: { type: 'string' },
      name: { type: 'string' },
      passive: { type: 'boolean', default: false },
      raw: { type: 'boolean', default: false },
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

  const mode = values.passive ? 'passive' : 'observer';
  console.log(`Starting ${mode} mode…`);
  console.log(`  announce identity: id=${identity.id} name=${JSON.stringify(identity.name)}`);
  console.log(`  interface: ${identity.ip}`);
  console.log('');
  console.log('Press Ctrl+C to stop.');
  console.log('');

  const observer = new Observer({ identity, passive: values.passive });

  observer.onDevice((event, device) => {
    const ts = new Date().toISOString();
    console.log(
      `${ts} ${event.padEnd(7)} id=${String(device.id).padStart(3)} ` +
        `type=${device.type.padEnd(9)} ${device.ip.padEnd(16)} ${JSON.stringify(device.name)}`,
    );
  });

  observer.onTransportError((err, port) => {
    console.error(`[transport:${port}] ${err.message}`);
  });

  if (values.raw) {
    observer.onPacket((kind, packet, remote, port) => {
      const kindHex = kind.toString(16).padStart(2, '0');
      console.log(
        `  raw port=${port} kind=0x${kindHex} from ${remote.address}:${remote.port} len=${packet.length}`,
      );
    });
  }

  await observer.start();

  // Keep the process alive until SIGINT. The announcer and device-manager
  // timers are `.unref()`d, so we need an explicit block here.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}, stopping…`);
    await observer.stop();
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
