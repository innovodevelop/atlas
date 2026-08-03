import { Mic, Volume2, Sparkles } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAtlasSettings, type AtlasSettings } from '@/hooks/useAtlasSettings';
import { useStreamingTTS } from '@/hooks/useStreamingTTS';

// Curated ElevenLabs voices — each one verified to work via API on the free
// plan (several premade voices, e.g. Aria/Rachel/Charlotte, are API-blocked
// for free accounts with "paid_plan_required").
const VOICES: Array<{ id: string; name: string; description: string }> = [
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'Soft, warm (default)' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'Calm, British' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', description: 'Deep, authoritative' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', description: 'Clear, velvety' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni', description: 'Well-rounded, friendly' },
];

const MODELS: Array<{ id: AtlasSettings['ttsModel']; name: string; description: string }> = [
  { id: 'eleven_turbo_v2_5', name: 'Turbo v2.5', description: 'Fast, great quality (default)' },
  { id: 'eleven_flash_v2_5', name: 'Flash v2.5', description: 'Lowest latency (~75ms)' },
  { id: 'eleven_multilingual_v2', name: 'Multilingual v2', description: 'Highest quality, slower' },
];

export const VoiceSettingsPanel = () => {
  const { settings, setSetting } = useAtlasSettings();
  const { speak, isPlaying } = useStreamingTTS();

  const previewVoice = () => {
    const voice = VOICES.find(v => v.id === settings.voiceId);
    void speak(
      `Hi, I'm Atlas — this is the ${voice?.name ?? 'selected'} voice.`,
      settings.voiceId,
      settings.ttsModel,
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Volume2 className="w-4 h-4 text-violet-400" />
        <h4 className="font-medium">Voice Output</h4>
      </div>

      <div className="grid gap-4 pl-6">
        <div className="grid gap-2">
          <Label>Voice</Label>
          <div className="flex items-center gap-2">
            <Select
              value={settings.voiceId}
              onValueChange={(value) => setSetting('voiceId', value)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a voice" />
              </SelectTrigger>
              <SelectContent>
                {VOICES.map((voice) => (
                  <SelectItem key={voice.id} value={voice.id}>
                    {voice.name} — {voice.description}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={previewVoice} disabled={isPlaying}>
              <Sparkles className="w-4 h-4 mr-1" />
              Preview
            </Button>
          </div>
        </div>

        <div className="grid gap-2">
          <Label>Speech model</Label>
          <Select
            value={settings.ttsModel}
            onValueChange={(value) => setSetting('ttsModel', value as AtlasSettings['ttsModel'])}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODELS.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name} — {model.description}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Mic className="w-4 h-4 text-cyan-400" />
        <h4 className="font-medium">Voice Input</h4>
      </div>

      <div className="grid gap-4 pl-6">
        {/*
          The "Voice isolation" switch was removed here, deliberately.

          It promised: "Removes background noise and other voices before
          transcribing. Improves accuracy in noisy places; adds ~1s and uses
          extra credits." None of that happened. The ONLY occurrences of
          `voiceIsolation` in the entire repo were its type declaration
          (useAtlasSettings.ts:52) and its default (:184) — nothing in
          useVoiceSession.ts, services/voice-gateway/ or src-tauri/ ever read
          it. It was a switch that stored a boolean and changed nothing, while
          telling the user it cost them time and money.

          Compare `ttsModel` in this same panel, which IS plumbed through
          (AtlasDashboard.tsx:102 -> useVoiceSession.ts:200 ->
          voice-gateway/src/session.ts:309). That is what a wired control looks
          like.

          To bring it back properly: ElevenLabs exposes audio isolation as its
          own endpoint, so the gateway would need to run the captured audio
          through that before handing it to Scribe, and `voiceIsolation` would
          have to reach the gateway the way `ttsModel` does. Until someone does
          that, the honest UI is no control at all.

          The `voiceIsolation` key is left in useAtlasSettings for now rather
          than removed, because that file is owned by the sphere/music track
          this week and a stored key costs nothing. It has no reader.
        */}
      </div>
    </div>
  );
};
