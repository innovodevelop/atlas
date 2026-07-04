import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { audio, userId, storeTranscript = true, mimeType = "audio/webm", extension = "webm" } = await req.json();
    const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

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

    // Prepare form data. The client sends whatever container its engine can
    // record (webm/opus in Chrome, mp4/aac in WKWebView) — pass it through.
    const formData = new FormData();
    const blob = new Blob([bytes.buffer], { type: mimeType });
    formData.append("file", blob, `audio.${extension}`);
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
    if (storeTranscript && transcriptText.length > 10 && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        
        // Store the voice transcript as a knowledge entry
        const { error: insertError } = await supabase
          .from("atlas_knowledge_entries")
          .insert([{
            user_id: userId || null,
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
