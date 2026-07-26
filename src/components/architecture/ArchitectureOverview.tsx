 import { useEffect, useRef, useState } from 'react';
 import { motion } from 'framer-motion';
 import { Mic, Brain, Lightbulb, Sparkles, Zap, Network } from 'lucide-react';
 import mermaid from 'mermaid';
 import ConceptCard from './ConceptCard';
 import TechStackTable from './TechStackTable';
 
 const ArchitectureOverview = () => {
   const diagramRef = useRef<HTMLDivElement>(null);
   const [isRendered, setIsRendered] = useState(false);
 
   const systemDiagram = `
 %%{init: {'theme': 'dark', 'themeVariables': { 'primaryColor': '#a855f7', 'primaryTextColor': '#fff', 'lineColor': '#6b7280' }}}%%
 graph TB
     subgraph User["User Interface"]
         A[Voice Input / Text]
         B[3D Sphere Visualization]
     end

     subgraph Frontend["Frontend (React)"]
         C[useUnifiedChat]
         D[useRealtimeScribe]
         E[useStreamingTTS]
     end

     subgraph Sidecars["Local Sidecars (Bun)"]
         F[atlas-brain<br/>chat-with-memory]
         G[atlas-brain<br/>research + learning]
         H[voice-gateway<br/>TTS / STT]
     end

     subgraph AI["Model Providers"]
         I[Anthropic Claude]
         J[multilingual-e5-base<br/>on-device embeddings]
         K[ElevenLabs<br/>voice only]
     end

     subgraph Storage["Local SQLite"]
         L[(ai_memory)]
         M[(memory_vec)]
         N[(memory_fts)]
     end

     A --> C
     A --> D
     B --> C
     C --> F
     D --> H
     E --> H
     F --> G
     F --> I
     G --> I
     F --> J
     H --> K
     F --> L
     J --> M
     F --> N

     classDef user fill:#1e1b4b,stroke:#6366f1,stroke-width:2px
     classDef frontend fill:#1f2937,stroke:#6b7280,stroke-width:1px
     classDef sidecar fill:#1e3a5f,stroke:#3b82f6,stroke-width:2px
     classDef ai fill:#4c1d95,stroke:#a855f7,stroke-width:2px
     classDef storage fill:#1c1917,stroke:#78716c,stroke-width:1px

     class A,B user
     class C,D,E frontend
     class F,G,H sidecar
     class I,J,K ai
     class L,M,N storage
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
           flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis', padding: 15 },
         });
 
         const { svg } = await mermaid.render('system-overview-diagram', systemDiagram);
         diagramRef.current.innerHTML = svg;
         setIsRendered(true);
       } catch (e) {
         console.error('Mermaid error:', e);
       }
     };
 
     renderDiagram();
   }, []);
 
   const concepts = [
     {
       title: 'Voice-First Interaction',
       description: 'Natural speech interface with real-time transcription and synthesis.',
       icon: Mic,
       features: [
         'Real-time STT via ElevenLabs Scribe',
         'Wake word detection — custom "Hey Atlas"/"Atlas" openWakeWord models (stock "Hey Jarvis" until they ship)',
         'Streaming TTS responses',
         '6-state conversation flow'
       ],
       accentColor: 'cyan'
     },
     {
       title: 'Persistent Memory',
       description: 'Multi-tier memory system that learns and remembers across sessions.',
       icon: Brain,
       features: [
         '4-tier memory architecture',
         'Semantic vector embeddings',
         'Cross-session continuity',
         'Memory synthesis with Claude'
       ],
       accentColor: 'emerald'
     },
     {
       title: 'Proactive Intelligence',
       description: 'Background learning and research without user prompting.',
       icon: Lightbulb,
       features: [
         'Continuous news monitoring',
         'Automatic topic discovery',
         'Knowledge gap detection',
         'Multi-model validation'
       ],
       accentColor: 'amber'
     },
     {
       title: '3D Visualization',
       description: 'GPU-accelerated sphere that responds to AI state and audio.',
       icon: Sparkles,
       features: [
         'Custom GLSL shaders',
         'State-aware animations',
         'Audio reactivity',
         'Adaptive quality scaling'
       ],
       accentColor: 'primary'
     }
   ];
 
   return (
     <div className="space-y-8">
       {/* System Diagram */}
       <motion.div
         className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-2xl p-6"
         initial={{ opacity: 0, y: 20 }}
         animate={{ opacity: 1, y: 0 }}
       >
         <div className="flex items-center gap-2 mb-4">
           <Network className="w-5 h-5 text-primary" />
           <h3 className="text-lg font-semibold">System Architecture</h3>
         </div>
         
         <div className="relative overflow-hidden rounded-xl border border-border/30 bg-background/20 p-4 min-h-[400px]">
           <motion.div
             ref={diagramRef}
             className="w-full overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto"
             initial={{ opacity: 0 }}
             animate={{ opacity: isRendered ? 1 : 0 }}
             transition={{ duration: 0.5 }}
           />
           {!isRendered && (
             <div className="absolute inset-0 flex items-center justify-center">
               <motion.div animate={{ rotate: 360 }} transition={{ duration: 2, repeat: Infinity, ease: "linear" }}>
                 <Zap className="w-8 h-8 text-primary" />
               </motion.div>
             </div>
           )}
         </div>
       </motion.div>
 
       {/* Core Concepts */}
       <div>
         <h3 className="text-lg font-semibold mb-4">Core Concepts</h3>
         <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
           {concepts.map((concept, index) => (
             <ConceptCard key={concept.title} {...concept} delay={index * 0.1} />
           ))}
         </div>
       </div>
 
       {/* Tech Stack */}
       <div>
         <h3 className="text-lg font-semibold mb-4">Technology Stack</h3>
         <TechStackTable />
       </div>
     </div>
   );
 };
 
 export default ArchitectureOverview;