# @netbeat/prolink

Read-only observer for the Pioneer **Pro DJ Link** protocol.

> **Status:** pre-alpha. Observer mode (device discovery) works; beat and
> status parsing are not yet implemented.

Part of the [netBeat](../../README.md) project. See
[`docs/protocol-reference.md`](../../docs/protocol-reference.md) for protocol
offsets and [`docs/research.md`](../../docs/research.md) for prior art.

## Install

```bash
bun add @netbeat/prolink
# or
npm install @netbeat/prolink
```

## Two read-only modes

- **Observer mode** (default) — announces ourselves as a virtual CDJ every
  1.5 s so peers unicast their status packets to our port-50002 socket.
  Never sends sync, control, load-track, or fader-start commands.
- **Passive mode** (`passive: true`) — receives broadcasts only; no
  announcements. Gets keep-alives, beats, channels-on-air, and CDJ-3000
  absolute-position. Misses unicast-gated CDJ status.

See [`docs/research.md`](../../docs/research.md) "Notes on read-only
ethics" for the rationale.

## Usage

```ts
import { Observer, buildIdentity } from '@netbeat/prolink';

const identity = buildIdentity({
  // Pick an interface by name or IP (required on multi-NIC hosts).
  interface: 'Ethernet',
  // Observer-mode default is 7 — outside the 1..4 range real CDJs use.
  id: 7,
  name: 'netbeat',
});

const observer = new Observer({ identity });

observer.onDevice((event, device) => {
  console.log(event, device.id, device.type, device.name, device.ip);
});

await observer.start();

// later…
await observer.stop();
```

## What the observer currently exposes

- Device discovery via keep-alive packets (port 50000, kind `0x06`).
  Events: `added`, `updated`, `removed`.
- A raw-packet hook (`observer.onPacket`) that fires for every validated
  inbound packet — useful for prototyping parsers for other kinds before
  they move into the library.

Planned next:

- Beat packet parser (port 50001, kind `0x28`) — BPM, beat-within-bar, phase.
- CDJ status packet parser (port 50002, kind `0x0a`) — track ID, play state,
  master/sync/on-air flags, effective pitch, beat counter.
- CDJ-3000 absolute-position parser (port 50001, kind `0x0b`).
- Track metadata over remotedb (TCP) and local-DB scrape (NFS).

## Low-level primitives

For advanced users building their own transport or tooling:

```ts
import {
  PROLINK_HEADER,
  PORTS,
  DiscoveryKind,
  BeatKind,
  StatusKind,
  parseKeepAlive,
  buildKeepAlive,
  hasProlinkHeader,
  readKind,
  UdpTransport,
} from '@netbeat/prolink';
```
