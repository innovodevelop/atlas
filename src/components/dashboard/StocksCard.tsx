import { memo } from 'react';
import { TrendingUp, TrendingDown, BarChart3, ChevronRight, Wifi } from 'lucide-react';
import { DashboardCard } from './DashboardCard';
import { motion } from 'framer-motion';
import { useStocksRealtime } from '@/hooks/useStocksRealtime';
import { useMemo, useRef, useEffect } from 'react';

interface StocksCardProps { 
  isFocused?: boolean; 
  streamingData?: any[];
  onExpand?: () => void;
}

const defaultSymbols = ['AAPL', 'GOOGL', 'MSFT', 'NVDA'];

// Seeded random for deterministic sparkline generation
const seededRandom = (seed: number) => {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
};

const Sparkline = ({ data, positive, symbol }: { data: number[]; positive: boolean; symbol: string }) => {
  const gradientId = `sparkline-${symbol}-${positive ? 'up' : 'down'}`;
  const max = Math.max(...data), min = Math.min(...data), range = max - min || 1;
  const points = data.map((v, i) => `${(i / (data.length - 1)) * 60},${20 - ((v - min) / range) * 20}`).join(' ');
  
  return (
    <svg width="60" height="24" className="overflow-visible">
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={positive ? '#22c55e' : '#ef4444'} stopOpacity="0.3"/>
          <stop offset="100%" stopColor={positive ? '#22c55e' : '#ef4444'} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polygon points={`0,24 ${points} 60,24`} fill={`url(#${gradientId})`}/>
      <polyline points={points} fill="none" stroke={positive ? '#22c55e' : '#ef4444'} strokeWidth="1.5"/>
    </svg>
  );
};

const StocksCardComponent = ({ isFocused, onExpand }: StocksCardProps) => {
  const { stocks, isLive } = useStocksRealtime(defaultSymbols);
  
  // Store price history for each symbol
  const priceHistoryRef = useRef<Record<string, number[]>>({});
  
  // Update price history when stocks change
  useEffect(() => {
    stocks.forEach(stock => {
      const history = priceHistoryRef.current[stock.symbol] || [];
      // Only add if price changed
      if (history.length === 0 || history[history.length - 1] !== stock.price) {
        history.push(stock.price);
        // Keep last 12 points
        if (history.length > 12) {
          history.shift();
        }
        priceHistoryRef.current[stock.symbol] = history;
      }
    });
  }, [stocks]);
  
  // Generate stable sparkline data based on symbol and current price
  const getSparkline = useMemo(() => (symbol: string, price: number, changePercent: number): number[] => {
    // Use existing history if available
    const history = priceHistoryRef.current[symbol];
    if (history && history.length >= 3) {
      // Pad to 12 points if needed
      while (history.length < 12) {
        history.unshift(history[0]);
      }
      return [...history];
    }
    
    // Generate deterministic data based on symbol hash
    const symbolHash = symbol.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const base = price * 0.98;
    const trend = changePercent >= 0 ? 1 : -1;
    
    return Array.from({ length: 12 }, (_, i) => {
      const seed = symbolHash * 1000 + i;
      const variation = seededRandom(seed) * price * 0.02;
      const trendFactor = (i / 11) * price * 0.01 * trend;
      return base + variation + trendFactor;
    });
  }, []);

  return (
    <DashboardCard glowColor="rgba(34, 197, 94, 0.15)" onClick={onExpand} header={
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/20">
            <BarChart3 className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <h3 className="font-semibold text-foreground">Watchlist</h3>
            <p className="text-xs text-muted-foreground">Market open</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isLive && <Wifi className="w-3 h-3 text-emerald-400" />}
          <motion.div 
            animate={{ opacity: [1, 0.5, 1] }} 
            transition={{ duration: 1, repeat: Infinity }} 
            className="w-2 h-2 bg-emerald-400 rounded-full" 
          />
          <span className="text-xs text-emerald-400">{isLive ? 'Live' : 'Delayed'}</span>
        </div>
      </div>
    }>
      <div className="space-y-1">
        {stocks.length > 0 ? stocks.map((s, i) => {
          const pos = s.changePercent >= 0;
          const sparkline = getSparkline(s.symbol, s.price, s.changePercent);
          
          return (
            <motion.div 
              key={s.symbol} 
              initial={{ opacity: 0, x: -10 }} 
              animate={{ opacity: 1, x: 0 }} 
              transition={{ delay: i * 0.1 }} 
              className="group flex items-center justify-between p-3 rounded-xl cursor-pointer hover:bg-accent/50"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xs font-bold text-foreground ${
                  pos 
                    ? 'bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/20' 
                    : 'bg-gradient-to-br from-red-500/20 to-rose-500/20 border border-red-500/20'
                }`}>
                  {s.symbol.slice(0, 2)}
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{s.symbol}</p>
                  <p className="text-xs text-muted-foreground truncate">Stock</p>
                </div>
              </div>
              <div className="hidden sm:block mx-4">
                <Sparkline data={sparkline} positive={pos} symbol={s.symbol} />
              </div>
              <div className="text-right">
                <motion.p 
                  key={`${s.symbol}-${s.price}`} 
                  initial={{ scale: 1.05, color: pos ? '#22c55e' : '#ef4444' }} 
                  animate={{ scale: 1, color: 'inherit' }}
                  transition={{ duration: 0.3 }}
                  className="font-medium text-foreground"
                >
                  ${s.price.toFixed(2)}
                </motion.p>
                <div className={`flex items-center justify-end gap-1 text-xs ${pos ? 'text-emerald-400' : 'text-red-400'}`}>
                  {pos ? <TrendingUp className="w-3 h-3"/> : <TrendingDown className="w-3 h-3"/>}
                  <span>{pos ? '+' : ''}{s.changePercent.toFixed(2)}%</span>
                </div>
              </div>
              <ChevronRight className="ml-2 w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </motion.div>
          );
        }) : defaultSymbols.map((symbol, i) => (
          <motion.div key={symbol} initial={{ opacity: 0 }} animate={{ opacity: 0.5 }} className="p-3 rounded-xl animate-pulse">
            <div className="h-10 bg-muted/30 rounded-xl" />
          </motion.div>
        ))}
      </div>
    </DashboardCard>
  );
};

export const StocksCard = memo(StocksCardComponent);
