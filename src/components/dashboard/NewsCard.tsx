import { memo } from 'react';
import { Newspaper, ExternalLink, TrendingUp } from 'lucide-react';
import { DashboardCard } from './DashboardCard';
import { motion } from 'framer-motion';

interface NewsCardProps { 
  isFocused?: boolean;
  onExpand?: () => void;
}

const mockNews = [
  { id: 1, title: 'AI Breakthrough: New Language Models Show Human-Level Reasoning', source: 'TechCrunch', time: '2h ago', trending: true, category: 'Technology' },
  { id: 2, title: 'Global Markets Rally on Positive Economic Data', source: 'Bloomberg', time: '4h ago', trending: true, category: 'Finance' },
  { id: 3, title: 'Space Agency Announces New Moon Mission Timeline', source: 'Reuters', time: '6h ago', trending: false, category: 'Science' },
];

const NewsCardComponent = ({ isFocused, onExpand }: NewsCardProps) => {
  return (
    <DashboardCard 
      glowColor="rgba(168, 85, 247, 0.15)"
      onClick={onExpand}
      header={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-purple-500/20 to-violet-500/20 border border-purple-500/20">
              <Newspaper className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white">News Feed</h3>
              <p className="text-xs text-slate-400">Top stories</p>
            </div>
          </div>
          <motion.button 
            whileHover={{ scale: 1.05 }} 
            className="px-3 py-1.5 text-xs font-medium text-purple-400 bg-purple-500/10 rounded-lg"
          >
            View All
          </motion.button>
        </div>
      }
    >
      <div className="space-y-3">
        {mockNews.map((news, i) => (
          <motion.div 
            key={news.id} 
            initial={{ opacity: 0, y: 10 }} 
            animate={{ opacity: 1, y: 0 }} 
            transition={{ delay: i * 0.1 }}
            className="group relative p-4 rounded-xl cursor-pointer bg-white/5 border border-white/5 hover:bg-white/10 hover:border-white/10 transition-all"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-medium text-purple-400 bg-purple-500/20 px-2 py-0.5 rounded-full">
                    {news.category}
                  </span>
                  {news.trending && (
                    <span className="flex items-center gap-1 text-xs text-emerald-400">
                      <TrendingUp className="w-3 h-3" />
                      Trending
                    </span>
                  )}
                </div>
                <h4 className="font-medium text-white text-sm line-clamp-2 mb-2 group-hover:text-purple-200 transition-colors">
                  {news.title}
                </h4>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>{news.source}</span>
                  <span>•</span>
                  <span>{news.time}</span>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-slate-500 opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity" />
            </div>
          </motion.div>
        ))}
      </div>
    </DashboardCard>
  );
};

export const NewsCard = memo(NewsCardComponent);
