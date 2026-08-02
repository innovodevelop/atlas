import { useMemo } from 'react';
import { useEdgeFunction } from './useEdgeFunction';

export interface StockData {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  sparkline: number[];
  open?: number | null;
  high?: number | null;
  low?: number | null;
  prevClose?: number | null;
  marketCap?: number | null;
}

export interface MarketIndex {
  label: string;
  price: number;
  changePercent: number;
}

interface StocksResponse {
  stocks: StockData[];
  indices?: MarketIndex[];
}

const MOCK_STOCKS: StockData[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', price: 189.84, change: 1.24, changePercent: 0.66, sparkline: [65, 70, 68, 72, 75, 73, 78, 82, 80, 85, 83, 88] },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', price: 141.16, change: -0.89, changePercent: -0.63, sparkline: [80, 78, 82, 79, 75, 77, 73, 70, 72, 68, 70, 69] },
  { symbol: 'MSFT', name: 'Microsoft', price: 378.91, change: 4.12, changePercent: 1.10, sparkline: [60, 62, 65, 68, 70, 72, 75, 78, 80, 82, 85, 88] },
  { symbol: 'NVDA', name: 'NVIDIA', price: 495.22, change: 12.55, changePercent: 2.60, sparkline: [45, 50, 55, 58, 62, 68, 72, 78, 82, 88, 92, 95] },
];

export const useStocks = (symbols: string[]) => {
  // Stabilize symbols for memoization
  const symbolsKey = useMemo(() => JSON.stringify(symbols.slice().sort()), [symbols]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: callers pass fresh array literals every render; keying on the serialized value is the whole point, depending on `symbols` would defeat the stabilization
  const stableSymbols = useMemo(() => symbols, [symbolsKey]);

  const fallbackData = useMemo(
    () => MOCK_STOCKS.filter(s => stableSymbols.includes(s.symbol)),
    [stableSymbols]
  );

  const fallbackResponse = useMemo<StocksResponse>(
    () => ({ stocks: fallbackData, indices: [] }),
    [fallbackData]
  );

  const { data, isLoading, error, refetch } = useEdgeFunction<StocksResponse>(
    'get-stocks',
    { symbols: stableSymbols },
    {
      fallbackData: fallbackResponse,
      refreshInterval: 5 * 60 * 1000, // 5 minutes
      enabled: stableSymbols.length > 0,
      transform: (response) => (response ?? { stocks: [], indices: [] }) as StocksResponse,
    }
  );

  return {
    stocks: data?.stocks ?? [],
    indices: data?.indices ?? [],
    isLoading,
    error,
    refetch,
  };
};
