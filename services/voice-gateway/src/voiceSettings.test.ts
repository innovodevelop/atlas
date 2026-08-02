import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VOICE_SETTINGS,
  resolveVoiceSettings,
  toElevenLabsVoiceSettings,
  type VoiceSettings,
} from "./voiceSettings.ts";

describe("resolveVoiceSettings", () => {
  test("absent input yields the shipped defaults", () => {
    // The compatibility guarantee: a client that sends nothing must sound
    // exactly like it did before voice settings existed.
    expect(resolveVoiceSettings(undefined)).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(resolveVoiceSettings(null)).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  test("a partial object keeps defaults for the fields it omits", () => {
    const r = resolveVoiceSettings({ speed: 0.9 });
    expect(r.speed).toBe(0.9);
    expect(r.stability).toBe(DEFAULT_VOICE_SETTINGS.stability);
    expect(r.speakerBoost).toBe(DEFAULT_VOICE_SETTINGS.speakerBoost);
  });

  test("out-of-range values are clamped, not rejected", () => {
    // A bad value must degrade to sane audio rather than fail the turn.
    const high = resolveVoiceSettings({ stability: 99, similarityBoost: 5, style: 2, speed: 100 });
    expect(high.stability).toBe(1);
    expect(high.similarityBoost).toBe(1);
    expect(high.style).toBe(1);
    expect(high.speed).toBe(1.2);

    const low = resolveVoiceSettings({ stability: -4, similarityBoost: -1, style: -0.5, speed: 0 });
    expect(low.stability).toBe(0);
    expect(low.similarityBoost).toBe(0);
    expect(low.style).toBe(0);
    expect(low.speed).toBe(0.7);
  });

  test("speed honours ElevenLabs' asymmetric 0.7–1.2 range", () => {
    expect(resolveVoiceSettings({ speed: 0.7 }).speed).toBe(0.7);
    expect(resolveVoiceSettings({ speed: 1.2 }).speed).toBe(1.2);
    expect(resolveVoiceSettings({ speed: 0.69 }).speed).toBe(0.7);
    expect(resolveVoiceSettings({ speed: 1.21 }).speed).toBe(1.2);
  });

  test("non-numeric and non-finite values fall back to the default", () => {
    const junk = { stability: "loud", style: NaN, speed: Infinity } as unknown as VoiceSettings;
    const r = resolveVoiceSettings(junk);
    expect(r.stability).toBe(DEFAULT_VOICE_SETTINGS.stability);
    expect(r.style).toBe(DEFAULT_VOICE_SETTINGS.style);
    expect(r.speed).toBe(DEFAULT_VOICE_SETTINGS.speed);
  });

  test("speakerBoost only accepts a real boolean", () => {
    expect(resolveVoiceSettings({ speakerBoost: false }).speakerBoost).toBe(false);
    expect(resolveVoiceSettings({ speakerBoost: true }).speakerBoost).toBe(true);
    const coerced = { speakerBoost: "yes" } as unknown as VoiceSettings;
    expect(resolveVoiceSettings(coerced).speakerBoost).toBe(DEFAULT_VOICE_SETTINGS.speakerBoost);
  });

  test("a non-object payload does not throw", () => {
    expect(resolveVoiceSettings("nope" as unknown as VoiceSettings)).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(resolveVoiceSettings(42 as unknown as VoiceSettings)).toEqual(DEFAULT_VOICE_SETTINGS);
  });
});

describe("toElevenLabsVoiceSettings", () => {
  test("emits ElevenLabs' snake_case wire shape", () => {
    expect(toElevenLabsVoiceSettings({ stability: 0.2, similarityBoost: 0.4, style: 0.6, speed: 1.1, speakerBoost: false }))
      .toEqual({
        stability: 0.2,
        similarity_boost: 0.4,
        style: 0.6,
        speed: 1.1,
        use_speaker_boost: false,
      });
  });

  test("the default payload matches what shipped before this was tunable", () => {
    // Guards the one behaviour change we must NOT make silently: existing users
    // should not hear a different Atlas after upgrading.
    const d = toElevenLabsVoiceSettings(undefined);
    expect(d.stability).toBe(0.5);
    expect(d.similarity_boost).toBe(0.75);
    expect(d.style).toBe(0.3);
    expect(d.use_speaker_boost).toBe(true);
  });
});
