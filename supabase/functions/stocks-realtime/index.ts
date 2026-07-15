import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const FINNHUB_API_KEY = Deno.env.get('FINNHUB_API_KEY');

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Check for WebSocket upgrade
  const { headers } = req;
  const upgradeHeader = headers.get('upgrade') || '';

  if (upgradeHeader.toLowerCase() !== 'websocket') {
    // Return info for non-WebSocket requests
    return new Response(
      JSON.stringify({ 
        message: 'Stocks Realtime WebSocket Endpoint',
        usage: 'Connect via WebSocket for real-time stock updates',
      }),
      { 
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const { socket, response } = Deno.upgradeWebSocket(req);
    
    let finnhubSocket: WebSocket | null = null;
    const subscribedSymbols: Set<string> = new Set();

    socket.onopen = () => {
      console.log('Client connected');
      
      // Connect to Finnhub WebSocket
      if (FINNHUB_API_KEY) {
        finnhubSocket = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`);
        
        finnhubSocket.onopen = () => {
          console.log('Connected to Finnhub');
          socket.send(JSON.stringify({ type: 'connected', message: 'Connected to real-time feed' }));
          
          // Subscribe to any pending symbols
          subscribedSymbols.forEach(symbol => {
            finnhubSocket?.send(JSON.stringify({ type: 'subscribe', symbol }));
          });
        };
        
        finnhubSocket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            // Forward trade data to client
            if (data.type === 'trade' && data.data) {
              socket.send(JSON.stringify({
                type: 'trade',
                data: data.data.map((trade: any) => ({
                  s: trade.s,  // symbol
                  p: trade.p,  // price
                  v: trade.v,  // volume
                  t: trade.t,  // timestamp
                })),
              }));
            }
          } catch (err) {
            console.error('Error parsing Finnhub message:', err);
          }
        };
        
        finnhubSocket.onerror = (error) => {
          console.error('Finnhub WebSocket error:', error);
          socket.send(JSON.stringify({ type: 'error', message: 'Real-time feed error' }));
        };
        
        finnhubSocket.onclose = () => {
          console.log('Finnhub connection closed');
        };
      } else {
        socket.send(JSON.stringify({ 
          type: 'error', 
          message: 'Real-time feed not configured' 
        }));
      }
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
        if (message.type === 'subscribe' && message.symbols) {
          // Subscribe to symbols
          const symbols = Array.isArray(message.symbols) ? message.symbols : [message.symbols];
          
          symbols.forEach((symbol: string) => {
            subscribedSymbols.add(symbol.toUpperCase());
            
            if (finnhubSocket?.readyState === WebSocket.OPEN) {
              finnhubSocket.send(JSON.stringify({ type: 'subscribe', symbol: symbol.toUpperCase() }));
              console.log(`Subscribed to ${symbol}`);
            }
          });
        }
        
        if (message.type === 'unsubscribe' && message.symbols) {
          const symbols = Array.isArray(message.symbols) ? message.symbols : [message.symbols];
          
          symbols.forEach((symbol: string) => {
            subscribedSymbols.delete(symbol.toUpperCase());
            
            if (finnhubSocket?.readyState === WebSocket.OPEN) {
              finnhubSocket.send(JSON.stringify({ type: 'unsubscribe', symbol: symbol.toUpperCase() }));
              console.log(`Unsubscribed from ${symbol}`);
            }
          });
        }
      } catch (err) {
        console.error('Error handling client message:', err);
      }
    };

    socket.onclose = () => {
      console.log('Client disconnected');
      
      // Unsubscribe from all symbols
      if (finnhubSocket?.readyState === WebSocket.OPEN) {
        subscribedSymbols.forEach(symbol => {
          finnhubSocket?.send(JSON.stringify({ type: 'unsubscribe', symbol }));
        });
        finnhubSocket.close();
      }
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    return response;
  } catch (err) {
    console.error('WebSocket upgrade error:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to upgrade connection' }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
