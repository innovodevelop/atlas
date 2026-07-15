import { useMemo } from 'react';
import { useTasks } from './useTasks';
import { useNotes } from './useNotes';
import { useCalendarEvents } from './useCalendarEvents';

export interface CardPriorityInfo {
  id: string;
  priority: 'high' | 'medium' | 'low';
  score: number;
  isEmpty: boolean;
  hasNew: boolean;
  label?: string;
}

export interface CardPriorityResult {
  sortedCards: string[];
  cardMeta: Record<string, CardPriorityInfo>;
}

// Card IDs that we track
const ALL_CARDS = [
  'assistant',
  'weather',
  'travel',
  'email',
  'calendar',
  'stocks',
  'tasks',
  'notes',
  'news',
  'documents',
] as const;

export type CardId = typeof ALL_CARDS[number];

export const useCardPriority = (): CardPriorityResult => {
  const { tasks, isLoading: tasksLoading } = useTasks();
  const { notes, isLoading: notesLoading } = useNotes();
  const { events, isLoading: eventsLoading } = useCalendarEvents();

  const result = useMemo(() => {
    const now = new Date();
    const today = now.toDateString();
    const cardMeta: Record<string, CardPriorityInfo> = {};

    // Calculate priority for each card
    ALL_CARDS.forEach((cardId) => {
      let score = 50; // Default medium priority
      let isEmpty = false;
      let hasNew = false;
      let label: string | undefined;

      switch (cardId) {
        case 'assistant':
          // Atlas is always high priority and fixed position
          score = 200;
          break;

        case 'tasks': {
          if (tasksLoading) {
            score = 50;
          } else if (tasks.length === 0) {
            isEmpty = true;
            score = 10;
          } else {
            const incompleteTasks = tasks.filter((t) => !t.completed);
            const overdueTasks = incompleteTasks.filter(
              (t) => t.due_date && new Date(t.due_date) < now
            );
            const todayTasks = incompleteTasks.filter(
              (t) => t.due_date && new Date(t.due_date).toDateString() === today
            );

            if (overdueTasks.length > 0) {
              score = 150;
              hasNew = true;
              label = `${overdueTasks.length} overdue`;
            } else if (todayTasks.length > 0) {
              score = 120;
              hasNew = true;
              label = `${todayTasks.length} due today`;
            } else if (incompleteTasks.length > 0) {
              score = 80;
            } else {
              score = 40;
            }
          }
          break;
        }

        case 'notes': {
          if (notesLoading) {
            score = 50;
          } else if (notes.length === 0) {
            isEmpty = true;
            score = 10;
          } else {
            // Check for recently updated notes (within last 24 hours)
            const recentNotes = notes.filter(
              (n) => now.getTime() - new Date(n.updated_at).getTime() < 86400000
            );
            if (recentNotes.length > 0) {
              score = 90;
              hasNew = true;
              label = 'Recently updated';
            } else {
              score = 60;
            }
          }
          break;
        }

        case 'calendar': {
          if (eventsLoading) {
            score = 50;
          } else if (events.length === 0) {
            isEmpty = true;
            score = 10;
          } else {
            const todayEvents = events.filter(
              (e) => new Date(e.start_time).toDateString() === today
            );
            // Check for events happening now or in next 2 hours
            const soonEvents = todayEvents.filter((e) => {
              const start = new Date(e.start_time).getTime();
              return start <= now.getTime() + 7200000 && start >= now.getTime() - 3600000;
            });

            if (soonEvents.length > 0) {
              score = 160;
              hasNew = true;
              label = 'Happening soon';
            } else if (todayEvents.length > 0) {
              score = 110;
              hasNew = true;
              label = `${todayEvents.length} today`;
            } else {
              score = 70;
            }
          }
          break;
        }

        case 'email':
          // Email uses mock data, assume medium-high priority with content
          score = 100;
          hasNew = true;
          label = 'New messages';
          break;

        case 'weather':
          // Weather is always relevant, medium-high
          score = 85;
          break;

        case 'stocks': {
          // Stocks are relevant during market hours
          const hour = now.getHours();
          if (hour >= 9 && hour <= 16) {
            score = 95;
            hasNew = true;
            label = 'Market open';
          } else {
            score = 65;
          }
          break;
        }

        case 'news':
          // News is always medium priority
          score = 75;
          break;

        case 'travel':
          // Travel - assume medium unless we have trip data
          score = 55;
          break;

        case 'documents':
          // Documents - default medium
          score = 45;
          break;

        default:
          score = 50;
      }

      const priority: 'high' | 'medium' | 'low' =
        score >= 100 ? 'high' : score >= 50 ? 'medium' : 'low';

      cardMeta[cardId] = {
        id: cardId,
        priority,
        score,
        isEmpty,
        hasNew,
        label,
      };
    });

    // Sort cards by score (highest first), but keep assistant at position 0
    const sortedCards = [...ALL_CARDS].sort((a, b) => {
      // Assistant always first
      if (a === 'assistant') return -1;
      if (b === 'assistant') return 1;
      // Empty cards go to the end
      if (cardMeta[a].isEmpty && !cardMeta[b].isEmpty) return 1;
      if (!cardMeta[a].isEmpty && cardMeta[b].isEmpty) return -1;
      // Sort by score
      return cardMeta[b].score - cardMeta[a].score;
    });

    return { sortedCards, cardMeta };
  }, [tasks, notes, events, tasksLoading, notesLoading, eventsLoading]);

  return result;
};
