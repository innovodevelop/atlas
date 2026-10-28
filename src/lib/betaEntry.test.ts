import { describe, expect, test } from 'bun:test';
import {
  FIELD_ORDER, MAX_NAME, afterSignInPath, askVerb, authEyebrow, authSphereState, authSubline, autocompleteFor, callName,
  countWord, enterLabel, fieldType, introAskLine, micAllowed, nextLabel, onboardingSphereState, permsButton,
  permsSubline, promptFor, spokenForAuthError, stepIndex, summaryRows, trailFor, typedLength, validateField, welcomeLine,
} from './betaEntry';

describe('the credential conversation', () => {
  test('sign-in asks two things, sign-up three, in the design’s order', () => {
    expect(FIELD_ORDER.signin).toEqual(['email', 'password']);
    expect(FIELD_ORDER.signup).toEqual(['name', 'email', 'password']);
  });
  test('prompts use the name once there is one', () => {
    expect(promptFor('signin', 'email', '')).toBe('Welcome back. What’s your email?');
    expect(promptFor('signup', 'email', 'Marcus')).toBe('Nice to meet you, Marcus. What’s your email?');
    expect(promptFor('signup', 'email', '   ')).toBe('Nice to meet you. What’s your email?');
    expect(promptFor('signup', 'password', 'x')).toBe('Now pick a password to keep it safe.');
  });
  test('callName keeps the whole answer, minus the noise', () => {
    // "What should I call you?" — the answer is the name, not its first word.
    expect(callName('  Mads   Peter ')).toBe('Mads Peter');
    expect(callName('Marcus.')).toBe('Marcus');
    expect(callName('')).toBe('');
    expect(callName('x'.repeat(80))).toHaveLength(MAX_NAME);
  });
  test('validation: empty, email shape, new passwords only', () => {
    expect(validateField('email', '', 'signin')).toBe('This one can’t be empty.');
    expect(validateField('email', 'marcus', 'signin')).toBe('That doesn’t look like an email address.');
    expect(validateField('email', 'm@example.com', 'signin')).toBeNull();
    expect(validateField('password', 'short', 'signup')).toBe('Use at least 8 characters.');
    // A sign-in password is the account’s business, not this screen’s.
    expect(validateField('password', 'short', 'signin')).toBeNull();
    expect(validateField('name', 'M', 'signup')).toBeNull();
  });
  test('field attributes', () => {
    expect(fieldType('password')).toBe('password');
    expect(fieldType('email')).toBe('email');
    expect(fieldType('name')).toBe('text');
    expect(autocompleteFor('password', 'signin')).toBe('current-password');
    expect(autocompleteFor('password', 'signup')).toBe('new-password');
    expect(autocompleteFor('name', 'signup')).toBe('given-name');
  });
  test('the action button says what it does', () => {
    expect(nextLabel('field', 'email', 'signin', false)).toBe('Next');
    expect(nextLabel('field', 'password', 'signin', false)).toBe('Sign in');
    expect(nextLabel('field', 'password', 'signup', false)).toBe('Create account');
    expect(nextLabel('forgot', 'email', 'signin', false)).toBe('Send me a link →');
    expect(nextLabel('forgot', 'email', 'signin', true)).toBe('Sending…');
    expect(nextLabel('field', 'password', 'signin', true)).toBe('One moment…');
  });
  test('a network failure is not blamed on the user', () => {
    expect(spokenForAuthError("Couldn't reach the account server. Check your connection.")).toMatch(/couldn’t reach/i);
    expect(spokenForAuthError("Couldn't reach the account server.", 'signup')).toMatch(/couldn’t reach/i);
    expect(spokenForAuthError('Invalid email or password.')).toBe('That didn’t match what I have. Want to try again?');
  });
  test('a refused sign-up is not called a mismatch', () => {
    expect(spokenForAuthError('An account with that email already exists.', 'signup')).toBe('I couldn’t create that account. The reason is just below.');
  });
  test('after sign-in: consent first on a Mac that has never answered it', () => {
    expect(afterSignInPath(false)).toBe('/permissions');
    expect(afterSignInPath(true)).toBe('/');
    expect(enterLabel(true)).toBe('Enter Atlas →');
    expect(enterLabel(false)).toBe('Continue →');
  });
  test('the trail shows earlier answers during sign-up only', () => {
    const vals = { name: 'Marcus', email: 'm@example.com', password: 'x' };
    expect(trailFor('signin', 'password', vals)).toEqual([]);
    expect(trailFor('signup', 'name', vals)).toEqual([]);
    expect(trailFor('signup', 'email', vals)).toEqual([{ k: 'Name', v: 'Marcus' }]);
    expect(trailFor('signup', 'password', vals)).toEqual([{ k: 'Name', v: 'Marcus' }, { k: 'Email', v: 'm@example.com' }]);
  });
  test('eyebrow', () => {
    expect(authEyebrow('start', null)).toBe('Atlas');
    expect(authEyebrow('field', 'signup')).toBe('Create your account');
    expect(authEyebrow('field', 'signin')).toBe('Sign in');
    expect(authEyebrow('forgot', 'signin')).toBe('Sign in');
  });
});

describe('the microphone rule', () => {
  test('never on the password step, never outside a question', () => {
    expect(micAllowed('field', 'password')).toBe(false);
    expect(micAllowed('field', 'email')).toBe(true);
    expect(micAllowed('field', 'name')).toBe(true);
    expect(micAllowed('forgot', 'email')).toBe(true);
    expect(micAllowed('start', null)).toBe(false);
    expect(micAllowed('done', null)).toBe(false);
    expect(micAllowed('sent', null)).toBe(false);
  });
  test('the status line only claims what is true', () => {
    expect(authSubline('field', true, 'listening')).toBe('Type this one. I stop listening for passwords.');
    expect(authSubline('field', false, 'listening')).toBe('I’m listening, or just type.');
    expect(authSubline('field', false, 'off')).toBe('Type it, or tap the microphone.');
    expect(authSubline('field', false, 'denied')).toMatch(/Typing works/);
    expect(authSubline('field', false, 'unavailable')).toMatch(/please type/);
    expect(authSubline('start', false, 'off')).toBe('Tell me where to begin.');
    expect(authSubline('sent', false, 'off')).toBe('Check your inbox.');
    expect(authSubline('done', false, 'off')).toBe('Everything is ready.');
  });
});

describe('the sphere', () => {
  test('sign-in: listening, thinking, or the bus — never speaking, because nothing is said', () => {
    expect(authSphereState(true, true)).toBe('listening');
    expect(authSphereState(false, true)).toBe('thinking');
    expect(authSphereState(false, false)).toBeUndefined();
  });
  test('onboarding: working only while macOS is being asked', () => {
    expect(onboardingSphereState('asking')).toBe('working');
    expect(onboardingSphereState('intro')).toBeUndefined();
    expect(onboardingSphereState('welcome')).toBeUndefined();
  });
});

describe('the typewriter', () => {
  test('two characters a tick, clamped to the line', () => {
    expect(typedLength(10, 0)).toBe(0);
    expect(typedLength(10, 3)).toBe(6);
    expect(typedLength(10, 50)).toBe(10);
    expect(typedLength(0, 5)).toBe(0);
  });
});

describe('onboarding', () => {
  test('steps', () => {
    expect(stepIndex('intro')).toBe(0);
    expect(stepIndex('perms')).toBe(1);
    expect(stepIndex('asking')).toBe(1);
    expect(stepIndex('welcome')).toBe(2);
  });
  test('counts as words', () => {
    expect(countWord(3)).toBe('three');
    expect(countWord(2, true)).toBe('Two');
    expect(countWord(0)).toBe('none');
    expect(countWord(12)).toBe('12');
  });
  test('the permissions subline is counted, not hard-coded', () => {
    expect(permsSubline(2, 4)).toBe('Two of these make macOS ask you. Two are just Atlas settings.');
    expect(permsSubline(1, 2)).toBe('One of these makes macOS ask you. One is just an Atlas setting.');
    expect(permsSubline(0, 3)).toBe('None of these need macOS. Three are just Atlas settings.');
    expect(permsSubline(2, 2)).toBe('Two of these make macOS ask you.');
  });
  test('the intro’s third row follows the count', () => {
    expect(introAskLine(2)).toBe('macOS asks you itself for the two that need its permission.');
    expect(introAskLine(1)).toMatch(/the one that needs/);
    expect(introAskLine(0)).toMatch(/all Atlas settings/);
  });
  test('only the two real system prompts have a verb', () => {
    expect(askVerb('microphone')).toBe('access the microphone');
    expect(askVerb('notifications')).toBe('send you notifications');
    expect(askVerb('liveData')).toBe('');
    expect(askVerb('proactive')).toBe('');
  });
  test('welcome line and button', () => {
    expect(welcomeLine('Marcus')).toBe('Welcome, Marcus. I’m ready when you are.');
    expect(welcomeLine(null)).toBe('Welcome. I’m ready when you are.');
    expect(welcomeLine('  ')).toBe('Welcome. I’m ready when you are.');
    expect(welcomeLine(' Mads  Peter ')).toBe('Welcome, Mads Peter. I’m ready when you are.');
    expect(permsButton(true)).toBe('Continue');
    expect(permsButton(false)).toBe('Continue without any');
  });
  test('the summary writes "Declined in macOS" only from a real refusal', () => {
    const perms = [
      { id: 'microphone' as const, title: 'Microphone', osPrompt: true },
      { id: 'notifications' as const, title: 'Notifications', osPrompt: true },
      { id: 'liveData' as const, title: 'Live data', osPrompt: false },
      { id: 'proactive' as const, title: 'Proactive digest', osPrompt: false },
    ];
    const rows = summaryRows(perms, { microphone: true, notifications: true, liveData: true, proactive: false }, { microphone: false });
    expect(rows.map((r) => r.value)).toEqual(['Declined in macOS', 'On', 'On', 'Off']);
    expect(rows.map((r) => r.tone)).toEqual(['denied', 'on', 'on', 'off']);
    // An app-side switch cannot be "declined" by macOS, whatever the record says.
    expect(summaryRows(perms, { liveData: true }, { liveData: false })[2].value).toBe('On');
    // A switched-off capability that macOS once refused is simply off.
    expect(summaryRows(perms, { microphone: false }, { microphone: false })[0].value).toBe('Off');
  });
});
