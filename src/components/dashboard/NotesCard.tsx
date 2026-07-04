import { memo } from 'react';
import { StickyNote, Plus, MoreHorizontal, Trash2, Loader2 } from 'lucide-react';
import { DashboardCard } from './DashboardCard';
import { motion } from 'framer-motion';
import { useNotes } from '@/hooks/useNotes';
import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';

interface NotesCardProps { 
  isFocused?: boolean;
  onExpand?: () => void;
}

const colorMap: Record<string, { gradient: string; border: string }> = {
  amber: { gradient: 'from-amber-500/20 to-orange-500/20', border: 'border-amber-500/30' },
  blue: { gradient: 'from-blue-500/20 to-cyan-500/20', border: 'border-blue-500/30' },
  violet: { gradient: 'from-violet-500/20 to-purple-500/20', border: 'border-violet-500/30' },
  emerald: { gradient: 'from-emerald-500/20 to-teal-500/20', border: 'border-emerald-500/30' },
  rose: { gradient: 'from-rose-500/20 to-pink-500/20', border: 'border-rose-500/30' },
};

const NotesCardComponent = ({ isFocused, onExpand }: NotesCardProps) => {
  const { notes, isLoading, addNote, deleteNote } = useNotes();
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const handleAddNote = async () => {
    if (!newTitle.trim()) return;
    const colors = Object.keys(colorMap);
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    await addNote(newTitle, '', randomColor);
    setNewTitle('');
    setIsAdding(false);
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteNote(id);
  };

  const getColorClasses = (color: string) => {
    return colorMap[color] || colorMap.amber;
  };

  return (
    <DashboardCard 
      glowColor="rgba(245, 158, 11, 0.15)" 
      onClick={onExpand}
      header={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/20">
              <StickyNote className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white">Notes</h3>
              <p className="text-xs text-slate-400">{notes.length} notes</p>
            </div>
          </div>
          <motion.button 
            whileHover={{ scale: 1.05 }} 
            onClick={(e) => { e.stopPropagation(); setIsAdding(true); }}
            className="p-2 text-amber-400 bg-amber-500/10 rounded-lg hover:bg-amber-500/20 transition-colors"
          >
            <Plus className="w-4 h-4" />
          </motion.button>
        </div>
      }
    >
      <div className="space-y-3">
        {isAdding && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-3 rounded-xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/30"
          >
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Note title..."
              className="w-full bg-transparent text-white text-sm placeholder:text-slate-400 outline-none"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddNote();
                if (e.key === 'Escape') setIsAdding(false);
              }}
              onClick={(e) => e.stopPropagation()}
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={(e) => { e.stopPropagation(); handleAddNote(); }}
                className="px-3 py-1 text-xs font-medium text-amber-400 bg-amber-500/20 rounded-lg hover:bg-amber-500/30"
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
            <Loader2 className="w-6 h-6 text-amber-400 animate-spin" />
          </div>
        ) : notes.length === 0 ? (
          <div className="text-center py-8 text-slate-400 text-sm">
            No notes yet. Click + to add one.
          </div>
        ) : (
          notes.slice(0, 5).map((note, i) => {
            const colors = getColorClasses(note.color);
            return (
              <motion.div 
                key={note.id} 
                initial={{ opacity: 0, y: 10 }} 
                animate={{ opacity: 1, y: 0 }} 
                transition={{ delay: i * 0.1 }}
                className={`group relative p-4 rounded-xl cursor-pointer bg-gradient-to-br ${colors.gradient} border ${colors.border} hover:scale-[1.02] transition-transform`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-start justify-between mb-2">
                  <h4 className="font-medium text-white text-sm">{note.title}</h4>
                  <button 
                    onClick={(e) => handleDelete(e, note.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-white/10 rounded"
                  >
                    <Trash2 className="w-3 h-3 text-slate-400 hover:text-red-400" />
                  </button>
                </div>
                {note.content && (
                  <p className="text-xs text-slate-300 line-clamp-2 mb-2">{note.content}</p>
                )}
                <span className="text-xs text-slate-500">
                  {formatDistanceToNow(new Date(note.updated_at), { addSuffix: true })}
                </span>
              </motion.div>
            );
          })
        )}
      </div>
    </DashboardCard>
  );
};

export const NotesCard = memo(NotesCardComponent);
