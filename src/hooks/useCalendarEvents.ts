import { useState, useCallback } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useAuth } from './useAuth';
import { useDataFetching } from './useDataFetching';
import { useCrudOperations } from './useCrudOperations';

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string | null;
  location: string | null;
  event_type: string;
  attendees: string[];
  created_at: string;
  updated_at: string;
}

const transformEvent = (data: Record<string, unknown>): CalendarEvent => ({
  ...data,
  attendees: Array.isArray(data.attendees)
    ? data.attendees.map((a: unknown) => String(a))
    : []
} as CalendarEvent);

const sortByStartTime = (a: CalendarEvent, b: CalendarEvent) => 
  new Date(a.start_time).getTime() - new Date(b.start_time).getTime();

export const useCalendarEvents = () => {
  const { user } = useAuth();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [crudError, setCrudError] = useState<string | null>(null);

  const fetcher = useCallback(async (): Promise<CalendarEvent[]> => {
    if (!user) return [];
    
    const { data, error } = await supabase
      .from('user_events')
      .select('*')
      .gte('start_time', new Date().toISOString().split('T')[0])
      .order('start_time', { ascending: true });

    if (error) throw error;
    return (data || []).map(transformEvent);
  }, [user]);

  const { isLoading, error: fetchError, refetch } = useDataFetching<CalendarEvent[]>({
    fetcher,
    enabled: !!user,
    onSuccess: setEvents,
  });

  const { add, update, remove } = useCrudOperations<CalendarEvent>(
    { items: events, setItems: setEvents, isLoading, error: crudError, setError: setCrudError },
    { 
      table: 'user_events', 
      userId: user?.id, 
      transform: transformEvent,
      sortFn: sortByStartTime,
    }
  );

  const addEvent = useCallback(async (event: {
    title: string;
    description?: string;
    start_time: Date;
    end_time?: Date;
    location?: string;
    event_type?: string;
    attendees?: string[];
  }) => {
    return add({
      title: event.title,
      description: event.description || null,
      start_time: event.start_time.toISOString(),
      end_time: event.end_time?.toISOString() || null,
      location: event.location || null,
      event_type: event.event_type || 'meeting',
      attendees: event.attendees || [],
    } as Partial<CalendarEvent>);
  }, [add]);

  const updateEvent = useCallback(async (
    id: string, 
    updates: Partial<Omit<CalendarEvent, 'id' | 'created_at' | 'updated_at'>>
  ) => {
    return update(id, updates);
  }, [update]);

  const deleteEvent = useCallback(async (id: string) => {
    return remove(id);
  }, [remove]);

  const error = fetchError || crudError;

  return {
    events,
    isLoading,
    error,
    addEvent,
    updateEvent,
    deleteEvent,
    refetch,
  };
};
