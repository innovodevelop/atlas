import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseClient, getSupabaseUrl } from "../_shared/supabase.ts";
import { 
  isLearningEnabled, 
  isProviderHealthy,
  recordSuccess, 
  recordError,
  updateLearningSession
} from "../_shared/providerStatus.ts";
import { isLovableAIEnabled } from "../_shared/providerStatus.ts";
import { aiChatCompletion, hasAIKey } from "../_shared/aiGateway.ts";

// Declare EdgeRuntime for background tasks
declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
};

interface ResearchFinding {
  title: string;
  summary: string;
  details: string;
  confidence: number;
  source_url?: string;
}

interface SubTopic {
  topic: string;
  description: string;
  priority: number;
}

interface PerplexityResponse {
  choices: Array<{
    message: {
      content: string;
      tool_calls?: Array<{
        function: {
          arguments: string;
        };
      }>;
    };
  }>;
  citations?: string[];
}

interface RootTopicContext {
  root_topic: string;
  root_description?: string;
  jurisdiction?: string;
  domain?: string;
  parent_chain: string[];
  focus_keywords: string[];
}

// Provider configuration
const PROVIDERS = {
  perplexity: {
    url: "https://api.perplexity.ai/chat/completions",
    model: "sonar-pro",
  },
  lovable: {
    url: "https://ai.gateway.lovable.dev/v1/chat/completions",
    model: "google/gemini-2.5-flash",
  },
};

// Extract context from root topic
function extractTopicContext(topic: string, description: string | null): RootTopicContext {
  const lowerTopic = topic.toLowerCase();
  const lowerDesc = (description || '').toLowerCase();
  const combined = `${lowerTopic} ${lowerDesc}`;
  
  // Detect jurisdiction/country
  const countryPatterns: Record<string, string[]> = {
    'danish': ['danish', 'denmark', 'dk'],
    'german': ['german', 'germany', 'deutschland'],
    'french': ['french', 'france'],
    'british': ['british', 'uk', 'united kingdom', 'england'],
    'american': ['american', 'usa', 'united states', 'u.s.'],
    'european': ['european', 'eu', 'europe'],
  };

  let jurisdiction: string | undefined;
  for (const [key, patterns] of Object.entries(countryPatterns)) {
    if (patterns.some(p => combined.includes(p))) {
      jurisdiction = key;
      break;
    }
  }

  // Detect domain
  const domainPatterns: Record<string, string[]> = {
    'law': ['law', 'legal', 'criminal', 'civil', 'constitutional', 'court', 'legislation'],
    'history': ['history', 'historical', 'century', 'era', 'ancient', 'medieval', 'modern'],
    'science': ['science', 'scientific', 'research', 'study', 'experiment'],
    'technology': ['technology', 'tech', 'software', 'hardware', 'digital', 'computing'],
    'medicine': ['medicine', 'medical', 'health', 'disease', 'treatment', 'clinical'],
    'economics': ['economics', 'economic', 'finance', 'market', 'trade', 'business'],
  };

  let domain: string | undefined;
  for (const [key, patterns] of Object.entries(domainPatterns)) {
    if (patterns.some(p => combined.includes(p))) {
      domain = key;
      break;
    }
  }

  // Extract focus keywords (significant words)
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'about']);
  const words = topic.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));

  return {
    root_topic: topic,
    root_description: description || undefined,
    jurisdiction,
    domain,
    parent_chain: [topic],
    focus_keywords: words.slice(0, 5),
  };
}

// Build context-aware research prompt
function buildResearchPrompt(
  topic: string,
  description: string | null,
  depth: number,
  context: RootTopicContext | null
): string {
  let contextSection = '';
  
  if (context) {
    contextSection = `
CRITICAL CONTEXT - YOU MUST STAY FOCUSED:
- Root Topic: "${context.root_topic}"
${context.jurisdiction ? `- Jurisdiction/Country: ${context.jurisdiction.toUpperCase()} - ALL findings MUST relate to this jurisdiction` : ''}
${context.domain ? `- Domain: ${context.domain}` : ''}
- Topic Chain: ${context.parent_chain.join(' → ')}
- Focus Keywords: ${context.focus_keywords.join(', ')}

IMPORTANT INSTRUCTIONS:
1. ALL findings must be directly relevant to the ROOT topic context
2. ${context.jurisdiction ? `Do NOT include information about other countries/jurisdictions unless explicitly comparing to ${context.jurisdiction}` : 'Stay focused on the geographic/domain context implied by the root topic'}
3. Sub-topics should drill deeper INTO the root topic, not branch away from it
4. If you cannot find specific information for the requested context, say so rather than providing generic or off-topic information
`;
  }

  return `Research this topic comprehensively: "${topic}"${description ? `\n\nContext: ${description}` : ''}
${contextSection}
Current research depth: ${depth} (0 = root topic, higher = more specific)

Provide your findings in this exact JSON format:
{
  "findings": [
    {
      "title": "Finding title",
      "summary": "One-sentence summary",
      "details": "Detailed explanation with specific facts",
      "confidence": 0.85,
      "relevance_to_root": 0.9
    }
  ],
  "subTopics": [
    {
      "topic": "Sub-topic to research - MUST include original context keywords",
      "description": "Why this is worth exploring",
      "priority": 8
    }
  ]
}

${depth >= 3 ? 'Do NOT include subTopics at this depth.' : 'Only include subTopics that stay within the original context.'}
Be precise, factual, and STAY ON TOPIC.`;
}

// Validate findings against root context
function validateFindingsRelevance(
  findings: ResearchFinding[],
  context: RootTopicContext | null
): ResearchFinding[] {
  if (!context) return findings;

  return findings.map(finding => {
    const combinedText = `${finding.title} ${finding.summary} ${finding.details}`.toLowerCase();
    
    // Check jurisdiction relevance
    let jurisdictionScore = 1.0;
    if (context.jurisdiction) {
      const hasCorrectJurisdiction = combinedText.includes(context.jurisdiction) || 
        combinedText.includes(context.root_topic.toLowerCase());
      
      // Check for wrong jurisdictions
      const wrongJurisdictions = ['american', 'usa', 'united states', 'u.s.'].filter(
        j => j !== context.jurisdiction && combinedText.includes(j)
      );
      
      if (wrongJurisdictions.length > 0 && !hasCorrectJurisdiction) {
        jurisdictionScore = 0.3; // Heavily penalize wrong jurisdiction
        console.log(`[atlas-research] Flagged potentially off-topic finding: "${finding.title}" - wrong jurisdiction detected`);
      } else if (!hasCorrectJurisdiction) {
        jurisdictionScore = 0.6;
      }
    }

    // Check keyword relevance
    const keywordHits = context.focus_keywords.filter(kw => 
      combinedText.includes(kw.toLowerCase())
    ).length;
    const keywordScore = Math.min(1.0, 0.5 + (keywordHits / context.focus_keywords.length) * 0.5);

    // Combined relevance score
    const relevanceScore = (jurisdictionScore * 0.6) + (keywordScore * 0.4);

    return {
      ...finding,
      confidence: Math.min(finding.confidence, relevanceScore),
    };
  });
}

// Perform research using Perplexity or fallback to Lovable AI
async function researchTopic(
  topic: string,
  description: string | null,
  depth: number,
  perplexityKey: string | null,
  context: RootTopicContext | null
): Promise<{ findings: ResearchFinding[]; subTopics: SubTopic[]; citations: string[] }> {
  
  const researchPrompt = buildResearchPrompt(topic, description, depth, context);

  // Try Perplexity first for grounded research with real citations
  if (perplexityKey) {
    console.log(`[atlas-research] Using Perplexity sonar-pro for: ${topic} (context: ${context?.root_topic || 'none'})`);
    
    try {
      const response = await fetch(PROVIDERS.perplexity.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${perplexityKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: PROVIDERS.perplexity.model,
          messages: [
            {
              role: "system",
              content: `You are Atlas, an expert research AI specializing in deep, focused research.

CRITICAL RULES:
1. Stay STRICTLY within the topic context provided
2. If a jurisdiction/country is specified, ALL findings must relate to that jurisdiction
3. Do NOT default to US/American information unless specifically requested
4. Be precise and cite specific facts and figures when available
5. Generate 3-5 key findings with detailed insights
6. Identify 2-4 sub-topics that go DEEPER into the same context (only if depth < 3)

Current research depth: ${depth} (0 = root topic, higher = more specific)`
            },
            {
              role: "user",
              content: researchPrompt
            }
          ],
        }),
      });

      // Record the API call result

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[atlas-research] Perplexity API error:", errorText);
        throw new Error(`Perplexity API failed: ${response.status}`);
      }

      const data: PerplexityResponse = await response.json();
      const content = data.choices?.[0]?.message?.content || "";
      const citations = data.citations || [];

      console.log(`[atlas-research] Perplexity response received, citations: ${citations.length}`);

      // Parse the JSON response
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          
          // Add citations to findings
          let findings = (parsed.findings || []).map((f: ResearchFinding, idx: number) => ({
            ...f,
            source_url: citations[idx] || citations[0] || null
          }));

          // Validate findings against root context
          findings = validateFindingsRelevance(findings, context);

          // Filter sub-topics to maintain context
          let subTopics = depth < 3 ? (parsed.subTopics || []) : [];
          if (context && subTopics.length > 0) {
            subTopics = subTopics.filter((st: SubTopic) => {
              const stLower = st.topic.toLowerCase();
              // Ensure sub-topics maintain context
              const hasContext = context.focus_keywords.some(kw => 
                stLower.includes(kw.toLowerCase())
              ) || stLower.includes(context.root_topic.toLowerCase().split(' ')[0]);
              
              if (!hasContext) {
                console.log(`[atlas-research] Filtered off-context sub-topic: "${st.topic}"`);
              }
              return hasContext;
            });
          }

          return { findings, subTopics, citations };
        }
      } catch (parseError) {
        console.error("[atlas-research] Failed to parse Perplexity response:", parseError);
      }

      // If parsing failed, create a single finding from the content
      return {
        findings: [{
          title: topic,
          summary: content.slice(0, 200),
          details: content,
          confidence: 0.8,
          source_url: citations[0] || undefined
        }],
        subTopics: [],
        citations
      };
    } catch (perplexityError) {
      console.error("[atlas-research] Perplexity failed, falling back to Lovable AI:", perplexityError);
    }
  }

  // Fallback to the default AI gateway with tool calling
  console.log(`[atlas-research] Using AI gateway for: ${topic}`);

  const response = await aiChatCompletion({
      model: PROVIDERS.lovable.model,
      messages: [
        {
          role: "system",
          content: `You are Atlas, an autonomous research AI. Stay STRICTLY within the topic context provided.

CRITICAL RULES:
1. If a jurisdiction/country is specified, ALL findings must relate to that jurisdiction
2. Do NOT default to US/American information
3. Generate 3-5 key findings with detailed insights
4. Identify 2-4 sub-topics that go DEEPER (not sideways) into the topic
5. Current research depth: ${depth} (0 = root, higher = more specific)`
        },
        {
          role: "user",
          content: researchPrompt
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "submit_research",
            description: "Submit research findings and suggested sub-topics",
            parameters: {
              type: "object",
              properties: {
                findings: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string", description: "Finding title" },
                      summary: { type: "string", description: "Brief summary (1-2 sentences)" },
                      details: { type: "string", description: "Detailed explanation" },
                      confidence: { type: "number", minimum: 0, maximum: 1 }
                    },
                    required: ["title", "summary", "details", "confidence"]
                  }
                },
                subTopics: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      topic: { type: "string" },
                      description: { type: "string" },
                      priority: { type: "number", minimum: 1, maximum: 10 }
                    },
                    required: ["topic", "description", "priority"]
                  }
                }
              },
              required: ["findings", "subTopics"]
            }
          }
        }
      ],
      tool_choice: { type: "function", function: { name: "submit_research" } }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[atlas-research] Lovable AI failed:", errorText);
    throw new Error(`Research failed: ${errorText}`);
  }

  const result = await response.json();
  
  try {
    const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      const parsed = JSON.parse(toolCall.function.arguments);
      let findings = validateFindingsRelevance(parsed.findings || [], context);
      return {
        findings,
        subTopics: depth < 3 ? (parsed.subTopics || []) : [],
        citations: []
      };
    }
  } catch (e) {
    console.error("[atlas-research] Failed to parse Lovable AI response:", e);
  }

  return { findings: [], subTopics: [], citations: [] };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { 
      topicId, 
      action, 
      topic, 
      description, 
      userId, 
      autoDeepen = true, 
      maxDepth = 3,
      learningSessionId = null
    } = await req.json();
    
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    const SUPABASE_URL = getSupabaseUrl();
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!hasAIKey()) {
      throw new Error("No AI key configured (GEMINI_API_KEY)");
    }

    const supabase = getSupabaseClient();

    // Check if Lovable AI is enabled (master kill switch)
    const lovableAIStatus = await isLovableAIEnabled(supabase);
    if (!lovableAIStatus.enabled) {
      console.log("[atlas-research] Lovable AI is disabled, aborting research");
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "Lovable AI is disabled",
          reason: "lovable_ai_disabled"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if learning is enabled before proceeding
    const learningSettings = await isLearningEnabled(supabase);
    if (!learningSettings.enabled) {
      console.log("[atlas-research] Learning is disabled, aborting research");
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "Learning is disabled",
          reason: "learning_disabled"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if primary provider is healthy
    const isHealthy = await isProviderHealthy(supabase, 'lovable_ai');
    const isPerplexityHealthy = PERPLEXITY_API_KEY ? await isProviderHealthy(supabase, 'perplexity') : false;
    
    if (!isHealthy && !isPerplexityHealthy) {
      console.log("[atlas-research] All AI providers are unhealthy, aborting research");
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: "AI providers are unavailable",
          reason: "providers_unhealthy"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use settings-based max depth instead of hardcoded
    const effectiveMaxDepth = Math.min(maxDepth, learningSettings.maxDepth);
    console.log(`[atlas-research] Using max depth: ${effectiveMaxDepth} (settings: ${learningSettings.maxDepth}, requested: ${maxDepth})`);

    // Log provider being used
    console.log(`[atlas-research] Provider: ${PERPLEXITY_API_KEY && isPerplexityHealthy ? 'Perplexity sonar-pro' : 'Lovable AI (fallback)'}`);

    // Handle different actions
    if (action === "start" || action === "resume") {
      // Get the topic from database
      const { data: topicData, error: fetchError } = await supabase
        .from("atlas_research_topics")
        .select("*")
        .eq("id", topicId)
        .single();

      if (fetchError || !topicData) {
        throw new Error("Topic not found");
      }

      // Get or create root topic context
      let context: RootTopicContext | null = topicData.root_topic_context as RootTopicContext | null;
      
      if (!context && topicData.depth_level === 0) {
        // This is the root topic - extract context
        context = extractTopicContext(topicData.topic, topicData.description);
        console.log(`[atlas-research] Extracted root context:`, JSON.stringify(context));
      } else if (!context && topicData.parent_id) {
        // Get context from parent
        const { data: parentData } = await supabase
          .from("atlas_research_topics")
          .select("topic, root_topic_context")
          .eq("id", topicData.parent_id)
          .single();
        
        if (parentData?.root_topic_context) {
          context = parentData.root_topic_context as RootTopicContext;
          // Add current topic to parent chain
          context.parent_chain = [...context.parent_chain, topicData.topic];
        }
      }

      console.log(`[atlas-research] Starting research on: ${topicData.topic} (depth: ${topicData.depth_level}, context: ${context?.root_topic || 'none'})`);

      // Update status to researching and save context
      await supabase
        .from("atlas_research_topics")
        .update({ 
          status: "researching", 
          updated_at: new Date().toISOString(),
          root_topic_context: context
        })
        .eq("id", topicId);

      // Perform research with context
      const { findings, subTopics, citations } = await researchTopic(
        topicData.topic,
        topicData.description,
        topicData.depth_level,
        PERPLEXITY_API_KEY || null,
        context
      );

      // Count validated vs flagged findings
      const validatedFindings = findings.filter(f => f.confidence >= 0.6);
      const flaggedFindings = findings.filter(f => f.confidence < 0.6);

      console.log(`[atlas-research] Research complete: ${findings.length} findings (${validatedFindings.length} validated, ${flaggedFindings.length} flagged), ${subTopics.length} sub-topics, ${citations.length} citations`);

      // Update topic with findings and sources
      const { error: updateError } = await supabase
        .from("atlas_research_topics")
        .update({
          status: "completed",
          findings: findings,
          sources: citations.map(url => ({ url, accessed_at: new Date().toISOString() })),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("id", topicId);

      if (updateError) {
        console.error("[atlas-research] Failed to update topic:", updateError);
      }

      // Store findings as knowledge entries with validation status
      if (findings.length > 0) {
        const knowledgeEntries = findings.map(f => ({
          user_id: topicData.user_id || null,
          topic: f.title,
          content: { 
            summary: f.summary, 
            details: f.details,
            source_url: f.source_url 
          },
          category: "research_finding",
          source: f.source_url || `research:${topicData.topic}`,
          confidence: f.confidence,
          relevance_score: f.confidence,
          research_topic_id: topicId,
          relevance_to_root: f.confidence,
          validation_status: f.confidence >= 0.6 ? 'validated' : 'flagged',
          root_topic_context: context
        }));

        const { data: insertedKnowledge, error: knowledgeError } = await supabase
          .from("atlas_knowledge_entries")
          .insert(knowledgeEntries)
          .select();
        
        if (knowledgeError) {
          console.error(`[atlas-research] Failed to insert knowledge entries:`, knowledgeError);
          console.error(`[atlas-research] Sample entry:`, JSON.stringify(knowledgeEntries[0], null, 2));
        } else {
          console.log(`[atlas-research] Stored ${insertedKnowledge?.length || 0} knowledge entries`);
        }
      }

      // Update learning session discoveries if linked
      if (topicData.learning_session_id || learningSessionId) {
        const sessionId = topicData.learning_session_id || learningSessionId;
        
        // Get current discoveries
        const { data: sessionData } = await supabase
          .from("atlas_learning_sessions")
          .select("discoveries")
          .eq("id", sessionId)
          .single();
        
        const currentDiscoveries = (sessionData?.discoveries as unknown[]) || [];
        const newDiscoveries = findings.map(f => ({
          type: 'research_finding',
          topic: f.title,
          summary: f.summary,
          confidence: f.confidence,
          timestamp: new Date().toISOString(),
          research_topic_id: topicId
        }));
        
        await supabase
          .from("atlas_learning_sessions")
          .update({ 
            discoveries: [...currentDiscoveries, ...newDiscoveries]
          })
          .eq("id", sessionId);
        
        console.log(`[atlas-research] Updated learning session ${sessionId} with ${newDiscoveries.length} discoveries`);
      }

      // Store citations as research citations
      if (citations.length > 0) {
        const citationEntries = citations.map(url => ({
          user_id: topicData.user_id || null,
          research_topic_id: topicId,
          url,
          domain: new URL(url).hostname,
          citation_type: "web",
          credibility_score: 0.7,
          accessed_at: new Date().toISOString()
        }));

        const { error: citationError } = await supabase.from("research_citations").insert(citationEntries);
        if (!citationError) {
          console.log(`[atlas-research] Stored ${citationEntries.length} citations`);
        }
      }

      // Create sub-topics if auto-deepen is enabled and within depth limit
      if (autoDeepen && topicData.depth_level < maxDepth && subTopics.length > 0) {
        const subTopicEntries = subTopics.map(st => ({
          parent_id: topicId,
          user_id: topicData.user_id || null,
          topic: st.topic,
          description: st.description,
          status: "queued",
          depth_level: topicData.depth_level + 1,
          priority: st.priority,
          auto_generated: true,
          findings: [],
          sources: [],
          root_topic_context: context ? {
            ...context,
            parent_chain: [...context.parent_chain, st.topic]
          } : null,
          learning_session_id: topicData.learning_session_id || learningSessionId
        }));

        const { data: createdSubTopics, error: subError } = await supabase
          .from("atlas_research_topics")
          .insert(subTopicEntries)
          .select();

        if (subError) {
          console.error("[atlas-research] Failed to create sub-topics:", subError);
        } else if (createdSubTopics) {
          console.log(`[atlas-research] Created ${createdSubTopics.length} sub-topics`);

          // Queue up research for sub-topics (process top priority first)
          for (const subTopic of createdSubTopics.slice(0, 2)) {
            EdgeRuntime.waitUntil(
              fetch(`${SUPABASE_URL}/functions/v1/atlas-research`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
                },
                body: JSON.stringify({
                  topicId: subTopic.id,
                  action: "start",
                  autoDeepen: true,
                  maxDepth,
                  learningSessionId: topicData.learning_session_id || learningSessionId
                })
              }).catch(e => console.error("[atlas-research] Sub-topic research failed:", e))
            );
          }
        }
      }

      return new Response(
        JSON.stringify({ 
          success: true, 
          findings: findings.length,
          validated: validatedFindings.length,
          flagged: flaggedFindings.length,
          subTopics: subTopics.length,
          citations: citations.length,
          provider: PERPLEXITY_API_KEY ? "perplexity" : "lovable",
          context: context?.root_topic || null
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create new research topic
    if (action === "create" || (!action && topic)) {
      // Extract context for new root topic
      const context = extractTopicContext(topic, description || null);

      const { data: newTopic, error: createError } = await supabase
        .from("atlas_research_topics")
        .insert({
          user_id: userId || null,
          topic: topic,
          description: description || null,
          status: "queued",
          depth_level: 0,
          priority: 5,
          auto_generated: false,
          findings: [],
          sources: [],
          root_topic_context: context,
          learning_session_id: learningSessionId
        })
        .select()
        .single();

      if (createError) {
        throw new Error(`Failed to create topic: ${createError.message}`);
      }

      console.log(`[atlas-research] Created research topic: ${newTopic.id} with context: ${context.root_topic}`);

      // Start researching immediately
      EdgeRuntime.waitUntil(
        fetch(`${SUPABASE_URL}/functions/v1/atlas-research`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
          },
          body: JSON.stringify({
            topicId: newTopic.id,
            action: "start",
            autoDeepen,
            maxDepth,
            learningSessionId
          })
        }).catch(e => console.error("[atlas-research] Research start failed:", e))
      );

      return new Response(
        JSON.stringify({ success: true, topicId: newTopic.id, context: context.root_topic }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    throw new Error("Invalid action or missing parameters");
  } catch (error) {
    console.error("[atlas-research] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
