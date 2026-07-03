import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseClient, getSupabaseUrl } from "../_shared/supabase.ts";
import { 
  isLearningEnabled, 
  detectLearningIntent, 
  logLearningSession,
  isProviderHealthy,
  isSystemHealthy 
} from "../_shared/providerStatus.ts";

// Atlas Control Edge Function
// Manages learning state, provider status, and system settings

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const supabase = getSupabaseClient();

    switch (action) {
      case 'get_status': {
        // Get comprehensive system status
        const [settingsResult, providersResult, learningResult] = await Promise.all([
          supabase.from('atlas_system_settings').select('*').limit(1).single(),
          supabase.from('atlas_provider_status').select('*'),
          supabase.from('atlas_learning_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(10),
        ]);

        const systemHealthy = await isSystemHealthy(supabase);

        return jsonResponse({
          success: true,
          settings: settingsResult.data,
          providers: providersResult.data || [],
          recentLearning: learningResult.data || [],
          systemHealthy,
        });
      }

      case 'enable_learning': {
        const body = await req.json().catch(() => ({}));
        const mode = body.mode || 'on_demand';

        const { error } = await supabase
          .from('atlas_system_settings')
          .update({ 
            learning_enabled: true,
            learning_mode: mode,
            updated_at: new Date().toISOString()
          })
          .neq('id', '00000000-0000-0000-0000-000000000000');

        if (error) throw error;

        console.log(`[atlas-control] Learning enabled in ${mode} mode`);
        return jsonResponse({ success: true, learning_enabled: true, mode });
      }

      case 'disable_learning': {
        const { error } = await supabase
          .from('atlas_system_settings')
          .update({ 
            learning_enabled: false,
            updated_at: new Date().toISOString()
          })
          .neq('id', '00000000-0000-0000-0000-000000000000');

        if (error) throw error;

        console.log('[atlas-control] Learning disabled');
        return jsonResponse({ success: true, learning_enabled: false });
      }

      case 'update_settings': {
        const body = await req.json();
        const {
          max_topics_per_session,
          max_research_depth,
          auto_validation,
          auto_knowledge_extraction,
        } = body;

        const updateData: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        };

        if (max_topics_per_session !== undefined) updateData.max_topics_per_session = max_topics_per_session;
        if (max_research_depth !== undefined) updateData.max_research_depth = max_research_depth;
        if (auto_validation !== undefined) updateData.auto_validation = auto_validation;
        if (auto_knowledge_extraction !== undefined) updateData.auto_knowledge_extraction = auto_knowledge_extraction;

        const { error } = await supabase
          .from('atlas_system_settings')
          .update(updateData)
          .neq('id', '00000000-0000-0000-0000-000000000000');

        if (error) throw error;

        return jsonResponse({ success: true, updated: updateData });
      }

      case 'check_learning_intent': {
        const body = await req.json();
        const { message, userId, sessionId } = body;

        if (!message) {
          return errorResponse('Message is required', 400);
        }

        // Check if learning is enabled
        const learningConfig = await isLearningEnabled(supabase);
        if (!learningConfig.enabled) {
          return jsonResponse({
            success: true,
            shouldLearn: false,
            reason: 'learning_disabled',
          });
        }

        // Check system health
        const systemHealthy = await isSystemHealthy(supabase);
        if (!systemHealthy) {
          return jsonResponse({
            success: true,
            shouldLearn: false,
            reason: 'system_unhealthy',
          });
        }

        // Detect learning intent
        const intent = detectLearningIntent(message);
        
        return jsonResponse({
          success: true,
          shouldLearn: intent.hasIntent,
          intent: intent.hasIntent ? {
            topic: intent.topic,
            type: intent.intentType,
          } : null,
          config: {
            maxTopics: learningConfig.maxTopics,
            maxDepth: learningConfig.maxDepth,
          },
        });
      }

      case 'start_learning': {
        const body = await req.json();
        const { topic, userId, sessionId, triggerType = 'manual' } = body;

        // Check if learning is enabled
        const learningConfig = await isLearningEnabled(supabase);
        if (!learningConfig.enabled) {
          return errorResponse('Learning is disabled', 400);
        }

        // Check system health
        const systemHealthy = await isSystemHealthy(supabase);
        if (!systemHealthy) {
          return errorResponse('System is unhealthy, learning is paused', 503);
        }

        // Log the learning session
        const logId = await logLearningSession(supabase, {
          userId,
          sessionId,
          triggerType,
          topicRequested: topic,
          status: 'started',
          maxTopicsAllowed: learningConfig.maxTopics,
        });

        // Trigger research if topic provided. Route through atlas-research's
        // "create" action, which owns session creation, semantic dedup and
        // the containment limits — never insert research topics directly.
        if (topic) {
          const supabaseUrl = getSupabaseUrl();
          fetch(`${supabaseUrl}/functions/v1/atlas-research`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'create',
              topic,
              description: `User-requested learning: ${topic}`,
              userId,
              autoDeepen: true,
            }),
          }).catch(e => console.error('[atlas-control] Failed to trigger research:', e));
        }

        return jsonResponse({
          success: true,
          learningSessionId: logId,
          config: {
            maxTopics: learningConfig.maxTopics,
            maxDepth: learningConfig.maxDepth,
          },
        });
      }

      case 'get_provider_status': {
        const body = await req.json().catch(() => ({}));
        const { provider } = body;

        if (provider) {
          const healthy = await isProviderHealthy(supabase, provider);
          const { data } = await supabase
            .from('atlas_provider_status')
            .select('*')
            .eq('provider', provider)
            .single();

          return jsonResponse({
            success: true,
            provider: data,
            healthy,
          });
        }

        const { data } = await supabase
          .from('atlas_provider_status')
          .select('*');

        return jsonResponse({
          success: true,
          providers: data || [],
        });
      }

      case 'reset_provider': {
        const body = await req.json();
        const { provider } = body;

        if (!provider) {
          return errorResponse('Provider is required', 400);
        }

        const { error } = await supabase
          .from('atlas_provider_status')
          .update({
            status: 'unknown',
            error_count: 0,
            last_error: null,
            rate_limit_until: null,
            updated_at: new Date().toISOString(),
          })
          .eq('provider', provider);

        if (error) throw error;

        return jsonResponse({ success: true, provider, reset: true });
      }

      default:
        return errorResponse(`Unknown action: ${action}`, 400);
    }
  } catch (error) {
    console.error('[atlas-control] Error:', error);
    return errorResponse(error instanceof Error ? error.message : 'Unknown error');
  }
});
