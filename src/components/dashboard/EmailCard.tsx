import { memo } from 'react';
import { Mail, Star, ChevronRight } from 'lucide-react';
import { DashboardCard } from './DashboardCard';
import { motion } from 'framer-motion';

interface EmailCardProps { 
  isFocused?: boolean; 
  streamingData?: any[];
  onExpand?: () => void;
}

const mockEmails = [
  { id: 1, sender: 'Sarah Chen', subject: 'Q4 Budget Review', preview: 'Hi, I need your input on the Q4 budget...', time: '10:32 AM', read: false, starred: true, avatar: 'SC', avatarColor: 'bg-gradient-to-br from-pink-500 to-rose-500' },
  { id: 2, sender: 'Mike Johnson', subject: 'Re: Project Timeline', preview: 'Thanks for the update. The timeline works...', time: '9:15 AM', read: false, starred: false, avatar: 'MJ', avatarColor: 'bg-gradient-to-br from-blue-500 to-cyan-500' },
  { id: 3, sender: 'Design Team', subject: 'Brand Guidelines Released', preview: 'The updated guidelines are now available...', time: 'Yesterday', read: true, starred: false, avatar: 'DT', avatarColor: 'bg-gradient-to-br from-purple-500 to-violet-500' },
  { id: 4, sender: 'Alex Rivera', subject: 'Meeting Notes', preview: 'Key takeaways from our meeting yesterday...', time: 'Yesterday', read: true, starred: true, avatar: 'AR', avatarColor: 'bg-gradient-to-br from-emerald-500 to-teal-500' },
];

const EmailCardComponent = ({ isFocused, onExpand }: EmailCardProps) => {
  const unreadCount = mockEmails.filter(e => !e.read).length;
  return (
    <DashboardCard glowColor="rgba(236, 72, 153, 0.15)" onClick={onExpand} header={
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-pink-500/20 to-rose-500/20 border border-pink-500/20"><Mail className="w-5 h-5 text-pink-400" /></div>
          <div><h3 className="font-semibold text-white">Inbox</h3><p className="text-xs text-slate-400">{unreadCount} unread</p></div>
        </div>
        <motion.button whileHover={{ scale: 1.05 }} className="px-3 py-1.5 text-xs font-medium text-pink-400 bg-pink-500/10 rounded-lg">View All</motion.button>
      </div>
    }>
      <div className="space-y-1">
        {mockEmails.map((email, i) => (
          <motion.div key={email.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.1 }} className={`group relative p-3 rounded-xl cursor-pointer hover:bg-white/5 ${email.read ? 'opacity-70' : ''}`}>
            <div className="flex items-start gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold text-white ${email.avatarColor}`}>{email.avatar}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className={`font-medium truncate ${email.read ? 'text-slate-300' : 'text-white'}`}>{email.sender}</span>
                  <div className="flex items-center gap-2">{email.starred && <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />}<span className="text-xs text-slate-500">{email.time}</span></div>
                </div>
                <p className={`text-sm truncate ${email.read ? 'text-slate-400' : 'text-slate-200'}`}>{email.subject}</p>
                <p className="text-xs text-slate-500 truncate">{email.preview}</p>
              </div>
              {!email.read && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-gradient-to-b from-pink-400 to-rose-500 rounded-r-full" />}
            </div>
            <ChevronRight className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 opacity-0 group-hover:opacity-100" />
          </motion.div>
        ))}
      </div>
    </DashboardCard>
  );
};

export const EmailCard = memo(EmailCardComponent);
