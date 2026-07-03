import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, corsHeaders, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { aiChatCompletion, hasAIKey } from "../_shared/aiGateway.ts";

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { messages } = await req.json();

    if (!hasAIKey()) {
      return errorResponse("No AI key configured (GEMINI_API_KEY)", 500);
    }

    console.log("[chat] Processing request with", messages.length, "messages");

    const response = await aiChatCompletion({
        model: "google/gemini-2.5-flash",
        messages: [
          { 
            role: "system", 
            content: `You are Atlas, an advanced AI Research Assistant. You are helpful, knowledgeable, and conversational.
            
You can assist with:
- Email management and organization
- Document creation and editing
- Travel planning and flight/hotel search
- Financial data and stock information
- Company research and people search
- General knowledge and task assistance

Keep your responses clear, concise, and friendly. When discussing data or search results, present them in a structured, easy-to-understand format.` 
          },
          ...messages,
        ],
        stream: true,
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.error("[chat] Rate limit exceeded");
        return errorResponse("Rate limits exceeded, please try again later.", 429);
      }
      if (response.status === 402) {
        console.error("[chat] Payment required");
        return errorResponse("Payment required, please add funds to your workspace.", 402);
      }
      const errorText = await response.text();
      console.error("[chat] AI gateway error:", response.status, errorText);
      return errorResponse("AI gateway error", 500);
    }

    console.log("[chat] Streaming response from AI gateway");
    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("[chat] Error:", error);
    return errorResponse(error instanceof Error ? error.message : "Unknown error");
  }
});
