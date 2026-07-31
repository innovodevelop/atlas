import { useState, useCallback } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useAuth } from './useAuth';
import { useDataFetching } from './useDataFetching';
import { useCrudOperations } from './useCrudOperations';

export interface Note {
  id: string;
  title: string;
  content: string | null;
  color: string;
  created_at: string;
  updated_at: string;
}

export const useNotes = () => {
  const { user } = useAuth();
  const [notes, setNotes] = useState<Note[]>([]);
  const [crudError, setCrudError] = useState<string | null>(null);

  const fetcher = useCallback(async (): Promise<Note[]> => {
    if (!user) return [];
    
    const { data, error } = await supabase
      .from('user_notes')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }, [user]);

  const { isLoading, error: fetchError, refetch } = useDataFetching<Note[]>({
    fetcher,
    enabled: !!user,
    onSuccess: setNotes,
  });

  const { add, update, remove } = useCrudOperations<Note>(
    { items: notes, setItems: setNotes, isLoading, error: crudError, setError: setCrudError },
    { table: 'user_notes', userId: user?.id }
  );

  const addNote = useCallback(async (title: string, content?: string, color?: string) => {
    return add({
      title,
      content: content || null,
      color: color || 'amber',
    } as Partial<Note>);
  }, [add]);

  const updateNote = useCallback(async (
    id: string, 
    updates: Partial<Pick<Note, 'title' | 'content' | 'color'>>
  ) => {
    return update(id, updates);
  }, [update]);

  const deleteNote = useCallback(async (id: string) => {
    return remove(id);
  }, [remove]);

  const error = fetchError || crudError;

  return {
    notes,
    isLoading,
    error,
    addNote,
    updateNote,
    deleteNote,
    refetch,
  };
};
