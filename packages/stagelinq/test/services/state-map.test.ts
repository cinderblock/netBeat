import { describe, expect, test } from 'bun:test';
import { ReadContext } from '../../src/protocol/read-context.js';
import { SERVICE_MAGIC } from '../../src/protocol/services.js';
import { WriteContext } from '../../src/protocol/write-context.js';
import {
  buildStateMapSubscribe,
  buildStateMapSubscriptions,
  hasStateMapMagic,
  parseStateMapMessage,
  parseStateValue,
  STATE_MAP_MSG,
} from '../../src/services/state-map.js';

describe('StateMap', () => {
  test('hasStateMapMagic recognizes "smaa"', () => {
    expect(hasStateMapMagic(SERVICE_MAGIC.STATE_MAP)).toBe(true);
    expect(hasStateMapMagic(new Uint8Array([0x73, 0x6d, 0x61, 0x61, 0x00]))).toBe(true);
    expect(hasStateMapMagic(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBe(false);
    expect(hasStateMapMagic(new Uint8Array([0x73, 0x6d]))).toBe(false);
  });

  test('parseStateMapMessage parses state update', () => {
    const w = new WriteContext();
    w.writeBytes(SERVICE_MAGIC.STATE_MAP);
    w.writeUInt32(STATE_MAP_MSG.STATE_UPDATE);
    w.writeNetworkString('/Engine/Deck1/Play');
    w.writeNetworkString('1');

    const result = parseStateMapMessage(w.finish());
    expect(result).not.toBeNull();
    expect(result?.path).toBe('/Engine/Deck1/Play');
    expect(result?.jsonValue).toBe('1');
  });

  test('parseStateMapMessage returns null for subscribe messages', () => {
    const w = new WriteContext();
    w.writeBytes(SERVICE_MAGIC.STATE_MAP);
    w.writeUInt32(STATE_MAP_MSG.SUBSCRIBE);
    w.writeNetworkString('/Engine/Deck1/Play');
    w.writeInt32(0);

    expect(parseStateMapMessage(w.finish())).toBeNull();
  });

  test('parseStateMapMessage returns null for wrong magic', () => {
    const w = new WriteContext();
    w.writeBytes(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
    w.writeUInt32(STATE_MAP_MSG.STATE_UPDATE);
    w.writeNetworkString('/test');
    w.writeNetworkString('42');

    expect(parseStateMapMessage(w.finish())).toBeNull();
  });

  test('parseStateMapMessage returns null for truncated data', () => {
    expect(parseStateMapMessage(new Uint8Array(4))).toBeNull();
    expect(parseStateMapMessage(new Uint8Array(0))).toBeNull();
  });

  test('buildStateMapSubscribe format', () => {
    const buf = buildStateMapSubscribe('/Engine/Deck1/CurrentBPM', 0);
    const ctx = new ReadContext(buf);
    // Magic "smaa"
    expect(ctx.readFixedString(4)).toBe('smaa');
    // Type: subscribe
    expect(ctx.readUInt32()).toBe(STATE_MAP_MSG.SUBSCRIBE);
    // Path
    expect(ctx.readNetworkString()).toBe('/Engine/Deck1/CurrentBPM');
    // Interval
    expect(ctx.readInt32()).toBe(0);
  });

  test('buildStateMapSubscribe with custom interval', () => {
    const buf = buildStateMapSubscribe('/Engine/Deck1/Speed', 100);
    const ctx = new ReadContext(buf);
    ctx.skip(4); // magic
    ctx.readUInt32(); // type
    ctx.readNetworkString(); // path
    expect(ctx.readInt32()).toBe(100);
  });

  test('buildStateMapSubscriptions creates one payload per path', () => {
    const paths = ['/Engine/Deck1/Play', '/Engine/Deck2/Play'];
    const payloads = buildStateMapSubscriptions(paths);
    expect(payloads.length).toBe(2);

    for (let i = 0; i < paths.length; i++) {
      const payload = payloads[i];
      expect(payload).toBeDefined();
      const ctx = new ReadContext(payload ?? new Uint8Array(0));
      ctx.skip(4); // magic
      expect(ctx.readUInt32()).toBe(STATE_MAP_MSG.SUBSCRIBE);
      expect(ctx.readNetworkString()).toBe(paths[i]);
    }
  });

  test('parseStateValue parses JSON numbers', () => {
    expect(parseStateValue('128.5')).toBe(128.5);
    expect(parseStateValue('0')).toBe(0);
  });

  test('parseStateValue parses JSON booleans', () => {
    expect(parseStateValue('true')).toBe(true);
    expect(parseStateValue('false')).toBe(false);
  });

  test('parseStateValue parses JSON strings', () => {
    expect(parseStateValue('"hello"')).toBe('hello');
  });

  test('parseStateValue returns raw string for non-JSON', () => {
    expect(parseStateValue('not-json')).toBe('not-json');
  });
});
