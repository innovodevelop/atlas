import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUser, authErrorResponse } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // WS-A: defense in depth alongside verify_jwt — any logged-in user only.
  try { await requireUser(req); } catch (e) { return authErrorResponse(e); }

  try {
    const { text, voiceId = "EXAVITQu4vr4xnSDxMaL", modelId = "eleven_turbo_v2_5" } = await req.json();

    // Only allow known TTS models (client input reaches billing)
    const ALLOWED_MODELS = ["eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_multilingual_v2"];
    const model = ALLOWED_MODELS.includes(modelId) ? modelId : "eleven_turbo_v2_5";
    const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");

    if (!ELEVENLABS_API_KEY) {
      throw new Error("ELEVENLABS_API_KEY is not configured");
    }

    if (!text) {
      throw new Error("Text is required");
    }

    console.log("[tts-stream] Streaming TTS for text:", text.substring(0, 50) + "...");

    // Use turbo model with streaming endpoint for faster response
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: model,
          output_format: "mp3_44100_128",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.3, // Lower style for faster processing
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("[tts-stream] ElevenLabs TTS error:", error);
      throw new Error(`Failed to generate speech: ${error}`);
    }

    console.log("[tts-stream] Starting audio stream");

    // Stream the audio directly
    return new Response(response.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (error) {
    console.error("[tts-stream] TTS error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
