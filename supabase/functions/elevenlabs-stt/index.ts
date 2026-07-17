import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getUserClient } from "../_shared/supabase.ts";
import { requireUser, AuthError, authErrorResponse } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Identity from the verified JWT — never from the body.
    const { userId, token } = await requireUser(req);
    const { audio, storeTranscript = true, mimeType = "audio/webm", extension = "webm", isolate = false } = await req.json();
    const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");

    if (!ELEVENLABS_API_KEY) {
      throw new Error("ELEVENLABS_API_KEY is not configured");
    }

    if (!audio) {
      throw new Error("No audio data provided");
    }

    console.log("Processing STT request, user:", userId);

    // Decode base64 to binary
    const binaryString = atob(audio);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // The client sends whatever container its engine can record
    // (webm/opus in Chrome, mp4/aac in WKWebView) — pass it through.
    let sttBlob = new Blob([bytes.buffer], { type: mimeType });
    let sttFilename = `audio.${extension}`;

    // Optional: isolate the speaker's voice (removes background noise/other
    // voices) before transcription. Best-effort — on any failure we transcribe
    // the original audio rather than block the request.
    if (isolate) {
      try {
        const isolationForm = new FormData();
        isolationForm.append("audio", sttBlob, sttFilename);
        const isolationResponse = await fetch("https://api.elevenlabs.io/v1/audio-isolation", {
          method: "POST",
          headers: { "xi-api-key": ELEVENLABS_API_KEY },
          body: isolationForm,
        });
        if (isolationResponse.ok) {
          const isolatedBuffer = await isolationResponse.arrayBuffer();
          sttBlob = new Blob([isolatedBuffer], { type: "audio/mpeg" });
          sttFilename = "audio.mp3";
          console.log(`[stt] Voice isolation applied (${isolatedBuffer.byteLength} bytes)`);
        } else {
          console.warn(`[stt] Voice isolation failed (${isolationResponse.status}), using original audio`);
        }
      } catch (isolationError) {
        console.warn("[stt] Voice isolation error, using original audio:", isolationError);
      }
    }

    // Prepare form data for transcription
    const formData = new FormData();
    formData.append("file", sttBlob, sttFilename);
    formData.append("model_id", "scribe_v1");
    formData.append("tag_audio_events", "false");
    formData.append("diarize", "false");

    // Send to ElevenLabs
    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("ElevenLabs STT error:", error);
      throw new Error(`Failed to transcribe: ${error}`);
    }

    const result = await response.json();
    const transcriptText = result.text || "";
    console.log("STT successful, text length:", transcriptText.length);

    // Store the transcript in the knowledge bank if enabled
    if (storeTranscript && transcriptText.length > 10) {
      try {
        // User-scoped write — RLS applies.
        const supabase = getUserClient(token);

        // Store the voice transcript as a knowledge entry
        const { error: insertError } = await supabase
          .from("atlas_knowledge_entries")
          .insert([{
            user_id: userId,
            topic: `Voice message - ${new Date().toLocaleString()}`,
            content: {
              transcript: transcriptText,
              timestamp: new Date().toISOString(),
              type: "voice_input",
              word_count: transcriptText.split(/\s+/).length,
            },
            category: "conversation",
            source: "voice_transcription",
            confidence: 0.9,
            relevance_score: 0.8,
          }]);

        if (insertError) {
          console.error("Failed to store transcript:", insertError);
        } else {
          console.log("Stored voice transcript in knowledge bank");
        }
      } catch (storeError) {
        console.error("Error storing transcript:", storeError);
      }
    }

    return new Response(
      JSON.stringify({ 
        text: transcriptText,
        stored: storeTranscript && transcriptText.length > 10
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error("STT error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
