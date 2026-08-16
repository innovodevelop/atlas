import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';
import type { CardSize } from '@/components/atlas-ui/primitives';

export interface DashboardSlot {
  id: string;
  widget_id: string;
  position: number;
  size: CardSize;
  visible: boolean;
}

const DEFAULT_ORDER: Array<{ widget_id: string; size: CardSize }> = [
  { widget_id: 'weather', size: 'l' },
  { widget_id: 'calendar', size: 'l' },
  { widget_id: 'tasks', size: 'l' },
  { widget_id: 'stocks', size: 'xl' },
  { widget_id: 'mail', size: 'l' },
  { widget_id: 'briefing', size: 'l' },
  { widget_id: 'air', size: 's' },
  { widget_id: 'music', size: 's' },
  { widget_id: 'activity', size: 'm' },
  { widget_id: 'worldclock', size: 's' },
];

function defaultSlots(): DashboardSlot[] {
  return DEFAULT_ORDER.map((d, i) => ({
    id: `default-${d.widget_id}`,
    widget_id: d.widget_id,
    position: i,
    size: d.size,
    visible: true,
  }));
}

export function useDashboardLayout() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: layout } = useQuery({
    queryKey: ['dashboard_layout', user?.id],
    queryFn: async () => {
      if (!user) return defaultSlots();
      const { data } = await supabase
        .from('dashboard_layout')
        .select('*')
        .eq('user_id', user.id)
        .order('position', { ascending: true });
      if (!data || data.length === 0) return defaultSlots();
      return data as DashboardSlot[];
    },
    enabled: !!user,
    staleTime: Infinity,
  });

  const slots = useMemo(() => layout ?? defaultSlots(), [layout]);
  const visibleSlots = useMemo(() => slots.filter((s) => s.visible), [slots]);

  const reorder = useMutation({
    mutationFn: async (order: string[]) => {
      if (!user) return;
      for (let i = 0; i < order.length; i++) {
        const widgetId = order[i];
        const existing = slots.find((s) => s.widget_id === widgetId);
        if (existing && existing.id.startsWith('default-')) {
          await supabase.from('dashboard_layout').upsert({
            id: crypto.randomUUID(),
            user_id: user.id,
            widget_id: widgetId,
            position: i,
            size: existing.size,
            visible: true,
          });
        } else {
          await supabase
            .from('dashboard_layout')
            .update({ position: i })
            .eq('user_id', user.id)
            .eq('widget_id', widgetId);
        }
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard_layout'] }),
  });

  const setVisibility = useMutation({
    mutationFn: async ({ widgetId, visible }: { widgetId: string; visible: boolean }) => {
      if (!user) return;
      const existing = slots.find((s) => s.widget_id === widgetId);
      if (existing && existing.id.startsWith('default-')) {
        await supabase.from('dashboard_layout').upsert({
          id: crypto.randomUUID(),
          user_id: user.id,
          widget_id: widgetId,
          position: existing.position,
          size: existing.size,
          visible,
        });
      } else {
        await supabase
          .from('dashboard_layout')
          .update({ visible })
          .eq('user_id', user.id)
          .eq('widget_id', widgetId);
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard_layout'] }),
  });

  const setSize = useMutation({
    mutationFn: async ({ widgetId, size }: { widgetId: string; size: CardSize }) => {
      if (!user) return;
      const existing = slots.find((s) => s.widget_id === widgetId);
      if (existing && existing.id.startsWith('default-')) {
        await supabase.from('dashboard_layout').upsert({
          id: crypto.randomUUID(),
          user_id: user.id,
          widget_id: widgetId,
          position: existing.position,
          size,
          visible: true,
        });
      } else {
        await supabase
          .from('dashboard_layout')
          .update({ size })
          .eq('user_id', user.id)
          .eq('widget_id', widgetId);
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard_layout'] }),
  });

  const resetLayout = useCallback(async () => {
    if (!user) return;
    await supabase.from('dashboard_layout').delete().eq('user_id', user.id);
    qc.invalidateQueries({ queryKey: ['dashboard_layout'] });
  }, [user, qc]);

  return { slots, visibleSlots, reorder, setVisibility, setSize, resetLayout };
}
