import { useState, useEffect, useCallback } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  model_config_json: {
    planner?: string;
    worker?: string;
    reasoner?: string;
  };
  enabled_tools_json: string[];
  risky_tools_json: string[];
  max_steps: number;
  daily_budget_limit: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentFormData {
  name: string;
  description?: string;
  system_prompt: string;
  model_config_json?: Agent['model_config_json'];
  enabled_tools_json?: string[];
  risky_tools_json?: string[];
  max_steps?: number;
  daily_budget_limit?: number;
  is_active?: boolean;
}

const DEFAULT_MODELS = {
  planner: 'openai/gpt-5',
  worker: 'google/gemini-2.5-flash',
  reasoner: 'openai/gpt-5',
};

const AVAILABLE_TOOLS = [
  'web_search',
  'calculate',
  'get_time',
  'memory_recall',
  'memory_store',
  'file_read',
  'file_write',
  'shell_exec',
  'api_call',
  'send_email',
  'calendar_create',
  'task_create',
];

const DEFAULT_RISKY_TOOLS = ['file_write', 'shell_exec', 'api_call', 'send_email'];

export function useAgents() {
  const { user } = useAuth();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchAgents = useCallback(async () => {
    if (!user) return;
    
    try {
      const { data, error } = await supabase
        .from('agents')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      
      const typedData: Agent[] = (data || []).map(a => ({
        ...a,
        model_config_json: a.model_config_json as Agent['model_config_json'] || DEFAULT_MODELS,
        enabled_tools_json: Array.isArray(a.enabled_tools_json) ? a.enabled_tools_json as string[] : [],
        risky_tools_json: Array.isArray(a.risky_tools_json) ? a.risky_tools_json as string[] : DEFAULT_RISKY_TOOLS,
        max_steps: a.max_steps || 20,
        daily_budget_limit: a.daily_budget_limit || 5,
        is_active: a.is_active ?? true,
      }));
      
      setAgents(typedData);
    } catch (error) {
      console.error('Error fetching agents:', error);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const createAgent = useCallback(async (data: AgentFormData) => {
    if (!user) throw new Error('Not authenticated');

    const { data: newAgent, error } = await supabase
      .from('agents')
      .insert({
        user_id: user.id,
        name: data.name,
        description: data.description || null,
        system_prompt: data.system_prompt,
        model_config_json: data.model_config_json || DEFAULT_MODELS,
        enabled_tools_json: data.enabled_tools_json || AVAILABLE_TOOLS.filter(t => !DEFAULT_RISKY_TOOLS.includes(t)),
        risky_tools_json: data.risky_tools_json || DEFAULT_RISKY_TOOLS,
        max_steps: data.max_steps || 20,
        daily_budget_limit: data.daily_budget_limit || 5,
        is_active: data.is_active ?? true,
      })
      .select()
      .single();

    if (error) throw error;
    await fetchAgents();
    return newAgent;
  }, [user, fetchAgents]);

  const updateAgent = useCallback(async (id: string, data: Partial<AgentFormData>) => {
    const { error } = await supabase
      .from('agents')
      .update({
        ...data,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) throw error;
    await fetchAgents();
  }, [fetchAgents]);

  const deleteAgent = useCallback(async (id: string) => {
    const { error } = await supabase
      .from('agents')
      .delete()
      .eq('id', id);

    if (error) throw error;
    await fetchAgents();
  }, [fetchAgents]);

  const toggleAgent = useCallback(async (id: string, is_active: boolean) => {
    await updateAgent(id, { is_active });
  }, [updateAgent]);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  return {
    agents,
    isLoading,
    fetchAgents,
    createAgent,
    updateAgent,
    deleteAgent,
    toggleAgent,
    availableTools: AVAILABLE_TOOLS,
    defaultModels: DEFAULT_MODELS,
    defaultRiskyTools: DEFAULT_RISKY_TOOLS,
  };
}
