import { describe, expect, test } from 'bun:test';
import { escapeAction, isTypingTarget } from './betaScreenKeys';

const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as EventTarget;

describe('Esc on the Core, Teach and Architecture screens', () => {
  test('fields are recognised by tag, and contenteditable counts', () => {
    expect(isTypingTarget(el('INPUT'))).toBe(true);
    expect(isTypingTarget(el('textarea'))).toBe(true);
    expect(isTypingTarget(el('SELECT'))).toBe(true);
    expect(isTypingTarget(el('DIV', true))).toBe(true);
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  test('Esc in a field leaves the field; elsewhere it steps out', () => {
    expect(escapeAction({ key: 'Escape', target: el('INPUT') })).toBe('blur');
    expect(escapeAction({ key: 'Escape', target: el('MAIN') })).toBe('step');
  });

  test('other keys, modifiers and a handled event are left alone', () => {
    expect(escapeAction({ key: 'Enter', target: el('MAIN') })).toBe('ignore');
    expect(escapeAction({ key: 'Escape', metaKey: true, target: el('MAIN') })).toBe('ignore');
    expect(escapeAction({ key: 'Escape', altKey: true, target: el('MAIN') })).toBe('ignore');
    // The Talk panel handles Esc first and prevents it.
    expect(escapeAction({ key: 'Escape', defaultPrevented: true, target: el('MAIN') })).toBe('ignore');
  });
});
