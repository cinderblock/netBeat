import { describe, expect, test } from 'bun:test';
import { classifyDevice, lookupModel } from '../../src/protocol/devices.js';

describe('Device classification', () => {
  test('lookupModel returns known devices', () => {
    const sc6000 = lookupModel('JP13');
    expect(sc6000).toBeDefined();
    expect(sc6000?.name).toBe('SC6000');
    expect(sc6000?.category).toBe('player');
    expect(sc6000?.deckCount).toBe(2);

    const prime4 = lookupModel('JC11');
    expect(prime4).toBeDefined();
    expect(prime4?.name).toBe('PRIME 4');
    expect(prime4?.category).toBe('controller');
    expect(prime4?.deckCount).toBe(4);

    const x1850 = lookupModel('JM10');
    expect(x1850).toBeDefined();
    expect(x1850?.name).toBe('X1850');
    expect(x1850?.category).toBe('mixer');
    expect(x1850?.deckCount).toBe(0);
  });

  test('lookupModel returns undefined for unknown code', () => {
    expect(lookupModel('ZZZZ')).toBeUndefined();
  });

  test('classifyDevice returns model for known code', () => {
    const model = classifyDevice('JP13');
    expect(model.name).toBe('SC6000');
    expect(model.category).toBe('player');
  });

  test('classifyDevice returns generic for unknown code', () => {
    const model = classifyDevice('XX99');
    expect(model.code).toBe('XX99');
    expect(model.name).toBe('XX99');
    expect(model.category).toBe('unknown');
    expect(model.deckCount).toBe(0);
  });

  test('all players have 2 decks', () => {
    for (const code of ['JP07', 'JP08', 'JP13', 'JP14']) {
      const model = lookupModel(code);
      expect(model?.category).toBe('player');
      expect(model?.deckCount).toBe(2);
    }
  });

  test('SC LIVE 4 has 4 decks', () => {
    const model = lookupModel('JP21');
    expect(model?.name).toBe('SC LIVE 4');
    expect(model?.deckCount).toBe(4);
  });
});
