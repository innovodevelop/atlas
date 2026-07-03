// Provider Status Management Utilities
// Shared utilities for tracking AI provider health across edge functions

// Use any for supabase client to avoid version mismatch issues
// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

export type ProviderName = 'lovable_ai' | 'perplexity' | 'anthropic' | 'jina' | 'openai';
export type ProviderStatus = 'healthy' | 'degraded' | 'error' | 'rate_limited' | 'credits_exhausted' | 'unknown';

export interface ProviderStatusUpdate {
  status?: ProviderStatus;
  last_success?: string;
  last_error?: string;
  error_count?: number;
  rate_limit_until?: string;
  response_time_ms?: number;
}

// Update provider status after an API call
export async function updateProviderStatus(
  supabase: SupabaseClient,
  provider: ProviderName,
  update: ProviderStatusUpdate
): Promise<void> {
  try {
    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (update.status) updateData.status = update.status;
    if (update.last_success) updateData.last_success = update.last_success;
    if (update.last_error) updateData.last_error = update.last_error;
    if (update.rate_limit_until) updateData.rate_limit_until = update.rate_limit_until;

    // Handle error count increment or reset
    if (update.error_count !== undefined) {
      if (update.error_count === 0) {
        updateData.error_count = 0;
      } else {
        // Use SQL to increment
        const { data: current } = await supabase
          .from('atlas_provider_status')
          .select('error_count, total_calls, successful_calls, failed_calls')
          .eq('provider', provider)
          .single();
        
        if (current) {
          updateData.error_count = (current.error_count || 0) + 1;
          updateData.failed_calls = (current.failed_calls || 0) + 1;
          updateData.total_calls = (current.total_calls || 0) + 1;
        }
      }
    }

    // Track successful call
    if (update.status === 'healthy' && update.last_success) {
      const { data: current } = await supabase
        .from('atlas_provider_status')
        .select('total_calls, successful_calls, avg_response_time_ms')
        .eq('provider', provider)
        .single();
      
      if (current) {
        updateData.total_calls = (current.total_calls || 0) + 1;
        updateData.successful_calls = (current.successful_calls || 0) + 1;
        updateData.error_count = 0;
        
        // Update average response time
        if (update.response_time_ms) {
          const currentAvg = current.avg_response_time_ms || update.response_time_ms;
          updateData.avg_response_time_ms = Math.round((currentAvg + update.response_time_ms) / 2);
        }
      }
    }

    await supabase
      .from('atlas_provider_status')
      .update(updateData)
      .eq('provider', provider);

  } catch (e) {
    console.error(`[providerStatus] Failed to update status for ${provider}:`, e);
  }
}

// Record a successful API call
export async function recordSuccess(
  supabase: SupabaseClient,
  provider: ProviderName,
  responseTimeMs?: number
): Promise<void> {
  await updateProviderStatus(supabase, provider, {
    status: 'healthy',
    last_success: new Date().toISOString(),
    error_count: 0,
    response_time_ms: responseTimeMs,
  });
}

// Record an error from an API call
export async function recordError(
  supabase: SupabaseClient,
  provider: ProviderName,
  statusCode: number,
  errorMessage: string
): Promise<void> {
  let status: ProviderStatus = 'error';
  let rateLimitUntil: string | undefined;

  if (statusCode === 429) {
    status = 'rate_limited';
    // Default 1 minute rate limit if no header
    rateLimitUntil = new Date(Date.now() + 60000).toISOString();
  } else if (statusCode === 402) {
    status = 'credits_exhausted';
  } else if (statusCode >= 500) {
    status = 'degraded';
  }

  await updateProviderStatus(supabase, provider, {
    status,
    last_error: errorMessage,
    error_count: 1, // Will be incremented
    rate_limit_until: rateLimitUntil,
  });
}

// Check if a provider is healthy
export async function isProviderHealthy(
  supabase: SupabaseClient,
  provider: ProviderName
): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('atlas_provider_status')
      .select('status, rate_limit_until')
      .eq('provider', provider)
      .single();

    if (!data) return true; // Assume healthy if no data

    // Check rate limit
    if (data.status === 'rate_limited' && data.rate_limit_until) {
      const limitUntil = new Date(data.rate_limit_until);
      if (limitUntil > new Date()) {
        return false;
      }
    }

    return data.status === 'healthy' || data.status === 'unknown';
  } catch {
    return true; // Assume healthy on error
  }
}

// Check if all providers are healthy
export async function isSystemHealthy(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('atlas_provider_status')
      .select('provider, status')
      .in('status', ['error', 'credits_exhausted']);

    // If any critical provider is down, system is not healthy
    const criticalProviders = ['lovable_ai'];
    const downCritical = data?.some((p: { provider: string; status: string }) => 
      criticalProviders.includes(p.provider)
    );
    
    return !downCritical;
  } catch {
    return true;
  }
}

// Check if learning is enabled
export async function isLearningEnabled(supabase: SupabaseClient): Promise<{
  enabled: boolean;
  mode: string;
  maxTopics: number;
  maxDepth: number;
}> {
  try {
    const { data } = await supabase
      .from('atlas_system_settings')
      .select('learning_enabled, learning_mode, max_topics_per_session, max_research_depth')
      .limit(1)
      .single();

    if (!data) {
      return { enabled: false, mode: 'disabled', maxTopics: 3, maxDepth: 2 };
    }

    return {
      enabled: data.learning_enabled,
      mode: data.learning_mode,
      maxTopics: data.max_topics_per_session,
      maxDepth: data.max_research_depth,
    };
  } catch {
    return { enabled: false, mode: 'disabled', maxTopics: 3, maxDepth: 2 };
  }
}

// Disable learning due to critical error
export async function disableLearningOnError(
  supabase: SupabaseClient,
  reason: string
): Promise<void> {
  try {
    await supabase
      .from('atlas_system_settings')
      .update({ 
        learning_enabled: false,
        updated_at: new Date().toISOString()
      })
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Update all rows

    console.log(`[providerStatus] Learning disabled due to: ${reason}`);
  } catch (e) {
    console.error('[providerStatus] Failed to disable learning:', e);
  }
}

// Detect learning intent in a message
export function detectLearningIntent(content: string): {
  hasIntent: boolean;
  topic?: string;
  intentType?: 'learn' | 'research' | 'remember' | 'teach';
} {
  // Patterns are anchored to the start of the request (optionally prefixed by
  // an address like "Atlas," or a politeness marker) so that a passing mention
  // of "research" mid-sentence no longer triggers background learning. Only
  // explicit asks count.
  const PREFIX = String.raw`^(?:atlas[,!]?\s+)?(?:please\s+)?(?:can you\s+|could you\s+|will you\s+)?`;

  const learningPatterns = [
    { regex: new RegExp(PREFIX + String.raw`learn\s+(?:about|more about)\s+(.+)`, 'i'), type: 'learn' as const },
    { regex: new RegExp(PREFIX + String.raw`research\s+(.+)`, 'i'), type: 'research' as const },
    { regex: new RegExp(PREFIX + String.raw`find out (?:about|more about)\s+(.+)`, 'i'), type: 'research' as const },
    { regex: new RegExp(PREFIX + String.raw`look into\s+(.+)`, 'i'), type: 'research' as const },
    { regex: new RegExp(PREFIX + String.raw`(?:i(?:'d| would) like to |let me )?teach you (?:about\s+)?(.+)`, 'i'), type: 'teach' as const },
    { regex: new RegExp(PREFIX + String.raw`remember (?:that\s+)?(.+)`, 'i'), type: 'remember' as const },
    { regex: new RegExp(PREFIX + String.raw`tell me everything about\s+(.+)`, 'i'), type: 'research' as const },
  ];

  for (const pattern of learningPatterns) {
    const match = content.match(pattern.regex);
    if (match) {
      const topic = match[1]?.trim();
      // A topic of one throwaway word ("research it", "research this") is a
      // conversational reference, not a research request.
      const substantive = topic && topic.length >= 4 &&
        !/^(it|this|that|them|those|these|stuff|things?)[.!?]?$/i.test(topic);
      if (substantive) {
        return {
          hasIntent: true,
          topic,
          intentType: pattern.type,
        };
      }
    }
  }

  return { hasIntent: false };
}

// Log a learning session
export async function logLearningSession(
  supabase: SupabaseClient,
  data: {
    userId?: string;
    sessionId?: string;
    triggerType: 'voice' | 'text' | 'manual' | 'scheduled';
    intentDetected?: string;
    topicRequested?: string;
    status: 'started' | 'learning' | 'completed' | 'stopped' | 'error';
    errorMessage?: string;
    topicsLearned?: number;
    maxTopicsAllowed?: number;
  }
): Promise<string | null> {
  try {
    const { data: inserted, error } = await supabase
      .from('atlas_learning_logs')
      .insert({
        user_id: data.userId || null,
        session_id: data.sessionId || null,
        trigger_type: data.triggerType,
        intent_detected: data.intentDetected,
        topic_requested: data.topicRequested,
        topics_learned: data.topicsLearned || 0,
        max_topics_allowed: data.maxTopicsAllowed || 3,
        status: data.status,
        error_message: data.errorMessage,
        completed_at: data.status === 'completed' || data.status === 'error' 
          ? new Date().toISOString() 
          : null,
      })
      .select('id')
      .single();

    if (error) {
      console.error('[providerStatus] Failed to log learning session:', error);
      return null;
    }

    return inserted?.id || null;
  } catch (e) {
    console.error('[providerStatus] Failed to log learning session:', e);
    return null;
  }
}

// Update a learning session
export async function updateLearningSession(
  supabase: SupabaseClient,
  sessionId: string,
  data: {
    status?: 'started' | 'learning' | 'completed' | 'stopped' | 'error';
    topicsLearned?: number;
    errorMessage?: string;
    providerErrors?: Record<string, string>;
  }
): Promise<void> {
  try {
    const updateData: Record<string, unknown> = {};
    
    if (data.status) updateData.status = data.status;
    if (data.topicsLearned !== undefined) updateData.topics_learned = data.topicsLearned;
    if (data.errorMessage) updateData.error_message = data.errorMessage;
    if (data.providerErrors) updateData.provider_errors = data.providerErrors;
    
    if (data.status === 'completed' || data.status === 'error' || data.status === 'stopped') {
      updateData.completed_at = new Date().toISOString();
    }

    await supabase
      .from('atlas_learning_logs')
      .update(updateData)
      .eq('id', sessionId);
  } catch (e) {
    console.error('[providerStatus] Failed to update learning session:', e);
  }
}

// Check if Lovable AI is enabled (master kill switch)
export async function isLovableAIEnabled(supabase: SupabaseClient): Promise<{
  enabled: boolean;
  reason?: string;
  disabledAt?: string;
}> {
  try {
    const { data } = await supabase
      .from('atlas_system_settings')
      .select('lovable_ai_enabled, disable_reason, disabled_at')
      .limit(1)
      .single();

    if (!data) {
      return { enabled: true }; // Default to enabled if no settings
    }

    return {
      enabled: data.lovable_ai_enabled !== false, // Default true
      reason: data.disable_reason || undefined,
      disabledAt: data.disabled_at || undefined,
    };
  } catch {
    return { enabled: true }; // Default to enabled on error
  }
}
