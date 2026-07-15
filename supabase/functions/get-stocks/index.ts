import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";

const FINNHUB_API_KEY = Deno.env.get('FINNHUB_API_KEY');

// Mock data for when API is not available
const MOCK_STOCKS: Record<string, any> = {
  AAPL: { name: 'Apple Inc.', price: 189.84, change: 1.24, changePercent: 0.66 },
  GOOGL: { name: 'Alphabet Inc.', price: 141.16, change: -0.89, changePercent: -0.63 },
  MSFT: { name: 'Microsoft', price: 378.91, change: 4.12, changePercent: 1.10 },
  NVDA: { name: 'NVIDIA', price: 495.22, change: 12.55, changePercent: 2.60 },
  AMZN: { name: 'Amazon', price: 178.25, change: 2.15, changePercent: 1.22 },
  META: { name: 'Meta Platforms', price: 505.35, change: -3.21, changePercent: -0.63 },
  TSLA: { name: 'Tesla', price: 248.50, change: 5.67, changePercent: 2.33 },
};

// Generate random sparkline data
const generateSparkline = (positive: boolean) => {
  const base = Math.random() * 50 + 50;
  const trend = positive ? 1 : -1;
  return Array.from({ length: 12 }, (_, i) => 
    Math.max(10, Math.min(100, base + (Math.random() - 0.5) * 20 + trend * i * 2))
  );
};

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { symbols = ['AAPL', 'GOOGL', 'MSFT', 'NVDA'] } = await req.json();
    
    // If no API key, return mock data
    if (!FINNHUB_API_KEY) {
      console.log('No FINNHUB_API_KEY configured, returning mock data');
      const mockResults = symbols.map((symbol: string) => {
        const stock = MOCK_STOCKS[symbol] || { 
          name: symbol, 
          price: 100 + Math.random() * 200, 
          change: (Math.random() - 0.5) * 10,
          changePercent: (Math.random() - 0.5) * 5
        };
        return {
          symbol,
          name: stock.name,
          price: stock.price,
          change: stock.change,
          changePercent: stock.changePercent,
          sparkline: generateSparkline(stock.change >= 0),
          open: parseFloat((stock.price - stock.change).toFixed(2)),
          high: parseFloat((stock.price * 1.012).toFixed(2)),
          low: parseFloat((stock.price * 0.991).toFixed(2)),
          prevClose: parseFloat((stock.price - stock.change).toFixed(2)),
          marketCap: null,
        };
      });

      return jsonResponse({
        stocks: mockResults,
        indices: [
          { label: 'S&P 500', price: 6284, changePercent: 0.6 },
          { label: 'Nasdaq', price: 20910, changePercent: 0.8 },
          { label: 'Dow', price: 44120, changePercent: -0.1 },
        ],
      });
    }

    // Fetch real data from Finnhub
    const stockPromises = symbols.map(async (symbol: string) => {
      try {
        const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`;
        const profileUrl = `https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${FINNHUB_API_KEY}`;
        
        const [quoteRes, profileRes] = await Promise.all([
          fetch(quoteUrl),
          fetch(profileUrl),
        ]);

        if (!quoteRes.ok) throw new Error(`Quote API error for ${symbol}`);
        
        const quote = await quoteRes.json();
        const profile = profileRes.ok ? await profileRes.json() : { name: symbol };
        
        const change = quote.c - quote.pc;
        const changePercent = ((quote.c - quote.pc) / quote.pc) * 100;

        return {
          symbol,
          name: profile.name || symbol,
          price: quote.c,
          change: parseFloat(change.toFixed(2)),
          changePercent: parseFloat(changePercent.toFixed(2)),
          sparkline: generateSparkline(change >= 0),
          // Extra fundamentals for the expanded stat grid (no extra API calls —
          // open/high/low/prevClose come from the quote, mktCap from profile2).
          open: quote.o ?? null,
          high: quote.h ?? null,
          low: quote.l ?? null,
          prevClose: quote.pc ?? null,
          marketCap: profile.marketCapitalization ? profile.marketCapitalization * 1e6 : null,
        };
      } catch (error) {
        console.error(`Error fetching ${symbol}:`, error);
        const mock = MOCK_STOCKS[symbol] || { name: symbol, price: 100, change: 0, changePercent: 0 };
        return {
          symbol,
          name: mock.name,
          price: mock.price,
          change: mock.change,
          changePercent: mock.changePercent,
          sparkline: generateSparkline(mock.change >= 0),
          open: parseFloat((mock.price - mock.change).toFixed(2)),
          high: parseFloat((mock.price * 1.012).toFixed(2)),
          low: parseFloat((mock.price * 0.991).toFixed(2)),
          prevClose: parseFloat((mock.price - mock.change).toFixed(2)),
          marketCap: null,
        };
      }
    });

    const stocks = await Promise.all(stockPromises);

    // Market indices via liquid ETF proxies (SPY→S&P 500, QQQ→Nasdaq, DIA→Dow).
    const INDEX_MAP = [
      { etf: 'SPY', label: 'S&P 500' },
      { etf: 'QQQ', label: 'Nasdaq' },
      { etf: 'DIA', label: 'Dow' },
    ];
    const MOCK_INDICES: Record<string, { price: number; changePercent: number }> = {
      'S&P 500': { price: 6284, changePercent: 0.6 },
      'Nasdaq': { price: 20910, changePercent: 0.8 },
      'Dow': { price: 44120, changePercent: -0.1 },
    };
    let indices: Array<{ label: string; price: number; changePercent: number }> = [];
    try {
      indices = await Promise.all(INDEX_MAP.map(async ({ etf, label }) => {
        try {
          const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${etf}&token=${FINNHUB_API_KEY}`);
          const q = r.ok ? await r.json() : null;
          // Finnhub returns c=0 on failure/rate-limit — fall back to mock so the
          // index panel never shows zeros.
          if (q && q.c > 0 && q.pc > 0) {
            return { label, price: q.c, changePercent: parseFloat((((q.c - q.pc) / q.pc) * 100).toFixed(2)) };
          }
        } catch { /* fall through to mock */ }
        return { label, ...MOCK_INDICES[label] };
      }));
    } catch (e) {
      console.error('Index fetch failed:', e);
      indices = INDEX_MAP.map(({ label }) => ({ label, ...MOCK_INDICES[label] }));
    }

    return jsonResponse({ stocks, indices });

  } catch (error: unknown) {
    console.error('Stocks function error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(message);
  }
});
