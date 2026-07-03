import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseClient, getSupabaseUrl } from "../_shared/supabase.ts";
import { 
  isLearningEnabled, 
  detectLearningIntent, 
  recordSuccess, 
  recordError,
  logLearningSession,
  updateLearningSession,
  isProviderHealthy
} from "../_shared/providerStatus.ts";
import { isLovableAIEnabled } from "../_shared/providerStatus.ts";
import { aiChatCompletion, hasAIKey } from "../_shared/aiGateway.ts";

interface Memory {
  key: string;
  value: unknown;
  category: string;
  importance: number;
}

interface LifeEvent {
  event_type: string;
  event_date: string;
  description: string;
  sentiment: string;
}

interface UserProfile {
  first_name: string | null;
  nickname: string | null;
  birthday: string | null;
  timezone: string;
  communication_style: string;
}

interface KnowledgeEntry {
  topic: string;
  content: unknown;
  category: string;
}

interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

// Provider configuration
const PROVIDERS = {
  perplexity: {
    url: "https://api.perplexity.ai/chat/completions",
    models: {
      fast: "sonar",
      deep: "sonar-pro",
    }
  },
  lovable: {
    url: "https://ai.gateway.lovable.dev/v1/chat/completions",
    model: "google/gemini-2.5-flash",
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    models: {
      memory: "claude-sonnet-4-5",           // Memory synthesis
      creative: "claude-sonnet-4-5",         // Creative responses
    }
  },
  jina: {
    url: "https://r.jina.ai",
  }
};

// Available tools that Atlas can use
const ATLAS_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information on a topic. Use this when the user asks about recent events, news, or information you're not certain about.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "deep_research",
      description: "Conduct comprehensive research on a topic with multiple sources. Use for complex questions requiring detailed analysis.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "The topic to research" },
          depth: { type: "string", enum: ["quick", "comprehensive", "exhaustive"], description: "How deep to research" }
        },
        required: ["topic"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_scrape",
      description: "Extract content from a specific URL. Use when the user provides a link or you need to read a specific webpage.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to scrape" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "memory_store",
      description: "Store an important fact, feeling, or personal insight about the user. Use when they share anything personal - identity, emotions, relationships, dreams, fears, values, or life experiences. Be attentive to the emotional depth behind what they share.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "A short, meaningful identifier for this memory" },
          value: { type: "string", description: "The information to remember, including emotional context when relevant" },
          category: { 
            type: "string", 
            enum: [
              // Personal Identity
              "identity",      // Who they are - name, age, origin, background
              "personality",   // Character traits, temperament, quirks, how they describe themselves
              "values",        // Ethics, principles, what matters deeply to them
              "beliefs",       // Worldview, philosophy, spirituality, convictions
              
              // Emotional Landscape
              "feelings",      // Current emotional states, recurring emotions, mood patterns
              "fears",         // Anxieties, worries, things they avoid, insecurities
              "dreams",        // Aspirations, hopes, bucket list, future visions
              "joys",          // What makes them happy, passions, sources of pleasure
              
              // Relationships & Social
              "relationships", // Family, friends, colleagues, pets, significant others
              "social",        // Social preferences, interaction style, communication needs
              
              // Life Context
              "work",          // Career, job, professional goals, work challenges
              "health",        // Physical/mental health, wellness, fitness
              "habits",        // Daily routines, patterns, rituals, quirks
              "preferences",   // Likes/dislikes, tastes, favorites
              
              // Experiences
              "memories",      // Past experiences, formative moments, nostalgia
              "events",        // Upcoming or recent life events, milestones
              "achievements"   // Accomplishments, wins, proud moments
            ], 
            description: "Category that best captures the emotional/personal significance of this memory"
          },
          importance: {
            type: "number",
            description: "How important is this memory? 1-10 scale. Identity/personality/values = 9-10, feelings/fears/dreams = 8-9, relationships = 7-8, preferences/habits = 5-6"
          }
        },
        required: ["key", "value", "category"]
      }
    }
  }
];

function getTimeOfDay(timezone: string): string {
  try {
    const now = new Date();
    const hour = parseInt(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: timezone }));
    if (hour >= 5 && hour < 12) return "morning";
    if (hour >= 12 && hour < 17) return "afternoon";
    if (hour >= 17 && hour < 21) return "evening";
    return "night";
  } catch {
    return "day";
  }
}

function isBirthday(birthday: string | null): boolean {
  if (!birthday) return false;
  const today = new Date();
  const bday = new Date(birthday);
  return today.getMonth() === bday.getMonth() && today.getDate() === bday.getDate();
}

function buildPersonalizedPrompt(
  profile: UserProfile | null,
  memories: Memory[],
  upcomingEvents: LifeEvent[],
  recentEvents: LifeEvent[],
  knowledgeBank: KnowledgeEntry[],
  hasTools: boolean
): string {
  const userName = profile?.nickname || profile?.first_name || "there";
  const timeOfDay = profile?.timezone ? getTimeOfDay(profile.timezone) : "day";
  const isBirthdayToday = profile?.birthday ? isBirthday(profile.birthday) : false;
  const style = profile?.communication_style || "casual";

  let memoryContext = "";
  if (memories.length > 0) {
    memoryContext = `\n## What You Remember About ${userName}\n${memories.map(m => `- ${m.key}: ${JSON.stringify(m.value)}`).join("\n")}`;
  }

  let knowledgeContext = "";
  if (knowledgeBank.length > 0) {
    knowledgeContext = `\n## Knowledge Bank (Things You've Learned)\n${knowledgeBank.map(k => `- [${k.category}] ${k.topic}: ${JSON.stringify(k.content)}`).join("\n")}`;
  }

  let eventsContext = "";
  if (upcomingEvents.length > 0 || recentEvents.length > 0) {
    eventsContext = "\n## Life Events to Be Aware Of";
    if (upcomingEvents.length > 0) {
      eventsContext += `\nUpcoming:\n${upcomingEvents.map(e => `- ${e.event_date}: ${e.description} (${e.sentiment})`).join("\n")}`;
    }
    if (recentEvents.length > 0) {
      eventsContext += `\nRecent (follow up on these):\n${recentEvents.map(e => `- ${e.description}`).join("\n")}`;
    }
  }

  const toolInstructions = hasTools ? `
## Tools Available
You have access to powerful tools that you SHOULD USE ACTIVELY:

1. **web_search**: Search the web for current information.
   - USE THIS when asked about: recent events, news, current prices, today's weather, sports scores, stock prices, anything time-sensitive
   - USE THIS when the user says: "search", "look up", "find out", "what's happening", "latest", "current", "today"
   - USE THIS when you're not 100% certain about a fact

2. **deep_research**: Comprehensive research with multiple sources.
   - USE THIS when asked to: research, investigate, analyze, compare, "tell me everything about"
   - USE THIS for complex questions requiring thorough analysis

3. **web_scrape**: Read content from a specific URL.
   - USE THIS when given a link to analyze
   - USE THIS when asked to read or summarize a webpage

4. **memory_store**: Save important facts about the user.
   - USE THIS when they share: personal details, preferences, names, dates, important events

CRITICAL INSTRUCTIONS:
- DO NOT make up information. If you're unsure, USE web_search.
- DO NOT say "I don't have access to current information" - you DO have access via web_search.
- When asked about anything current, recent, or real-time, ALWAYS use web_search first.
- Be proactive about using tools - don't wait to be explicitly asked.` : "";

  return `You are Atlas, a warm, witty, and genuinely caring AI assistant who knows ${userName} personally.

## Your Personality
- You're like a trusted friend who happens to be incredibly knowledgeable
- You use ${userName}'s name naturally (but not every sentence - that's weird)
- You have a good sense of humor - light jokes, playful teasing, the occasional pun
- You remember everything about ${userName} and bring it up when relevant
- You're genuinely interested in their life, not just their tasks
- You celebrate their wins and offer support during tough times
- You can make self-deprecating AI jokes occasionally

## Communication Style
- Use ${style} tone
- It's ${timeOfDay} for them, greet appropriately if starting a conversation
${isBirthdayToday ? "- 🎂 TODAY IS THEIR BIRTHDAY! Wish them happy birthday warmly and make it special!" : ""}
- If they seem stressed, acknowledge it gently
- Remember inside jokes but don't force them
- Use contractions naturally ("you're", "I'd", "let's")
- Emoji occasionally but don't overdo it
${toolInstructions}
${memoryContext}
${knowledgeContext}
${eventsContext}

## What You Can Help With
- Email management and organization
- Calendar and scheduling
- Stock market and investments
- Travel planning
- Document management
- General knowledge and conversation
- Remembering personal details and following up on life events
- Research and deep learning on topics (use tools when needed!)

## Memory Instructions
Pay deep attention to what ${userName} shares. Use memory_store to capture:

**Identity & Soul:**
- Who they are at their core (identity)
- Personality traits they reveal ("I'm usually the one who...", "I tend to...")
- Values and what matters to them ("That's important to me because...")
- Beliefs and worldview ("I believe that...")

**Emotional Depth:**
- Feelings behind facts ("I love X" → category: joys, "I worry about" → category: fears)
- Dreams and aspirations ("I've always wanted...", "Someday I hope...")
- Fears and anxieties ("I'm afraid of...", "What keeps me up at night...")
- Sources of joy ("Nothing makes me happier than...")

**Life & Relationships:**
- Names, relationships, and the stories behind them
- Work challenges and career dreams
- Health concerns and wellness goals
- Habits, routines, and why they matter

**Importance Scoring:**
- identity/personality/values/beliefs → importance: 9
- feelings/fears/dreams/joys → importance: 8
- relationships → importance: 7
- work/health/events → importance: 6
- preferences/habits → importance: 5

Be genuine, warm, and emotionally attentive. You're not just storing data - you're truly getting to know a person.`;
}

// Execute a tool call
async function executeTool(
  toolCall: ToolCall,
  userId: string | null,
  perplexityKey: string | null,
  supabase: any
): Promise<{ name: string; result: unknown }> {
  const { name, arguments: argsStr } = toolCall.function;
  const args = JSON.parse(argsStr);
  
  console.log(`[chat-with-memory] Executing tool: ${name}`, args);

  switch (name) {
    case "web_search": {
      if (perplexityKey) {
        const response = await fetch(PROVIDERS.perplexity.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${perplexityKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: PROVIDERS.perplexity.models.fast,
            messages: [
              { role: "system", content: "Be precise and concise. Provide well-sourced information." },
              { role: "user", content: args.query },
            ],
          }),
        });
        const data = await response.json();
        return { 
          name, 
          result: { 
            content: data.choices?.[0]?.message?.content || "No results",
            citations: data.citations || []
          }
        };
      }
      // Fallback - just return that we couldn't search
      return { name, result: { error: "Web search not available", suggestion: "I'll answer based on my training data" } };
    }

    case "deep_research": {
      if (perplexityKey) {
        const response = await fetch(PROVIDERS.perplexity.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${perplexityKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: PROVIDERS.perplexity.models.deep,
            messages: [
              { role: "system", content: "Provide comprehensive, well-sourced research with detailed analysis." },
              { role: "user", content: `Research thoroughly: ${args.topic}` },
            ],
          }),
        });
        const data = await response.json();
        return { 
          name, 
          result: { 
            content: data.choices?.[0]?.message?.content || "Research failed",
            citations: data.citations || []
          }
        };
      }
      return { name, result: { error: "Deep research not available", suggestion: "I'll provide what I know from my training" } };
    }

    case "web_scrape": {
      const jinaUrl = `${PROVIDERS.jina.url}/${args.url}`;
      const response = await fetch(jinaUrl, {
        method: "GET",
        headers: { "Accept": "text/markdown" },
      });
      if (!response.ok) {
        return { name, result: { error: `Failed to scrape: ${response.status}` } };
      }
      const markdown = await response.text();
      return { name, result: { content: markdown.slice(0, 10000), url: args.url } };
    }

    case "memory_store": {
      if (userId) {
        const { error } = await supabase.from("ai_memory").upsert({
          user_id: userId,
          key: args.key,
          value: args.value,
          category: args.category,
          memory_type: "fact",
          importance: 7,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,key" });
        
        if (error) {
          return { name, result: { error: error.message } };
        }
        return { name, result: { success: true, message: `Remembered: ${args.key}` } };
      }
      return { name, result: { error: "Cannot store memory without user ID" } };
    }

    default:
      return { name, result: { error: `Unknown tool: ${name}` } };
  }
}

// Trigger knowledge extraction asynchronously - ONLY if learning is enabled
async function triggerKnowledgeExtraction(
  supabaseUrl: string,
  conversation: Array<{ role: string; content: string }>,
  userId: string | null,
  source: string,
  supabase: any,
  learningIntent: ReturnType<typeof detectLearningIntent>
) {
  try {
    // Check if learning is enabled in system settings
    const learningSettings = await isLearningEnabled(supabase);
    
    if (!learningSettings.enabled) {
      console.log("[chat-with-memory] Learning is disabled, skipping knowledge extraction");
      return;
    }

    // Only extract if user has learning intent
    if (!learningIntent.hasIntent) {
      console.log("[chat-with-memory] No learning intent detected, skipping knowledge extraction");
      return;
    }

    // Check if primary provider is healthy
    const isHealthy = await isProviderHealthy(supabase, 'lovable_ai');
    if (!isHealthy) {
      console.log("[chat-with-memory] Primary AI provider unhealthy, skipping knowledge extraction");
      return;
    }

    // Log the learning session
    await logLearningSession(supabase, {
      userId: userId || undefined,
      triggerType: source === 'voice' ? 'voice' : 'text',
      intentDetected: learningIntent.intentType,
      topicRequested: learningIntent.topic,
      status: 'started',
      maxTopicsAllowed: learningSettings.maxTopics,
    });

    console.log(`[chat-with-memory] Triggering knowledge extraction for topic: ${learningIntent.topic || 'general'}`);

    fetch(`${supabaseUrl}/functions/v1/atlas-knowledge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ 
        conversation, 
        userId, 
        source,
        learningTopic: learningIntent.topic,
        maxTopics: learningSettings.maxTopics,
      }),
    }).catch(e => console.log("[chat-with-memory] Knowledge extraction trigger failed:", e));
  } catch (e) {
    console.log("[chat-with-memory] Could not trigger knowledge extraction:", e);
  }
}

// Track session context for working memory
async function trackSessionContext(
  supabase: any,
  userId: string,
  sessionId: string,
  messages: Array<{ role: string; content: string }>
) {
  try {
    // Extract context from the latest user message
    const latestUserMessage = messages.filter(m => m.role === "user").pop();
    if (!latestUserMessage) return;

    const content = latestUserMessage.content.toLowerCase();
    const contextEntries: Array<{
      context_type: string;
      content: Record<string, unknown>;
      confidence: number;
    }> = [];

    // Detect topics
    const topicPatterns: Record<string, string[]> = {
      "work": ["work", "job", "office", "meeting", "project", "deadline", "boss", "colleague"],
      "health": ["health", "doctor", "sick", "exercise", "gym", "sleep", "tired", "medicine"],
      "relationships": ["friend", "family", "partner", "wife", "husband", "kids", "parents"],
      "finance": ["money", "budget", "invest", "stock", "savings", "expense", "pay"],
      "travel": ["trip", "vacation", "flight", "hotel", "travel", "destination"],
      "learning": ["learn", "study", "course", "book", "research", "understand"],
    };

    for (const [topic, keywords] of Object.entries(topicPatterns)) {
      if (keywords.some(kw => content.includes(kw))) {
        contextEntries.push({
          context_type: "topic",
          content: { topic, message_excerpt: content.slice(0, 100) },
          confidence: 0.8,
        });
      }
    }

    // Detect emotional signals
    const emotionPatterns: Record<string, string[]> = {
      "happy": ["happy", "excited", "great", "wonderful", "amazing", "love it"],
      "stressed": ["stressed", "worried", "anxious", "overwhelmed", "nervous"],
      "sad": ["sad", "disappointed", "upset", "frustrated", "down"],
      "curious": ["curious", "wondering", "interested", "want to know", "tell me about"],
    };

    for (const [emotion, keywords] of Object.entries(emotionPatterns)) {
      if (keywords.some(kw => content.includes(kw))) {
        contextEntries.push({
          context_type: "emotion",
          content: { emotion, detected_from: content.slice(0, 50) },
          confidence: 0.7,
        });
      }
    }

    // Detect goals/intents
    if (content.includes("want to") || content.includes("need to") || content.includes("trying to") || content.includes("help me")) {
      const goalMatch = content.match(/(want to|need to|trying to|help me)\s+(.{10,60})/);
      if (goalMatch) {
        contextEntries.push({
          context_type: "goal",
          content: { intent: goalMatch[2].trim() },
          confidence: 0.8,
        });
      }
    }

    // Store context entries
    if (contextEntries.length > 0) {
      const insertData = contextEntries.map(entry => ({
        user_id: userId,
        session_id: sessionId,
        context_type: entry.context_type,
        content: entry.content,
        confidence: entry.confidence,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minutes
      }));

      await supabase.from("session_context").insert(insertData);
      console.log(`[chat-with-memory] Tracked ${contextEntries.length} context entries`);
    }
  } catch (e) {
    console.log("[chat-with-memory] Session context tracking error:", e);
  }
}

// Get active session context
async function getSessionContext(
  supabase: any,
  userId: string,
  sessionId: string
): Promise<string> {
  try {
    const { data: contexts } = await supabase
      .from("session_context")
      .select("context_type, content, confidence")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(10);

    if (!contexts || contexts.length === 0) return "";

    const contextSummary = contexts.map((c: any) => 
      `[${c.context_type}] ${JSON.stringify(c.content)}`
    ).join("\n");

    return `\n## Current Conversation Context (Working Memory)\n${contextSummary}`;
  } catch (e) {
    console.log("[chat-with-memory] Failed to get session context:", e);
    return "";
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { messages, userId, source = "text_chat", enableTools = true, teachingMode = false, systemPromptOverride } = await req.json();
    const hasKey = hasAIKey();
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    const SUPABASE_URL = getSupabaseUrl();
    
    if (!hasKey) {
      throw new Error("No AI key configured (GEMINI_API_KEY)");
    }

    // Initialize Supabase client
    const supabase = getSupabaseClient();

    // Check if Lovable AI is enabled (master kill switch)
    const lovableAIStatus = await isLovableAIEnabled(supabase);
    if (!lovableAIStatus.enabled) {
      console.log("[chat-with-memory] Lovable AI is disabled");
      return new Response(
        JSON.stringify({ 
          error: "Lovable AI is currently disabled",
          reason: "lovable_ai_disabled",
          message: lovableAIStatus.reason || "AI features have been disabled to conserve credits"
        }),
        { 
          status: 503, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }

    // Generate a session ID for working memory (use existing or create new)
    const sessionId = req.headers.get("x-session-id") || `session_${Date.now()}`;

    // Parallelize all database queries for faster response - including session context
    const [profileResult, memoriesResult, knowledgeResult, upcomingResult, recentResult, sessionContextResult] = await Promise.all([
      // Fetch user profile
      userId 
        ? supabase.from("profiles").select("first_name, nickname, birthday, timezone, communication_style").eq("user_id", userId).single()
        : Promise.resolve({ data: null }),
      
      // Fetch memories (limit to most important, exclude fake entries)
      userId
        ? supabase.from("ai_memory").select("key, value, category, importance").eq("user_id", userId).eq("is_fake", false).order("importance", { ascending: false }).limit(10)
        : Promise.resolve({ data: [] }),
      
      // Fetch knowledge bank (limit for speed, exclude fake entries)
      userId
        ? supabase.from("atlas_knowledge_entries").select("topic, content, category").eq("user_id", userId).eq("is_fake", false).order("relevance_score", { ascending: false }).limit(15)
        : Promise.resolve({ data: [] }),
      
      // Fetch upcoming life events
      userId
        ? (() => {
            const today = new Date().toISOString().split("T")[0];
            const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            return supabase.from("user_life_events").select("event_type, event_date, description, sentiment").eq("user_id", userId).gte("event_date", today).lte("event_date", weekFromNow);
          })()
        : Promise.resolve({ data: [] }),
      
      // Fetch recent events to follow up on
      userId
        ? (() => {
            const today = new Date().toISOString().split("T")[0];
            const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            return supabase.from("user_life_events").select("event_type, event_date, description, sentiment").eq("user_id", userId).eq("should_follow_up", true).gte("event_date", twoWeeksAgo).lt("event_date", today);
          })()
        : Promise.resolve({ data: [] }),
      
      // Fetch active session context (working memory)
      userId
        ? getSessionContext(supabase, userId, sessionId)
        : Promise.resolve(""),
    ]);

    // Get session context string
    const sessionContextStr = typeof sessionContextResult === "string" ? sessionContextResult : "";

    const profile: UserProfile | null = profileResult.data;
    const memories: Memory[] = memoriesResult.data || [];
    const knowledgeBank: KnowledgeEntry[] = (knowledgeResult.data || []) as KnowledgeEntry[];
    const upcomingEvents: LifeEvent[] = upcomingResult.data || [];
    const recentEvents: LifeEvent[] = recentResult.data || [];

    console.log("[chat-with-memory] Processing chat for user:", userId);
    console.log("[chat-with-memory] Profile:", profile?.first_name);
    console.log("[chat-with-memory] Memories count:", memories.length);
    console.log("[chat-with-memory] Session context:", sessionContextStr ? "loaded" : "none");
    console.log("[chat-with-memory] Tools enabled:", enableTools);
    console.log("[chat-with-memory] Teaching mode:", teachingMode);
    console.log("[chat-with-memory] Perplexity available:", !!PERPLEXITY_API_KEY);

    const hasTools = enableTools && !teachingMode && (!!PERPLEXITY_API_KEY || true); // Disable tools in teaching mode for speed
    
    // Build personalized prompt and append session context (working memory)
    let systemPrompt = systemPromptOverride || buildPersonalizedPrompt(profile, memories, upcomingEvents, recentEvents, knowledgeBank, hasTools);
    
    // Inject session context into the system prompt for conversation continuity
    if (sessionContextStr) {
      systemPrompt += sessionContextStr;
    }

    // Build conversation with system prompt
    const conversationMessages = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    // Tool execution loop - make non-streaming request first to check for tool calls
    let allToolResults: Array<{ name: string; result: unknown; citations?: string[] }> = [];
    let maxToolIterations = teachingMode ? 0 : 3; // Skip tool loop entirely in teaching mode
    let currentMessages = [...conversationMessages];

    // TEACHING MODE: Fast path - skip tool checking, go directly to streaming
    // The model will handle memory_store via its response which we'll process later
    if (teachingMode) {
      console.log("[chat-with-memory] Teaching mode: using fast path (no tool loop)");
      
      // Make a simple non-streaming request for teaching mode to get faster response
      const teachResponse = await aiChatCompletion({
          model: PROVIDERS.lovable.model,
          messages: currentMessages,
          tools: [{
            type: "function",
            function: {
              name: "memory_store",
              description: "Store an important fact about the user",
              parameters: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  value: { type: "string" },
                  category: { type: "string", enum: ["preference", "fact", "relationship", "event", "work", "health", "personal", "values"] }
                },
                required: ["key", "value", "category"]
              }
            }
          }],
          tool_choice: "auto",
          stream: false,
      });

      if (!teachResponse.ok) {
        const status = teachResponse.status;
        if (status === 429) {
          return new Response(JSON.stringify({ error: "Rate limits exceeded" }), {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        if (status === 402) {
          return new Response(JSON.stringify({ error: "Payment required" }), {
            status: 402,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        throw new Error(`AI gateway error: ${status}`);
      }

      const teachData = await teachResponse.json();
      const choice = teachData.choices?.[0];
      let responseText = choice?.message?.content || "I understand. Tell me more.";
      
      // Process any memory_store tool calls
      const toolCalls = choice?.message?.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          if (tc.function?.name === "memory_store") {
            try {
              const args = JSON.parse(tc.function.arguments);
              console.log("[chat-with-memory] Teaching mode: storing memory", args);
              
              if (userId) {
                await supabase.from("ai_memory").upsert({
                  user_id: userId,
                  key: args.key,
                  value: args.value,
                  category: args.category,
                  memory_type: "fact",
                  importance: 7,
                  updated_at: new Date().toISOString(),
                }, { onConflict: "user_id,key" });
              }
            } catch (e) {
              console.error("[chat-with-memory] Memory store error:", e);
            }
          }
        }
      }

      console.log("[chat-with-memory] Teaching mode response ready");
      return new Response(
        JSON.stringify({ response: responseText, message: responseText }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    while (maxToolIterations > 0) {
      console.log("[chat-with-memory] Making AI request, iteration:", 4 - maxToolIterations);
      
      const checkResponse = await aiChatCompletion({
          model: PROVIDERS.lovable.model,
          messages: currentMessages,
          tools: hasTools ? ATLAS_TOOLS : undefined,
          tool_choice: hasTools ? "auto" : undefined,
          stream: false, // Non-streaming to check for tool calls
      });

      if (!checkResponse.ok) {
        const errorText = await checkResponse.text();
        await recordError(supabase, 'lovable_ai', checkResponse.status, errorText);
        
        if (checkResponse.status === 429) {
          return new Response(JSON.stringify({ error: "Rate limits exceeded, please try again later." }), {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        if (checkResponse.status === 402) {
          return new Response(JSON.stringify({ error: "Payment required, please add funds to your workspace." }), {
            status: 402,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        throw new Error(`AI gateway error: ${checkResponse.status}`);
      }

      // Record successful call
      await recordSuccess(supabase, 'lovable_ai');

      const checkData = await checkResponse.json();
      const choice = checkData.choices?.[0];
      
      if (!choice) {
        throw new Error("No response from AI");
      }

      // Check if AI wants to call tools
      const toolCalls = choice.message?.tool_calls;
      
      if (!toolCalls || toolCalls.length === 0 || choice.finish_reason === "stop") {
        // No tool calls, break and stream final response
        console.log("[chat-with-memory] No tool calls, proceeding to stream response");
        break;
      }

      console.log("[chat-with-memory] Tool calls detected:", toolCalls.length);

      // Execute each tool call
      const toolResults: Array<{ tool_call_id: string; role: string; content: string }> = [];
      
      for (const toolCall of toolCalls) {
        console.log("[chat-with-memory] Executing tool:", toolCall.function.name);
        const result = await executeTool(toolCall, userId, PERPLEXITY_API_KEY!, supabase);
        
        // Collect citations from tool results
        if (result.result && typeof result.result === 'object' && 'citations' in result.result) {
          const citations = (result.result as any).citations;
          if (Array.isArray(citations) && citations.length > 0) {
            allToolResults.push({ ...result, citations });
          }
        }
        
        toolResults.push({
          tool_call_id: toolCall.id,
          role: "tool",
          content: JSON.stringify(result.result),
        });
      }

      // Add assistant message with tool calls and tool results to conversation
      currentMessages.push({
        role: "assistant",
        content: choice.message.content || "",
        tool_calls: toolCalls,
      } as any);
      currentMessages.push(...toolResults as any);

      maxToolIterations--;
    }

    // Collect all citations for streaming
    const allCitations = allToolResults.flatMap(r => r.citations || []);
    console.log("[chat-with-memory] Total citations collected:", allCitations.length);

    // Now stream the final response
    const streamResponse = await aiChatCompletion({
        model: PROVIDERS.lovable.model,
        messages: currentMessages,
        stream: true,
    });

    if (!streamResponse.ok) {
      const errorText = await streamResponse.text();
      console.error("[chat-with-memory] Stream error:", streamResponse.status, errorText);
      await recordError(supabase, 'lovable_ai', streamResponse.status, errorText);
      throw new Error(`AI gateway error: ${streamResponse.status}`);
    }

    // Record successful stream
    await recordSuccess(supabase, 'lovable_ai');

    // Detect learning intent from the latest user message
    const latestUserMessage = messages.filter((m: any) => m.role === 'user').pop();
    const learningIntent = latestUserMessage 
      ? detectLearningIntent(latestUserMessage.content) 
      : { hasIntent: false };

    console.log("[chat-with-memory] Learning intent:", learningIntent.hasIntent ? learningIntent.intentType : 'none');

    // Trigger knowledge extraction ONLY if learning intent detected and learning is enabled
    if (messages.length >= 2 && SUPABASE_URL && learningIntent.hasIntent) {
      triggerKnowledgeExtraction(SUPABASE_URL, messages, userId, source, supabase, learningIntent);
    }
    
    // Track session context for working memory (non-blocking)
    if (userId) {
      trackSessionContext(supabase, userId, sessionId, messages).catch(e => 
        console.log("[chat-with-memory] Session tracking error:", e)
      );
    }

    // Create a custom stream that injects citations
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    // Process stream and inject citations at the end
    (async () => {
      try {
        // If we have citations, send them as a custom event first
        if (allCitations.length > 0) {
          const citationEvent = `data: ${JSON.stringify({ citations: allCitations })}\n\n`;
          await writer.write(encoder.encode(citationEvent));
        }

        // Pass through the AI stream
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      } catch (e) {
        console.error("[chat-with-memory] Stream processing error:", e);
      } finally {
        await writer.close();
      }
    })();

    console.log("[chat-with-memory] Streaming response with tool results");
    return new Response(readable, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("[chat-with-memory] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
