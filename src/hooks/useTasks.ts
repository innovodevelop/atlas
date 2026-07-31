import { useState, useCallback } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useAuth } from './useAuth';
import { useDataFetching } from './useDataFetching';
import { useCrudOperations } from './useCrudOperations';

export interface Task {
  id: string;
  title: string;
  completed: boolean;
  priority: string;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export const useTasks = () => {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [crudError, setCrudError] = useState<string | null>(null);

  const fetcher = useCallback(async (): Promise<Task[]> => {
    if (!user) return [];
    
    const { data, error } = await supabase
      .from('user_tasks')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }, [user]);

  const { isLoading, error: fetchError, refetch } = useDataFetching<Task[]>({
    fetcher,
    enabled: !!user,
    onSuccess: setTasks,
  });

  const { add, update, remove, optimisticUpdate } = useCrudOperations<Task>(
    { items: tasks, setItems: setTasks, isLoading, error: crudError, setError: setCrudError },
    { table: 'user_tasks', userId: user?.id }
  );

  const addTask = useCallback(async (title: string, priority?: string, due_date?: Date) => {
    return add({
      title,
      priority: priority || 'medium',
      due_date: due_date?.toISOString() || null,
      completed: false,
    } as Partial<Task>);
  }, [add]);

  const toggleTask = useCallback(async (id: string) => {
    const task = tasks.find(t => t.id === id);
    if (!task) return null;
    return update(id, { completed: !task.completed });
  }, [tasks, update]);

  const updateTask = useCallback(async (
    id: string, 
    updates: Partial<Pick<Task, 'title' | 'priority' | 'due_date' | 'completed'>>
  ) => {
    return update(id, updates);
  }, [update]);

  const deleteTask = useCallback(async (id: string) => {
    return remove(id);
  }, [remove]);

  const error = fetchError || crudError;
  const completedCount = tasks.filter(t => t.completed).length;
  const progress = tasks.length > 0 ? (completedCount / tasks.length) * 100 : 0;

  return {
    tasks,
    isLoading,
    error,
    completedCount,
    progress,
    addTask,
    toggleTask,
    updateTask,
    deleteTask,
    refetch,
  };
};
