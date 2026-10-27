import { beforeEach, describe, expect, test } from 'bun:test';
import {
  ATLAS_BUS_STATES, STATE_COLOUR, STATE_LABEL, _resetAtlasStateBus, getAtlasState, hasVoiceOwner,
  onVoiceRequest, publishAtlasState, requestVoice, subscribeAtlasState,
} from './atlasStateBus';

describe('atlasStateBus', () => {
  beforeEach(() => _resetAtlasStateBus());

  test('starts idle, and the last publisher wins', () => {
    expect(getAtlasState().state).toBe('idle');
    publishAtlasState('listening', 'presence');
    publishAtlasState('thinking', 'talk');
    expect(getAtlasState()).toMatchObject({ state: 'thinking', source: 'talk' });
  });

  test('notifies subscribers once per change and not for a repeat', () => {
    let n = 0;
    const off = subscribeAtlasState(() => { n += 1; });
    publishAtlasState('working', 'presence');
    publishAtlasState('working', 'presence');
    publishAtlasState('idle', 'presence');
    expect(n).toBe(2);
    off();
    publishAtlasState('alert', 'presence');
    expect(n).toBe(2);
  });

  test('a voice request reaches the owner, and reports when nobody owns the mic', () => {
    expect(hasVoiceOwner()).toBe(false);
    expect(requestVoice()).toBe(false);
    let started = 0;
    const off = onVoiceRequest(() => { started += 1; });
    expect(hasVoiceOwner()).toBe(true);
    expect(requestVoice()).toBe(true);
    expect(started).toBe(1);
    off();
    expect(requestVoice()).toBe(false);
  });

  test('every state has a label and a colour for the top bar', () => {
    for (const s of ATLAS_BUS_STATES) {
      expect(STATE_LABEL[s]).toBeTruthy();
      expect(STATE_COLOUR[s]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
