import { describe, expect, it } from 'bun:test';
import type { DeckState, Device, Observer, PhaseState } from '../src/types.js';
import { UnifiedObserver } from '../src/unified.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 'test:1',
    name: 'Test Device',
    category: 'player',
    address: '10.0.0.1',
    deckCount: 1,
    protocol: 'prolink',
    ...overrides,
  };
}

function makePhase(overrides: Partial<PhaseState> = {}): PhaseState {
  return {
    beat: 0.5,
    bar: 0.125,
    beatInBar: 1,
    bpm: 128,
    beatElapsed: 0.234,
    beatRemaining: 0.234,
    barElapsed: 0.234,
    barRemaining: 1.64,
    ...overrides,
  };
}

function makeDeck(overrides: Partial<DeckState> = {}): DeckState {
  return {
    id: 'test:1:1',
    device: makeDevice(),
    deckNumber: 1,
    isPlaying: true,
    bpm: 128,
    phase: makePhase(),
    isMaster: false,
    isOnAir: true,
    track: { title: 'Test Track', artist: 'Test Artist' },
    ...overrides,
  };
}

/** Minimal mock Observer for testing UnifiedObserver delegation. */
function mockObserver(overrides: Partial<Observer> = {}): Observer {
  return {
    start: async () => {},
    stop: async () => {},
    onDevice: () => () => {},
    onDeckUpdate: () => () => {},
    devices: () => [],
    decks: () => [],
    getDeck: () => null,
    get phase() {
      return null;
    },
    getPhase: () => null,
    phases: () => [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('UnifiedObserver', () => {
  describe('lifecycle', () => {
    it('starts all child observers', async () => {
      let aStarted = false;
      let bStarted = false;

      const unified = new UnifiedObserver([
        mockObserver({
          start: async () => {
            aStarted = true;
          },
        }),
        mockObserver({
          start: async () => {
            bStarted = true;
          },
        }),
      ]);

      await unified.start();
      expect(aStarted).toBe(true);
      expect(bStarted).toBe(true);
    });

    it('stops all child observers', async () => {
      let aStopped = false;
      let bStopped = false;

      const unified = new UnifiedObserver([
        mockObserver({
          stop: async () => {
            aStopped = true;
          },
        }),
        mockObserver({
          stop: async () => {
            bStopped = true;
          },
        }),
      ]);

      await unified.stop();
      expect(aStopped).toBe(true);
      expect(bStopped).toBe(true);
    });

    it('tolerates partial start failure', async () => {
      const unified = new UnifiedObserver([
        mockObserver({
          start: async () => {
            throw new Error('bind failed');
          },
        }),
        mockObserver(), // succeeds
      ]);

      // Should not throw — one observer succeeded
      await unified.start();
    });

    it('throws when all observers fail to start', async () => {
      const unified = new UnifiedObserver([
        mockObserver({
          start: async () => {
            throw new Error('fail A');
          },
        }),
        mockObserver({
          start: async () => {
            throw new Error('fail B');
          },
        }),
      ]);

      await expect(unified.start()).rejects.toThrow('fail A');
    });
  });

  describe('devices', () => {
    it('merges devices from all observers', () => {
      const devA = makeDevice({ id: 'prolink:1', name: 'CDJ-3000', protocol: 'prolink' });
      const devB = makeDevice({ id: 'stagelinq:abc', name: 'SC6000', protocol: 'stagelinq' });

      const unified = new UnifiedObserver([
        mockObserver({ devices: () => [devA] }),
        mockObserver({ devices: () => [devB] }),
      ]);

      const result = unified.devices();
      expect(result).toHaveLength(2);
      expect(result[0]?.name).toBe('CDJ-3000');
      expect(result[1]?.name).toBe('SC6000');
    });
  });

  describe('decks', () => {
    it('merges decks from all observers', () => {
      const deckA = makeDeck({ id: 'prolink:1:1', bpm: 128 });
      const deckB = makeDeck({ id: 'stagelinq:abc:1', bpm: 140 });

      const unified = new UnifiedObserver([
        mockObserver({ decks: () => [deckA] }),
        mockObserver({ decks: () => [deckB] }),
      ]);

      expect(unified.decks()).toHaveLength(2);
    });

    it('getDeck searches all observers', () => {
      const deck = makeDeck({ id: 'stagelinq:abc:2' });

      const unified = new UnifiedObserver([
        mockObserver(), // no decks
        mockObserver({ getDeck: (id) => (id === 'stagelinq:abc:2' ? deck : null) }),
      ]);

      expect(unified.getDeck('stagelinq:abc:2')).toBe(deck);
      expect(unified.getDeck('nonexistent')).toBeNull();
    });
  });

  describe('phase', () => {
    it('returns first non-null phase', () => {
      const phase = makePhase({ bpm: 140 });

      const unified = new UnifiedObserver([
        mockObserver(), // null phase
        mockObserver({
          get phase() {
            return phase;
          },
        }),
      ]);

      expect(unified.phase).toBe(phase);
    });

    it('returns null when no observer has phase', () => {
      const unified = new UnifiedObserver([mockObserver(), mockObserver()]);
      expect(unified.phase).toBeNull();
    });

    it('getPhase searches all observers', () => {
      const phase = makePhase({ bpm: 175 });

      const unified = new UnifiedObserver([
        mockObserver(),
        mockObserver({ getPhase: (id) => (id === 'stagelinq:x:1' ? phase : null) }),
      ]);

      expect(unified.getPhase('stagelinq:x:1')?.bpm).toBe(175);
      expect(unified.getPhase('nonexistent')).toBeNull();
    });

    it('merges phases from all observers', () => {
      const phaseA = makePhase({ bpm: 128 });
      const phaseB = makePhase({ bpm: 140 });

      const unified = new UnifiedObserver([
        mockObserver({ phases: () => [phaseA] }),
        mockObserver({ phases: () => [phaseB] }),
      ]);

      expect(unified.phases()).toHaveLength(2);
    });
  });

  describe('events', () => {
    it('onDevice forwards from all observers', () => {
      const events: string[] = [];

      const unified = new UnifiedObserver([
        mockObserver({
          onDevice: (listener) => {
            listener('added', makeDevice({ id: 'a' }));
            return () => {};
          },
        }),
        mockObserver({
          onDevice: (listener) => {
            listener('added', makeDevice({ id: 'b' }));
            return () => {};
          },
        }),
      ]);

      unified.onDevice((_event, device) => {
        events.push(device.id);
      });

      expect(events).toEqual(['a', 'b']);
    });

    it('onDevice unsubscribe removes from all observers', () => {
      let aRemoved = false;
      let bRemoved = false;

      const unified = new UnifiedObserver([
        mockObserver({
          onDevice: () => () => {
            aRemoved = true;
          },
        }),
        mockObserver({
          onDevice: () => () => {
            bRemoved = true;
          },
        }),
      ]);

      const unsub = unified.onDevice(() => {});
      unsub();

      expect(aRemoved).toBe(true);
      expect(bRemoved).toBe(true);
    });

    it('onDeckUpdate forwards from all observers', () => {
      const ids: string[] = [];

      const unified = new UnifiedObserver([
        mockObserver({
          onDeckUpdate: (listener) => {
            listener(makeDeck({ id: 'deck-a' }));
            return () => {};
          },
        }),
        mockObserver({
          onDeckUpdate: (listener) => {
            listener(makeDeck({ id: 'deck-b' }));
            return () => {};
          },
        }),
      ]);

      unified.onDeckUpdate((deck) => {
        ids.push(deck.id);
      });

      expect(ids).toEqual(['deck-a', 'deck-b']);
    });
  });

  describe('empty', () => {
    it('works with zero observers', async () => {
      const unified = new UnifiedObserver([]);
      await unified.start();

      expect(unified.devices()).toEqual([]);
      expect(unified.decks()).toEqual([]);
      expect(unified.phase).toBeNull();
      expect(unified.phases()).toEqual([]);

      await unified.stop();
    });
  });
});
