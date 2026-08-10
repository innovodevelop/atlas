import { describe, expect, it } from 'bun:test';
import { emailFromSpeech, intentFromSpeech } from './loginSpeech';

describe('intentFromSpeech', () => {
  it('reads a returning user', () => {
    expect(intentFromSpeech('Yes, we have met before')).toBe('signin');
    expect(intentFromSpeech('yeah')).toBe('signin');
    expect(intentFromSpeech('sign in please')).toBe('signin');
    expect(intentFromSpeech('log in')).toBe('signin');
  });

  it('reads a new user', () => {
    expect(intentFromSpeech('No, we are just meeting')).toBe('signup');
    expect(intentFromSpeech('nope')).toBe('signup');
    expect(intentFromSpeech('I am new here')).toBe('signup');
    expect(intentFromSpeech('sign up')).toBe('signup');
  });

  /**
   * The ordering trap the function is written around. Both of these contain
   * "met"; a yes-first implementation sends every new user to a sign-in form
   * that can only ever reject them.
   */
  it('does not let "met" inside a negative answer mean sign-in', () => {
    expect(intentFromSpeech("No, we've never met")).toBe('signup');
    expect(intentFromSpeech('no we are just meeting for the first time')).toBe('signup');
  });

  it('refuses to guess when it cannot tell', () => {
    expect(intentFromSpeech('what is this')).toBeNull();
    expect(intentFromSpeech('')).toBeNull();
    // "know" contains the letters of "no" but not the word, so it must not
    // read as a negative answer.
    expect(intentFromSpeech('I know')).toBeNull();
  });
});

describe('emailFromSpeech', () => {
  it('accepts an address the model already punctuated', () => {
    expect(emailFromSpeech('magnus@example.com')).toBe('magnus@example.com');
  });

  it('accepts one that was spelled out loud', () => {
    expect(emailFromSpeech('magnus at example dot com')).toBe('magnus@example.com');
    expect(emailFromSpeech('a dot b at example dot com')).toBe('a.b@example.com');
  });

  it('handles the separators people actually say', () => {
    expect(emailFromSpeech('first dash last at example dot com')).toBe('first-last@example.com');
    expect(emailFromSpeech('first underscore last at example dot com')).toBe(
      'first_last@example.com',
    );
  });

  /** Transcription punctuates sentences; an address is not a sentence. */
  it('drops trailing sentence punctuation', () => {
    expect(emailFromSpeech('magnus@example.com.')).toBe('magnus@example.com');
    expect(emailFromSpeech('magnus at example dot com?')).toBe('magnus@example.com');
  });

  it('never leaves whitespace in the result', () => {
    expect(emailFromSpeech('  Magnus At Example Dot Com  ')).toBe('magnus@example.com');
  });
});
