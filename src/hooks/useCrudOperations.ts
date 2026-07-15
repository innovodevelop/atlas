import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface UseCrudOperationsOptions<T> {
  table: string;
  userId: string | undefined;
  /** Transform data from DB format to app format */
  transform?: (row: unknown) => T;
  /** Sort function for the items array */
  sortFn?: (a: T, b: T) => number;
}

export interface CrudState<T> {
  items: T[];
  setItems: React.Dispatch<React.SetStateAction<T[]>>;
  isLoading: boolean;
  error: string | null;
  setError: (error: string | null) => void;
}

export interface CrudOperations<T> {
  add: (data: Partial<T>) => Promise<T | null>;
  update: (id: string, updates: Partial<T>) => Promise<T | null>;
  remove: (id: string) => Promise<boolean>;
  optimisticUpdate: <R>(
    optimisticFn: () => void,
    serverFn: () => Promise<R>,
    rollbackFn: () => void
  ) => Promise<R | null>;
}

export function useCrudOperations<T extends { id: string }>(
  state: CrudState<T>,
  options: UseCrudOperationsOptions<T>
): CrudOperations<T> {
  const { table, userId, transform = (row) => row as T, sortFn } = options;
  const { items, setItems, setError } = state;
  
  // Keep track of previous state for rollbacks
  const previousItemsRef = useRef<T[]>([]);

  const optimisticUpdate = useCallback(async <R>(
    optimisticFn: () => void,
    serverFn: () => Promise<R>,
    rollbackFn: () => void
  ): Promise<R | null> => {
    // Store current state for rollback
    previousItemsRef.current = [...items];
    
    // Apply optimistic update
    optimisticFn();
    
    try {
      const result = await serverFn();
      return result;
    } catch (err: unknown) {
      // Rollback on error
      rollbackFn();
      setError(err instanceof Error ? err.message : 'Error');
      return null;
    }
  }, [items, setError]);

  const add = useCallback(async (data: Partial<T>): Promise<T | null> => {
    if (!userId) return null;

    // Create optimistic item with temp ID
    const tempId = `temp-${Date.now()}`;
    const optimisticItem = {
      ...data,
      id: tempId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as unknown as T;

    return optimisticUpdate(
      // Optimistic update
      () => {
        setItems(prev => {
          const newItems = [optimisticItem, ...prev];
          return sortFn ? newItems.sort(sortFn) : newItems;
        });
      },
      // Server call
      async () => {
        const { data: result, error } = await supabase
          .from(table as any)
          .insert({ ...data, user_id: userId })
          .select()
          .single();

        if (error) throw error;
        
        const newItem = transform(result);
        // Replace temp item with real one
        setItems(prev => {
          const filtered = prev.filter(item => item.id !== tempId);
          const newItems = [newItem, ...filtered];
          return sortFn ? newItems.sort(sortFn) : newItems;
        });
        return newItem;
      },
      // Rollback
      () => setItems(previousItemsRef.current)
    );
  }, [userId, table, transform, sortFn, setItems, optimisticUpdate]);

  const update = useCallback(async (id: string, updates: Partial<T>): Promise<T | null> => {
    const originalItem = items.find(item => item.id === id);
    if (!originalItem) return null;

    return optimisticUpdate(
      // Optimistic update
      () => {
        setItems(prev => prev.map(item => 
          item.id === id 
            ? { ...item, ...updates, updated_at: new Date().toISOString() } 
            : item
        ));
      },
      // Server call
      async () => {
        const { data: result, error } = await supabase
          .from(table as any)
          .update(updates)
          .eq('id', id)
          .select()
          .single();

        if (error) throw error;
        
        const updatedItem = transform(result);
        setItems(prev => prev.map(item => item.id === id ? updatedItem : item));
        return updatedItem;
      },
      // Rollback
      () => setItems(previousItemsRef.current)
    );
  }, [items, table, transform, setItems, optimisticUpdate]);

  const remove = useCallback(async (id: string): Promise<boolean> => {
    return optimisticUpdate(
      // Optimistic update
      () => setItems(prev => prev.filter(item => item.id !== id)),
      // Server call
      async () => {
        const { error } = await supabase
          .from(table as any)
          .delete()
          .eq('id', id);

        if (error) throw error;
        return true;
      },
      // Rollback
      () => setItems(previousItemsRef.current)
    ) as Promise<boolean>;
  }, [table, setItems, optimisticUpdate]);

  return { add, update, remove, optimisticUpdate };
}
