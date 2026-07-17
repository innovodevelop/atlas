import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { requireUser, authErrorResponse } from "../_shared/auth.ts";

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // WS-A: defense in depth alongside verify_jwt — any logged-in user only.
  try { await requireUser(req); } catch (e) { return authErrorResponse(e); }

  try {
    const { text, voiceId = "EXAVITQu4vr4xnSDxMaL", modelId = "eleven_multilingual_v2" } = await req.json();

    // Only allow known TTS models (client input reaches billing)
    const ALLOWED_MODELS = ["eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_multilingual_v2"];
    const model = ALLOWED_MODELS.includes(modelId) ? modelId : "eleven_multilingual_v2";
    const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");

    if (!ELEVENLABS_API_KEY) {
      return errorResponse("ELEVENLABS_API_KEY is not configured", 500);
    }

    if (!text) {
      return errorResponse("Text is required", 400);
    }

    console.log("Generating TTS for text:", text.substring(0, 50) + "...");

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
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
            style: 0.5,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("ElevenLabs TTS error:", error);
      return errorResponse(`Failed to generate speech: ${error}`, response.status);
    }

    const audioBuffer = await response.arrayBuffer();
    
    // Convert to base64 manually
    const bytes = new Uint8Array(audioBuffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    const base64Audio = btoa(binary);

    console.log("TTS generated successfully, audio length:", audioBuffer.byteLength);

    return jsonResponse({ audioContent: base64Audio });
  } catch (error) {
    console.error("TTS error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(message);
  }
});
