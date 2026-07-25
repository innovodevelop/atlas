import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  CheckCircle2,
  XCircle,
  Network,
  Cpu,
  Sparkles,
  Zap,
  Brain,
  Database
} from 'lucide-react';
import mermaid from 'mermaid';

interface ProviderStatus {
  name: string;
  connected: boolean;
  icon: React.ReactNode;
  description: string;
  models: string[];
  tier: string;
}

const AIArchitectureDiagram = () => {
  const diagramRef = useRef<HTMLDivElement>(null);
  const [isRendered, setIsRendered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Provider status based on typical configuration
  const providers: ProviderStatus[] = [
    {
      name: 'Anthropic Claude',
      connected: true, // The only remote reasoning provider Atlas talks to
      icon: <Brain className="w-4 h-4" />,
      description: 'The only remote model provider — reasoning, chat, synthesis',
      models: ['claude-opus (hard)', 'claude-sonnet (standard)', 'claude-haiku (cheap)'],
      tier: 'Reasoning'
    },
    {
      name: 'Local Embeddings',
      connected: true, // Bundled with the brain sidecar, no key needed
      icon: <Cpu className="w-4 h-4" />,
      description: 'On-device multilingual-e5-base ONNX — text never leaves the Mac',
      models: ['multilingual-e5-base (768d, int8)'],
      tier: 'On-device'
    },
    {
      name: 'Local Recall',
      connected: true, // SQLite ships with the app
      icon: <Database className="w-4 h-4" />,
      description: 'SQLite memory store with sqlite-vec KNN + FTS5 keyword search',
      models: ['sqlite-vec (vec0)', 'FTS5'],
      tier: 'On-device'
    },
    {
      name: 'ElevenLabs',
      connected: true, // Key lives in the macOS Keychain
      icon: <Sparkles className="w-4 h-4" />,
      description: 'Voice only — TTS and Scribe STT via the local voice gateway',
      models: ['Scribe (STT)', 'TTS'],
      tier: 'Voice'
    }
  ];

  const diagramDefinition = `
%%{init: {'theme': 'dark', 'themeVariables': { 'primaryColor': '#a855f7', 'primaryTextColor': '#fff', 'primaryBorderColor': '#a855f7', 'lineColor': '#6b7280', 'secondaryColor': '#1f2937', 'tertiaryColor': '#111827' }}}%%
graph TB
    subgraph Frontend["Frontend (React webview)"]
        A[User Request]
        B[useUnifiedChat Hook]
    end

    subgraph Core["Tauri Core (Rust)"]
        C["brainClient<br/>atlas_brain_info"]
        D["Keychain<br/>API keys"]
    end

    subgraph Brain["Atlas Brain (Bun sidecar, local)"]
        E["/chat-with-memory"]
        F["orchestrator"]
        G["claudeAdapter"]
        H["localEmbed<br/>on-device"]
    end

    subgraph Reasoning["Reasoning (Anthropic Claude)"]
        I["claude-opus<br/>hard tier"]
        J["claude-sonnet<br/>standard tier"]
        K["claude-haiku<br/>cheap tier"]
    end

    subgraph Local["On-device models"]
        L["multilingual-e5-base<br/>embeddings"]
    end

    subgraph Memory["Memory Storage (local SQLite)"]
        M["ai_memory"]
        N["memory_vec<br/>sqlite-vec KNN"]
        O["memory_fts<br/>FTS5"]
    end

    A --> B
    B --> C
    C --> E
    E --> F
    F --> G
    F --> H
    D --> G
    G --> I
    G --> J
    G --> K
    H --> L
    F --> M
    H --> N
    F --> O

    classDef frontend fill:#1e1b4b,stroke:#6366f1,stroke-width:2px
    classDef core fill:#1f2937,stroke:#6b7280,stroke-width:1px
    classDef brain fill:#7c2d12,stroke:#f97316,stroke-width:2px
    classDef reasoning fill:#4c1d95,stroke:#a855f7,stroke-width:2px
    classDef local fill:#164e63,stroke:#06b6d4,stroke-width:2px
    classDef storage fill:#1c1917,stroke:#78716c,stroke-width:1px

    class A,B frontend
    class C,D core
    class E,F,G,H brain
    class I,J,K reasoning
    class L local
    class M,N,O storage
`;

  useEffect(() => {
    const renderDiagram = async () => {
      if (!diagramRef.current) return;

      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'loose',
          fontFamily: 'Inter, system-ui, sans-serif',
          flowchart: {
            useMaxWidth: true,
            htmlLabels: true,
            curve: 'basis',
            padding: 15,
          },
          themeVariables: {
            primaryColor: '#a855f7',
            primaryTextColor: '#ffffff',
            primaryBorderColor: '#a855f7',
            lineColor: '#6b7280',
            secondaryColor: '#1f2937',
            tertiaryColor: '#111827',
            background: '#0a0a0a',
            mainBkg: '#1f2937',
            nodeBorder: '#a855f7',
          }
        });

        const { svg } = await mermaid.render('ai-architecture-diagram', diagramDefinition);
        diagramRef.current.innerHTML = svg;
        setIsRendered(true);
        setError(null);
      } catch (e) {
        console.error('Mermaid rendering error:', e);
        setError('Failed to render diagram');
      }
    };

    renderDiagram();
  }, []);

  return (
    <motion.div
      className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-2xl p-6"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Network className="w-5 h-5 text-primary" />
          AI Provider Architecture
        </h3>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Cpu className="w-4 h-4" />
          Multi-Model Orchestration
        </div>
      </div>

      {/* Provider Status Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {providers.map((provider, index) => (
          <motion.div
            key={provider.name}
            className={`relative p-4 rounded-xl border backdrop-blur-sm transition-all ${
              provider.connected 
                ? provider.tier === 'Reasoning'
                  ? 'bg-orange-500/10 border-orange-500/30 hover:border-orange-500/50'
                  : 'bg-primary/5 border-primary/30 hover:border-primary/50' 
                : 'bg-muted/20 border-border/30'
            }`}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: index * 0.1 }}
            whileHover={{ scale: 1.02 }}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className={`p-1.5 rounded-lg ${
                  provider.tier === 'Reasoning' 
                    ? 'bg-orange-500/20 text-orange-500'
                    : provider.connected ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                }`}>
                  {provider.icon}
                </div>
                <span className={`text-xs font-medium ${
                  provider.tier === 'Reasoning' ? 'text-orange-400' : 'text-muted-foreground'
                }`}>{provider.tier}</span>
              </div>
              {provider.connected ? (
                <CheckCircle2 className="w-4 h-4 text-green-500" />
              ) : (
                <XCircle className="w-4 h-4 text-muted-foreground" />
              )}
            </div>
            <h4 className="font-medium text-sm mb-1 truncate">{provider.name}</h4>
            <p className="text-xs text-muted-foreground line-clamp-2">{provider.description}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {provider.models.slice(0, 2).map((model) => (
                <span 
                  key={model} 
                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-background/50 text-muted-foreground truncate max-w-full"
                >
                  {model.split(' ')[0]}
                </span>
              ))}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Mermaid Diagram */}
      <div className="relative overflow-hidden rounded-xl border border-border/30 bg-background/20 p-4">
        {error ? (
          <div className="flex items-center justify-center h-64 text-muted-foreground">
            <p>{error}</p>
          </div>
        ) : (
          <motion.div
            ref={diagramRef}
            className="w-full overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto [&_.node_rect]:rx-8 [&_.node_rect]:ry-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: isRendered ? 1 : 0 }}
            transition={{ duration: 0.5 }}
          />
        )}
        
        {!isRendered && !error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
            >
              <Zap className="w-8 h-8 text-primary" />
            </motion.div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="mt-4 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-orange-500/50 border border-orange-500" />
          <span>Brain sidecar (local Bun process)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-primary/50 border border-primary" />
          <span>Reasoning: Anthropic Claude (only remote model)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-cyan-500/50 border border-cyan-500" />
          <span>On-device: multilingual-e5-base embeddings</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-stone-500/50 border border-stone-500" />
          <span>Storage: local SQLite (sqlite-vec + FTS5)</span>
        </div>
      </div>
    </motion.div>
  );
};

export default AIArchitectureDiagram;
