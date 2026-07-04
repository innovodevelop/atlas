import { memo } from 'react';
import { CheckCircle2, Circle, Clock, Flag, Plus, Trash2, Loader2 } from 'lucide-react';
import { DashboardCard } from './DashboardCard';
import { motion } from 'framer-motion';
import { useTasks } from '@/hooks/useTasks';
import { useState } from 'react';
import { format } from 'date-fns';

interface TasksCardProps { 
  isFocused?: boolean;
  onExpand?: () => void;
}

const priorityColors = {
  high: 'text-red-400',
  medium: 'text-amber-400',
  low: 'text-slate-400',
};

const TasksCardComponent = ({ isFocused, onExpand }: TasksCardProps) => {
  const { tasks, isLoading, completedCount, progress, addTask, toggleTask, deleteTask } = useTasks();
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const handleAddTask = async () => {
    if (!newTitle.trim()) return;
    await addTask(newTitle, 'medium');
    setNewTitle('');
    setIsAdding(false);
  };

  const handleToggle = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await toggleTask(id);
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteTask(id);
  };

  const formatDueDate = (dueDate: string | null, completed: boolean) => {
    if (completed) return 'Completed';
    if (!dueDate) return 'No due date';
    return format(new Date(dueDate), 'MMM d, h:mm a');
  };

  return (
    <DashboardCard 
      glowColor="rgba(59, 130, 246, 0.15)"
      onClick={onExpand}
      header={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-indigo-500/20 border border-blue-500/20">
              <CheckCircle2 className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white">Tasks</h3>
              <p className="text-xs text-slate-400">{completedCount}/{tasks.length} completed</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-16 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                <motion.div 
                  className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.5 }}
                />
              </div>
              <span className="text-xs text-blue-400">{Math.round(progress)}%</span>
            </div>
            <motion.button 
              whileHover={{ scale: 1.05 }}
              onClick={(e) => { e.stopPropagation(); setIsAdding(true); }}
              className="p-2 text-blue-400 bg-blue-500/10 rounded-lg hover:bg-blue-500/20 transition-colors"
            >
              <Plus className="w-4 h-4" />
            </motion.button>
          </div>
        </div>
      }
    >
      <div className="space-y-1">
        {isAdding && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20"
          >
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Task title..."
              className="w-full bg-transparent text-white text-sm placeholder:text-slate-400 outline-none"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddTask();
                if (e.key === 'Escape') setIsAdding(false);
              }}
              onClick={(e) => e.stopPropagation()}
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={(e) => { e.stopPropagation(); handleAddTask(); }}
                className="px-3 py-1 text-xs font-medium text-blue-400 bg-blue-500/20 rounded-lg hover:bg-blue-500/30"
              >
                Add
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setIsAdding(false); }}
                className="px-3 py-1 text-xs font-medium text-slate-400 hover:text-white"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-8 text-slate-400 text-sm">
            No tasks yet. Click + to add one.
          </div>
        ) : (
          tasks.slice(0, 6).map((task, i) => (
            <motion.div 
              key={task.id} 
              initial={{ opacity: 0, x: -10 }} 
              animate={{ opacity: 1, x: 0 }} 
              transition={{ delay: i * 0.08 }}
              className={`group flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-white/5 transition-colors ${task.completed ? 'opacity-60' : ''}`}
              onClick={(e) => e.stopPropagation()}
            >
              <button onClick={(e) => handleToggle(e, task.id)}>
                {task.completed ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                ) : (
                  <Circle className="w-5 h-5 text-slate-500 flex-shrink-0 group-hover:text-blue-400 transition-colors" />
                )}
              </button>
              <div className="flex-1 min-w-0">
                <p className={`text-sm truncate ${task.completed ? 'line-through text-slate-500' : 'text-white'}`}>
                  {task.title}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <Clock className="w-3 h-3 text-slate-500" />
                  <span className="text-xs text-slate-500">{formatDueDate(task.due_date, task.completed)}</span>
                </div>
              </div>
              <Flag className={`w-4 h-4 flex-shrink-0 ${priorityColors[task.priority as keyof typeof priorityColors] || priorityColors.medium}`} />
              <button 
                onClick={(e) => handleDelete(e, task.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-white/10 rounded"
              >
                <Trash2 className="w-3 h-3 text-slate-400 hover:text-red-400" />
              </button>
            </motion.div>
          ))
        )}
      </div>
    </DashboardCard>
  );
};

export const TasksCard = memo(TasksCardComponent);
