 import { useEffect, useRef, useState } from 'react';
 import { motion } from 'framer-motion';
 import { 
   Sparkles, Brain, Search, Globe, CheckCircle2, 
   ArrowRight, Zap, DollarSign, AlertTriangle 
 } from 'lucide-react';
 import mermaid from 'mermaid';

 // Static mermaid source. MODULE SCOPE on purpose: as a const inside the
 // component it is a fresh string every render, so naming it in the effect
 // deps would re-run mermaid.render() on every render instead of once.
 const routingDiagram = `
 %%{init: {'theme': 'dark', 'themeVariables': { 'primaryColor': '#a855f7' }}}%%
 flowchart LR
     A[Task] --> B{Task Type?}
     B -->|Planning| C[GPT-5]
     B -->|Execution| D[Gemini Flash]
     B -->|Research| E[Perplexity]
     B -->|Memory| F[Claude Opus]
     B -->|Creative| G[Claude Sonnet]
     
     style C fill:#4c1d95,stroke:#a855f7
     style D fill:#1e3a5f,stroke:#3b82f6
     style E fill:#164e63,stroke:#06b6d4
     style F fill:#7c2d12,stroke:#f97316
     style G fill:#4a1d4a,stroke:#d946ef
 `;

 const fallbackDiagram = `
 %%{init: {'theme': 'dark', 'themeVariables': { 'primaryColor': '#a855f7' }}}%%
 flowchart TB
     A[Request] --> B[Primary Provider]
     B -->|Success| C[Return Response]
     B -->|Failure/Rate Limit| D{Check Fallback}
     D -->|Available| E[Fallback Provider]
     D -->|None| F[Return Error]
     E -->|Success| C
     E -->|Failure| F
     
     style B fill:#4c1d95,stroke:#a855f7
     style E fill:#164e63,stroke:#06b6d4
     style C fill:#065f46,stroke:#10b981
     style F fill:#7f1d1d,stroke:#ef4444
 `;

 
 const AIProvidersSection = () => {
   const routingDiagramRef = useRef<HTMLDivElement>(null);
   const fallbackDiagramRef = useRef<HTMLDivElement>(null);
   const [routingRendered, setRoutingRendered] = useState(false);
   const [fallbackRendered, setFallbackRendered] = useState(false);
 
   const providers = [
     {
       name: 'Lovable AI Gateway',
       tier: 'Tier 1 & 2',
       icon: Sparkles,
       color: 'primary',
       description: 'Primary AI provider for planning, execution, and reasoning tasks.',
       models: [
         { name: 'GPT-5', role: 'Planner/Reasoner', cost: '$$$' },
         { name: 'Gemini 2.5 Flash', role: 'Worker/Execution', cost: '$' }
       ],
       useCases: ['Chat responses', 'Task planning', 'Code generation', 'General reasoning']
     },
     {
       name: 'Claude Opus 4.5',
       tier: 'Memory Core',
       icon: Brain,
       color: 'orange',
       description: 'Specialized for memory synthesis, consolidation, and deep reasoning.',
       models: [
         { name: 'Claude Opus 4.5', role: 'Memory Core', cost: '$$$$' },
         { name: 'Claude Sonnet 4.5', role: 'Critic/Creative', cost: '$$' }
       ],
       useCases: ['Memory synthesis', 'Conflict resolution', 'Insight extraction', 'Creative writing']
     },
     {
       name: 'Perplexity AI',
       tier: 'Tier 3',
       icon: Search,
       color: 'cyan',
       description: 'Web search and research with real-time citations and source verification.',
       models: [
         { name: 'sonar-pro', role: 'Deep Research', cost: '$$' },
         { name: 'sonar', role: 'Quick Search', cost: '$' }
       ],
       useCases: ['Web research', 'Fact verification', 'News analysis', 'Citation generation']
     },
     {
       name: 'Jina Reader',
       tier: 'Utility',
       icon: Globe,
       color: 'emerald',
       description: 'Web scraping and URL content extraction for knowledge gathering.',
       models: [
         { name: 'Reader API', role: 'Content Extraction', cost: 'Free' }
       ],
       useCases: ['URL scraping', 'Content parsing', 'Article extraction']
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
         if (routingDiagramRef.current) {
           const { svg: routingSvg } = await mermaid.render('routing-diagram', routingDiagram);
           routingDiagramRef.current.innerHTML = routingSvg;
           setRoutingRendered(true);
         }
       } catch (e) {
         console.error('Routing diagram error:', e);
       }
 
       try {
         if (fallbackDiagramRef.current) {
           const { svg: fallbackSvg } = await mermaid.render('fallback-diagram', fallbackDiagram);
           fallbackDiagramRef.current.innerHTML = fallbackSvg;
           setFallbackRendered(true);
         }
       } catch (e) {
         console.error('Fallback diagram error:', e);
       }
     };
 
     renderDiagrams();
   }, []);
 
   const colorClasses: Record<string, { bg: string; border: string; text: string }> = {
     primary: { bg: 'bg-primary/10', border: 'border-primary/30', text: 'text-primary' },
     orange: { bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-400' },
     cyan: { bg: 'bg-cyan-500/10', border: 'border-cyan-500/30', text: 'text-cyan-400' },
     emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400' },
   };
 
   return (
     <div className="space-y-8">
       {/* Provider Cards */}
       <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
         {providers.map((provider, index) => {
           const colors = colorClasses[provider.color];
           const Icon = provider.icon;
           
           return (
             <motion.div
               key={provider.name}
               className={`backdrop-blur-xl border rounded-2xl p-6 ${colors.bg} ${colors.border}`}
               initial={{ opacity: 0, y: 20 }}
               animate={{ opacity: 1, y: 0 }}
               transition={{ delay: index * 0.1 }}
             >
               <div className="flex items-start justify-between mb-4">
                 <div className="flex items-center gap-3">
                   <div className={`p-2 rounded-xl ${colors.bg} ${colors.text}`}>
                     <Icon className="w-5 h-5" />
                   </div>
                   <div>
                     <h4 className="font-semibold">{provider.name}</h4>
                     <span className={`text-xs ${colors.text}`}>{provider.tier}</span>
                   </div>
                 </div>
                 <CheckCircle2 className="w-5 h-5 text-green-500" />
               </div>
               
               <p className="text-sm text-muted-foreground mb-4">{provider.description}</p>
               
               <div className="space-y-3 mb-4">
                 <h5 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Models</h5>
                 {provider.models.map((model) => (
                   <div key={model.name} className="flex items-center justify-between text-sm">
                     <div className="flex items-center gap-2">
                       <ArrowRight className="w-3 h-3 text-muted-foreground" />
                       <span>{model.name}</span>
                       <span className="text-xs text-muted-foreground">({model.role})</span>
                     </div>
                     <span className="text-xs text-amber-400">{model.cost}</span>
                   </div>
                 ))}
               </div>
               
               <div className="flex flex-wrap gap-1">
                 {provider.useCases.map((useCase) => (
                   <span 
                     key={useCase} 
                     className="text-xs px-2 py-1 rounded-full bg-background/30 text-muted-foreground"
                   >
                     {useCase}
                   </span>
                 ))}
               </div>
             </motion.div>
           );
         })}
       </div>
 
       {/* Task Routing Diagram */}
       <motion.div
         className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-2xl p-6"
         initial={{ opacity: 0 }}
         animate={{ opacity: 1 }}
         transition={{ delay: 0.4 }}
       >
         <div className="flex items-center gap-2 mb-4">
           <Zap className="w-5 h-5 text-primary" />
           <h3 className="text-lg font-semibold">Task Routing Logic</h3>
         </div>
         <div className="overflow-x-auto rounded-xl border border-border/30 bg-background/20 p-4">
           <motion.div
             ref={routingDiagramRef}
             className="[&_svg]:max-w-full [&_svg]:h-auto"
             initial={{ opacity: 0 }}
             animate={{ opacity: routingRendered ? 1 : 0 }}
           />
         </div>
       </motion.div>
 
       {/* Fallback Chain */}
       <motion.div
         className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-2xl p-6"
         initial={{ opacity: 0 }}
         animate={{ opacity: 1 }}
         transition={{ delay: 0.5 }}
       >
         <div className="flex items-center gap-2 mb-4">
           <AlertTriangle className="w-5 h-5 text-amber-400" />
           <h3 className="text-lg font-semibold">Fallback Chain</h3>
         </div>
         <p className="text-sm text-muted-foreground mb-4">
           When a provider fails or hits rate limits, the system automatically falls back to alternative providers.
         </p>
         <div className="overflow-x-auto rounded-xl border border-border/30 bg-background/20 p-4">
           <motion.div
             ref={fallbackDiagramRef}
             className="[&_svg]:max-w-full [&_svg]:h-auto"
             initial={{ opacity: 0 }}
             animate={{ opacity: fallbackRendered ? 1 : 0 }}
           />
         </div>
       </motion.div>
 
       {/* Budget Routing */}
       <motion.div
         className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-2xl p-6"
         initial={{ opacity: 0 }}
         animate={{ opacity: 1 }}
         transition={{ delay: 0.6 }}
       >
         <div className="flex items-center gap-2 mb-4">
           <DollarSign className="w-5 h-5 text-emerald-400" />
           <h3 className="text-lg font-semibold">Budget-Aware Routing</h3>
         </div>
         <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
           <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
             <h4 className="font-medium text-emerald-400 mb-2">Normal Mode</h4>
             <p className="text-sm text-muted-foreground">Uses optimal models for each task. GPT-5 for planning, Gemini for execution.</p>
             <div className="mt-2 text-xs text-muted-foreground">0-70% budget used</div>
           </div>
           <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30">
             <h4 className="font-medium text-amber-400 mb-2">Budget Saving</h4>
             <p className="text-sm text-muted-foreground">Switches to cheaper models. Gemini Flash replaces GPT-5 where possible.</p>
             <div className="mt-2 text-xs text-muted-foreground">70-90% budget used</div>
           </div>
           <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30">
             <h4 className="font-medium text-red-400 mb-2">Critical Mode</h4>
             <p className="text-sm text-muted-foreground">Uses only essential, lowest-cost models. Background learning paused.</p>
             <div className="mt-2 text-xs text-muted-foreground">&gt;90% budget used</div>
           </div>
         </div>
       </motion.div>
     </div>
   );
 };
 
 export default AIProvidersSection;