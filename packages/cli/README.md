# @netbeat/cli

Diagnostic CLI for the [netBeat](../../README.md) project.

> **Status:** pre-alpha. Observer mode is wired up; beat/status dumping
> arrives once those parsers land in
> [`@netbeat/prolink`](../prolink).

## Install

```bash
bun add -g @netbeat/cli
# or
npm install -g @netbeat/cli
```

## Usage

```bash
netbeat help              # show available subcommands
netbeat interfaces        # list IPv4 interfaces netbeat could announce from
netbeat observe           # announce as a virtual CDJ and log discovered devices
```

### `observe` — device discovery

```bash
netbeat observe --interface Ethernet --id 7 --name netbeat
```

Flags:

| Flag | Default | Purpose |
|------|---------|---------|
| `--interface <name\|ip>` | first non-loopback | Which NIC to announce from |
| `--id <n>` | `7` | Player number to claim (avoid 1..4) |
| `--name <s>` | `netbeat` | Broadcast name (≤ 20 ASCII chars) |
| `--passive` | off | Receive-only; skip the 1.5 s announce loop |
| `--raw` | off | Also log every inbound packet's port+kind+size |

The process stays running until Ctrl+C. Each line looks like:

```
2026-04-21T15:42:17.213Z added   id=  1 type=cdj       192.168.1.11     "CDJ-3000"
```
