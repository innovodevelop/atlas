import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { requireUser, authErrorResponse } from "../_shared/auth.ts";

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // WS-A: defense in depth alongside verify_jwt — any logged-in user only.
  try { await requireUser(req); } catch (e) { return authErrorResponse(e); }

  try {
    const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");

    if (!ELEVENLABS_API_KEY) {
      return errorResponse("ELEVENLABS_API_KEY is not configured", 500);
    }

    console.log("[scribe-token] Generating single-use token for Scribe v2 Realtime");

    const response = await fetch(
      "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("[scribe-token] ElevenLabs error:", response.status, error);
      return errorResponse(`Failed to get token: ${error}`, response.status);
    }

    const data = await response.json();
    console.log("[scribe-token] Token generated successfully");

    return jsonResponse({ token: data.token });
  } catch (error) {
    console.error("[scribe-token] Error:", error);
    return errorResponse(error instanceof Error ? error.message : "Unknown error");
  }
});
