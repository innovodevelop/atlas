import { memo } from 'react';
import { Calendar, Clock, Video, MapPin, ChevronRight, Plus, Trash2, Loader2 } from 'lucide-react';
import { DashboardCard } from './DashboardCard';
import { motion } from 'framer-motion';
import { format, isToday, isBefore, isAfter, addHours } from 'date-fns';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useState } from 'react';

interface CalendarCardProps { 
  isFocused?: boolean; 
  streamingData?: any[];
  onExpand?: () => void;
}

const eventColors = [
  'from-emerald-500 to-teal-500',
  'from-blue-500 to-cyan-500',
  'from-violet-500 to-purple-500',
  'from-rose-500 to-pink-500',
  'from-amber-500 to-orange-500',
];

const CalendarCardComponent = ({ isFocused, onExpand }: CalendarCardProps) => {
  const { events, isLoading, addEvent, deleteEvent } = useCalendarEvents();
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  
  const today = format(new Date(), 'EEEE, MMM d');

  // Filter to today's events and sort by time
  const todayEvents = events
    .filter(e => isToday(new Date(e.start_time)))
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  const isEventNow = (startTime: string, endTime: string | null) => {
    const now = new Date();
    const start = new Date(startTime);
    const end = endTime ? new Date(endTime) : addHours(start, 1);
    return isAfter(now, start) && isBefore(now, end);
  };

  const handleAddEvent = async () => {
    if (!newTitle.trim()) return;
    const now = new Date();
    const startTime = new Date(now.setHours(now.getHours() + 1, 0, 0, 0));
    await addEvent({
      title: newTitle,
      start_time: startTime,
      end_time: new Date(startTime.getTime() + 60 * 60 * 1000),
    });
    setNewTitle('');
    setIsAdding(false);
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteEvent(id);
  };

  const formatEventTime = (startTime: string) => {
    return format(new Date(startTime), 'h:mm a');
  };

  const getDuration = (startTime: string, endTime: string | null) => {
    if (!endTime) return '1 hour';
    const start = new Date(startTime);
    const end = new Date(endTime);
    const minutes = Math.round((end.getTime() - start.getTime()) / (1000 * 60));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainingMins = minutes % 60;
    return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours} hour${hours > 1 ? 's' : ''}`;
  };

  return (
    <DashboardCard 
      glowColor="rgba(59, 130, 246, 0.15)" 
      onClick={onExpand}
      header={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-blue-500/20">
              <Calendar className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white">Today</h3>
              <p className="text-xs text-slate-400">{today}</p>
            </div>
          </div>
          <motion.button 
            whileHover={{ scale: 1.05 }} 
            onClick={(e) => { e.stopPropagation(); setIsAdding(true); }}
            className="px-3 py-1.5 text-xs font-medium text-blue-400 bg-blue-500/10 rounded-lg hover:bg-blue-500/20"
          >
            <Plus className="w-4 h-4" />
          </motion.button>
        </div>
      }
    >
      <div className="relative space-y-3">
        <div className="absolute left-[18px] top-3 bottom-3 w-px bg-gradient-to-b from-slate-700 via-slate-600 to-slate-700" />
        
        {isAdding && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="relative pl-10 pr-3 py-3 rounded-xl bg-blue-500/10 border border-blue-500/20"
          >
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Event title..."
              className="w-full bg-transparent text-white text-sm placeholder:text-slate-400 outline-none"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddEvent();
                if (e.key === 'Escape') setIsAdding(false);
              }}
              onClick={(e) => e.stopPropagation()}
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={(e) => { e.stopPropagation(); handleAddEvent(); }}
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
          <div className="flex items-center justify-center py-8 pl-10">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        ) : todayEvents.length === 0 ? (
          <div className="text-center py-8 pl-10 text-slate-400 text-sm">
            No events today. Click + to add one.
          </div>
        ) : (
          todayEvents.slice(0, 4).map((event, i) => {
            const isNow = isEventNow(event.start_time, event.end_time);
            const colorClass = eventColors[i % eventColors.length];
            
            return (
              <motion.div 
                key={event.id} 
                initial={{ opacity: 0, x: -10 }} 
                animate={{ opacity: 1, x: 0 }} 
                transition={{ delay: i * 0.1 }} 
                className="group relative pl-10 pr-3 py-3 rounded-xl cursor-pointer hover:bg-white/5"
                onClick={(e) => e.stopPropagation()}
              >
                <div className={`absolute left-3 top-4 w-3 h-3 rounded-full border-2 border-slate-800 bg-gradient-to-br ${colorClass} ${isNow ? 'ring-2 ring-offset-2 ring-offset-slate-900 ring-emerald-400/50' : ''}`} />
                {isNow && (
                  <div className="absolute left-8 -top-1 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-400 bg-emerald-500/20 rounded-full border border-emerald-500/30">
                    Now
                  </div>
                )}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-white truncate">{event.title}</h4>
                    <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-400">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatEventTime(event.start_time)} · {getDuration(event.start_time, event.end_time)}
                      </span>
                      {event.location && (
                        event.event_type === 'video' ? (
                          <span className="flex items-center gap-1 text-blue-400">
                            <Video className="w-3 h-3" />{event.location}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1">
                            <MapPin className="w-3 h-3" />{event.location}
                          </span>
                        )
                      )}
                    </div>
                  </div>
                  <button 
                    onClick={(e) => handleDelete(e, event.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-white/10 rounded"
                  >
                    <Trash2 className="w-3 h-3 text-slate-400 hover:text-red-400" />
                  </button>
                </div>
                <ChevronRight className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 opacity-0 group-hover:opacity-100" />
              </motion.div>
            );
          })
        )}
      </div>
    </DashboardCard>
  );
};

export const CalendarCard = memo(CalendarCardComponent);
