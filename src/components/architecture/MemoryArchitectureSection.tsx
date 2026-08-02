 import { useEffect, useRef, useState } from 'react';
 import { motion } from 'framer-motion';
 import { Database, Layers, Clock, Brain, Shield, Zap } from 'lucide-react';
 import mermaid from 'mermaid';

 // Static mermaid source. MODULE SCOPE on purpose: as a const inside the
 // component it is a fresh string every render, so naming it in the effect
 // deps would re-run mermaid.render() on every render instead of once.
 const tierDiagram = `
 %%{init: {'theme': 'dark'}}%%
 flowchart TB
     subgraph Conversation["Conversation Flow"]
         A[User Message] --> B[Extract Context]
     end
     
     subgraph Working["Working Memory (30 min)"]
         B --> C[session_context]
         C -->|Important| D{Promote?}
     end
     
     subgraph ShortTerm["Short-Term (24 hr)"]
         D -->|Yes| E[Temporary Storage]
         E -->|Repeated| F{Consolidate?}
     end
     
     subgraph LongTerm["Long-Term (Persistent)"]
         F -->|Yes| G[ai_memory]
         G --> H[Generate Embeddings]
         H --> I[memory_vectors]
     end
     
     subgraph Semantic["Semantic Core"]
         I --> J[Claude Opus]
         J --> K[Synthesized Themes]
     end
     
     style C fill:#164e63,stroke:#06b6d4
     style E fill:#1e3a5f,stroke:#3b82f6
     style G fill:#065f46,stroke:#10b981
     style I fill:#065f46,stroke:#10b981
     style K fill:#4c1d95,stroke:#a855f7
 `;

 const validationDiagram = `
 %%{init: {'theme': 'dark'}}%%
 flowchart LR
     A[New Knowledge] --> B[Validation Pipeline]
     B --> C[Claude Opus]
     B --> D[Gemini Pro]
     B --> E[Perplexity]
     C --> F{Consensus?}
     D --> F
     E --> F
     F -->|2+ Agree Valid| G[Store Knowledge]
     F -->|Suspicious| H[Flag for Review]
     F -->|Fake| I[Reject]
     
     style C fill:#7c2d12,stroke:#f97316
     style D fill:#4c1d95,stroke:#a855f7
     style E fill:#164e63,stroke:#06b6d4
     style G fill:#065f46,stroke:#10b981
     style H fill:#78350f,stroke:#f59e0b
     style I fill:#7f1d1d,stroke:#ef4444
 `;

 
 const MemoryArchitectureSection = () => {
   const tierDiagramRef = useRef<HTMLDivElement>(null);
   const validationDiagramRef = useRef<HTMLDivElement>(null);
   const [tierRendered, setTierRendered] = useState(false);
   const [validationRendered, setValidationRendered] = useState(false);
 
   const memoryTiers = [
     {
       name: 'Working Memory',
       table: 'session_context',
       expiry: '30 min',
       color: 'cyan',
       description: 'Tracks active conversation topics, emotional signals, and immediate context.',
       features: ['Current topics', 'Emotional signals', 'Entity references', 'Active goals']
     },
     {
       name: 'Short-Term Memory',
       table: 'Promoted from session',
       expiry: '24 hours',
       color: 'blue',
       description: 'Important session items promoted based on significance and repetition.',
       features: ['Key decisions', 'Important mentions', 'Action items', 'Temporary preferences']
     },
     {
       name: 'Long-Term Memory',
       table: 'ai_memory + vectors',
       expiry: 'Persistent',
       color: 'emerald',
       description: 'Permanent storage with semantic vector embeddings for intelligent retrieval.',
       features: ['User preferences', 'Learned facts', 'Relationships', 'Historical patterns']
     },
     {
       name: 'Semantic Core',
       table: 'Synthesized themes',
       expiry: 'Evolving',
       color: 'primary',
       description: 'Consolidated insights and synthesized understanding via Claude Opus.',
       features: ['Core beliefs', 'Personality model', 'Value system', 'Meta-knowledge']
     }
   ];
 
 
 
   useEffect(() => {
     const renderDiagrams = async () => {
       mermaid.initialize({
         startOnLoad: false,
         theme: 'dark',
         securityLevel: 'loose',
         fontFamily: 'Inter, system-ui, sans-serif',
       });
 
       try {
         if (tierDiagramRef.current) {
           const { svg } = await mermaid.render('tier-diagram', tierDiagram);
           tierDiagramRef.current.innerHTML = svg;
           setTierRendered(true);
         }
       } catch (e) {
         console.error('Tier diagram error:', e);
       }
 
       try {
         if (validationDiagramRef.current) {
           const { svg } = await mermaid.render('validation-diagram', validationDiagram);
           validationDiagramRef.current.innerHTML = svg;
           setValidationRendered(true);
         }
       } catch (e) {
         console.error('Validation diagram error:', e);
       }
     };
 
     renderDiagrams();
   }, []);
 
   const colorClasses: Record<string, { bg: string; border: string; text: string }> = {
     cyan: { bg: 'bg-cyan-500/10', border: 'border-cyan-500/30', text: 'text-cyan-400' },
     blue: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-400' },
     emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400' },
     primary: { bg: 'bg-primary/10', border: 'border-primary/30', text: 'text-primary' },
   };
 
   return (
     <div className="space-y-8">
       {/* Memory Tiers */}
       <div>
         <div className="flex items-center gap-2 mb-4">
           <Layers className="w-5 h-5 text-emerald-400" />
           <h3 className="text-lg font-semibold">Memory Tiers</h3>
         </div>
         
         <div className="space-y-4">
           {memoryTiers.map((tier, index) => {
             const colors = colorClasses[tier.color];
             return (
               <motion.div
                 key={tier.name}
                 className={`backdrop-blur-xl border rounded-2xl p-6 ${colors.bg} ${colors.border}`}
                 initial={{ opacity: 0, x: -20 }}
                 animate={{ opacity: 1, x: 0 }}
                 transition={{ delay: index * 0.1 }}
               >
                 <div className="flex items-start justify-between mb-3">
                   <div>
                     <h4 className="font-semibold">{tier.name}</h4>
                     <div className="flex items-center gap-3 mt-1">
                       <span className="text-xs text-muted-foreground flex items-center gap-1">
                         <Database className="w-3 h-3" />
                         {tier.table}
                       </span>
                       <span className="text-xs text-muted-foreground flex items-center gap-1">
                         <Clock className="w-3 h-3" />
                         {tier.expiry}
                       </span>
                     </div>
                   </div>
                   <div className={`px-3 py-1 rounded-full text-xs ${colors.bg} ${colors.text}`}>
                     Tier {index + 1}
                   </div>
                 </div>
                 
                 <p className="text-sm text-muted-foreground mb-4">{tier.description}</p>
                 
                 <div className="flex flex-wrap gap-2">
                   {tier.features.map((feature) => (
                     <span 
                       key={feature}
                       className="text-xs px-2 py-1 rounded-full bg-background/30"
                     >
                       {feature}
                     </span>
                   ))}
                 </div>
               </motion.div>
             );
           })}
         </div>
       </div>
 
       {/* Memory Flow Diagram */}
       <motion.div
         className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-2xl p-6"
         initial={{ opacity: 0 }}
         animate={{ opacity: 1 }}
         transition={{ delay: 0.4 }}
       >
         <div className="flex items-center gap-2 mb-4">
           <Brain className="w-5 h-5 text-primary" />
           <h3 className="text-lg font-semibold">Memory Flow</h3>
         </div>
         <div className="overflow-x-auto rounded-xl border border-border/30 bg-background/20 p-4">
           <motion.div
             ref={tierDiagramRef}
             className="[&_svg]:max-w-full [&_svg]:h-auto"
             initial={{ opacity: 0 }}
             animate={{ opacity: tierRendered ? 1 : 0 }}
           />
           {!tierRendered && (
             <div className="flex items-center justify-center h-64">
               <motion.div animate={{ rotate: 360 }} transition={{ duration: 2, repeat: Infinity }}>
                 <Zap className="w-8 h-8 text-primary" />
               </motion.div>
             </div>
           )}
         </div>
       </motion.div>
 
       {/* Validation Pipeline */}
       <motion.div
         className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-2xl p-6"
         initial={{ opacity: 0 }}
         animate={{ opacity: 1 }}
         transition={{ delay: 0.5 }}
       >
         <div className="flex items-center gap-2 mb-4">
           <Shield className="w-5 h-5 text-amber-400" />
           <h3 className="text-lg font-semibold">Knowledge Validation Pipeline</h3>
         </div>
         <p className="text-sm text-muted-foreground mb-4">
           All new knowledge is validated by multiple AI models. A consensus of 2+ models must agree 
           on validity before knowledge is stored. This prevents hallucinations and fake information.
         </p>
         <div className="overflow-x-auto rounded-xl border border-border/30 bg-background/20 p-4">
           <motion.div
             ref={validationDiagramRef}
             className="[&_svg]:max-w-full [&_svg]:h-auto"
             initial={{ opacity: 0 }}
             animate={{ opacity: validationRendered ? 1 : 0 }}
           />
         </div>
       </motion.div>
     </div>
   );
 };
 
 export default MemoryArchitectureSection;