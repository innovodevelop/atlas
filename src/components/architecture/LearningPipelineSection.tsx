 import { useEffect, useRef, useState } from 'react';
 import { motion } from 'framer-motion';
 import { 
   Newspaper, Lightbulb, Search, Shield, Database, 
   Clock, Brain, Zap, RefreshCw 
 } from 'lucide-react';
 import mermaid from 'mermaid';

 // Static mermaid source. MODULE SCOPE on purpose: as a const inside the
 // component it is a fresh string every render, so naming it in the effect
 // deps would re-run mermaid.render() on every render instead of once.
 const pipelineDiagram = `
 %%{init: {'theme': 'dark'}}%%
 flowchart TB
     subgraph Collection["Phase 1: Collection"]
         A[News Pulse] --> B[Raw News]
         C[Topic Discovery] --> D[Knowledge Gaps]
         E[User Conversations] --> F[Extracted Topics]
     end
     
     subgraph Queue["Research Queue"]
         B --> G[Priority Scoring]
         D --> G
         F --> G
         G --> H[(Research Queue)]
     end
     
     subgraph Research["Phase 2: Parallel Research"]
         H --> I[Worker 1]
         H --> J[Worker 2]
         H --> K[Worker 3]
         I --> L[Findings]
         J --> L
         K --> L
     end
     
     subgraph Validation["Phase 3: Validation"]
         L --> M[Claude Opus]
         L --> N[Gemini Pro]
         L --> O[Perplexity]
         M --> P{Consensus}
         N --> P
         O --> P
     end
     
     subgraph Storage["Phase 4: Storage"]
         P -->|Valid| Q[Generate Embeddings]
         Q --> R[(atlas_knowledge)]
         Q --> S[(memory_vectors)]
     end
     
     style A fill:#164e63,stroke:#06b6d4
     style C fill:#78350f,stroke:#f59e0b
     style M fill:#7c2d12,stroke:#f97316
     style N fill:#4c1d95,stroke:#a855f7
     style O fill:#164e63,stroke:#06b6d4
     style R fill:#065f46,stroke:#10b981
     style S fill:#065f46,stroke:#10b981
 `;

 
 const LearningPipelineSection = () => {
   const pipelineDiagramRef = useRef<HTMLDivElement>(null);
   const [pipelineRendered, setPipelineRendered] = useState(false);
 
   const scheduledJobs = [
     { name: 'News Pulse', interval: 'Every 15 min', icon: Newspaper, color: 'cyan', description: 'Fetches breaking news and trending topics' },
     { name: 'Brain Orchestrator', interval: 'Every 30 min', icon: Brain, color: 'primary', description: 'Coordinates all learning activities' },
     { name: 'Topic Discovery', interval: 'Every 1 hour', icon: Lightbulb, color: 'amber', description: 'Identifies knowledge gaps and new topics' },
     { name: 'Batch Validation', interval: 'Every 2 hours', icon: Shield, color: 'emerald', description: 'Validates pending knowledge entries' },
     { name: 'Memory Consolidation', interval: 'Every 6 hours', icon: Database, color: 'blue', description: 'Consolidates and deduplicates memory' },
     { name: 'Full Synthesis', interval: 'Daily 2 AM', icon: RefreshCw, color: 'orange', description: 'Deep synthesis via Claude Opus' },
   ];
 
   const pipelineStages = [
     {
       name: 'Collection',
       description: 'News Pulse and Topic Discovery gather raw information from multiple sources.',
       sources: ['NewsAPI', 'Perplexity Trending', 'User Conversations', 'Web Search']
     },
     {
       name: 'Research',
       description: 'Topics are queued and processed in parallel with priority scoring.',
       features: ['Priority Queue', 'Parallel Processing', 'Depth Control', 'Source Tracking']
     },
     {
       name: 'Validation',
       description: 'Multi-model consensus ensures accuracy before storage.',
       validators: ['Claude Opus', 'Gemini Pro', 'Perplexity']
     },
     {
       name: 'Storage',
       description: 'Validated knowledge is embedded and stored with full audit trail.',
       outputs: ['Knowledge Entries', 'Vector Embeddings', 'Audit Logs']
     }
   ];
 
 
   useEffect(() => {
     const renderDiagram = async () => {
       if (!pipelineDiagramRef.current) return;
 
       mermaid.initialize({
         startOnLoad: false,
         theme: 'dark',
         securityLevel: 'loose',
         fontFamily: 'Inter, system-ui, sans-serif',
       });
 
       try {
         const { svg } = await mermaid.render('pipeline-diagram', pipelineDiagram);
         pipelineDiagramRef.current.innerHTML = svg;
         setPipelineRendered(true);
       } catch (e) {
         console.error('Pipeline diagram error:', e);
       }
     };
 
     renderDiagram();
   }, []);
 
   const colorClasses: Record<string, { bg: string; border: string; text: string }> = {
     cyan: { bg: 'bg-cyan-500/10', border: 'border-cyan-500/30', text: 'text-cyan-400' },
     primary: { bg: 'bg-primary/10', border: 'border-primary/30', text: 'text-primary' },
     amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-400' },
     emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400' },
     blue: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-400' },
     orange: { bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-400' },
   };
 
   return (
     <div className="space-y-8">
       {/* Scheduled Jobs Timeline */}
       <div>
         <div className="flex items-center gap-2 mb-4">
           <Clock className="w-5 h-5 text-amber-400" />
           <h3 className="text-lg font-semibold">Scheduled Learning Jobs</h3>
         </div>
         <p className="text-sm text-muted-foreground mb-4">
           Atlas runs continuous background processes to learn and validate knowledge without user intervention.
         </p>
         
         <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
           {scheduledJobs.map((job, index) => {
             const colors = colorClasses[job.color];
             const Icon = job.icon;
             
             return (
               <motion.div
                 key={job.name}
                 className={`backdrop-blur-xl border rounded-xl p-4 ${colors.bg} ${colors.border}`}
                 initial={{ opacity: 0, scale: 0.9 }}
                 animate={{ opacity: 1, scale: 1 }}
                 transition={{ delay: index * 0.05 }}
               >
                 <div className="flex items-center gap-3 mb-2">
                   <div className={`p-2 rounded-lg ${colors.bg} ${colors.text}`}>
                     <Icon className="w-4 h-4" />
                   </div>
                   <div>
                     <h4 className="font-medium text-sm">{job.name}</h4>
                     <span className={`text-xs ${colors.text}`}>{job.interval}</span>
                   </div>
                 </div>
                 <p className="text-xs text-muted-foreground">{job.description}</p>
               </motion.div>
             );
           })}
         </div>
       </div>
 
       {/* Pipeline Diagram */}
       <motion.div
         className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-2xl p-6"
         initial={{ opacity: 0 }}
         animate={{ opacity: 1 }}
         transition={{ delay: 0.3 }}
       >
         <div className="flex items-center gap-2 mb-4">
           <Brain className="w-5 h-5 text-primary" />
           <h3 className="text-lg font-semibold">Learning Pipeline Flow</h3>
         </div>
         <div className="overflow-x-auto rounded-xl border border-border/30 bg-background/20 p-4">
           <motion.div
             ref={pipelineDiagramRef}
             className="[&_svg]:max-w-full [&_svg]:h-auto"
             initial={{ opacity: 0 }}
             animate={{ opacity: pipelineRendered ? 1 : 0 }}
           />
           {!pipelineRendered && (
             <div className="flex items-center justify-center h-64">
               <motion.div animate={{ rotate: 360 }} transition={{ duration: 2, repeat: Infinity }}>
                 <Zap className="w-8 h-8 text-primary" />
               </motion.div>
             </div>
           )}
         </div>
       </motion.div>
 
       {/* Pipeline Stages */}
       <div>
         <h3 className="text-lg font-semibold mb-4">Pipeline Stages</h3>
         <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
           {pipelineStages.map((stage, index) => (
             <motion.div
               key={stage.name}
               className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-xl p-4"
               initial={{ opacity: 0, y: 20 }}
               animate={{ opacity: 1, y: 0 }}
               transition={{ delay: index * 0.1 }}
             >
               <div className="flex items-center gap-2 mb-2">
                 <span className="w-6 h-6 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center">
                   {index + 1}
                 </span>
                 <h4 className="font-medium">{stage.name}</h4>
               </div>
               <p className="text-xs text-muted-foreground mb-3">{stage.description}</p>
               <div className="flex flex-wrap gap-1">
                 {(stage.sources || stage.features || stage.validators || stage.outputs)?.map((item) => (
                   <span 
                     key={item}
                     className="text-[10px] px-2 py-0.5 rounded-full bg-muted/30 text-muted-foreground"
                   >
                     {item}
                   </span>
                 ))}
               </div>
             </motion.div>
           ))}
         </div>
       </div>
 
       {/* Brain Orchestrator */}
       <motion.div
         className="backdrop-blur-xl bg-primary/5 border border-primary/30 rounded-2xl p-6"
         initial={{ opacity: 0 }}
         animate={{ opacity: 1 }}
         transition={{ delay: 0.5 }}
       >
         <div className="flex items-center gap-2 mb-4">
           <Brain className="w-5 h-5 text-primary" />
           <h3 className="text-lg font-semibold">Brain Orchestrator</h3>
           <span className="text-xs px-2 py-1 rounded-full bg-primary/20 text-primary">Every 30 min</span>
         </div>
         <p className="text-sm text-muted-foreground mb-4">
           The Brain Orchestrator is the master coordinator that runs every 30 minutes, executing 
           all learning phases in parallel and logging metrics to the audit trail.
         </p>
         <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
           {[
             { label: 'News Items', desc: 'Collected per run' },
             { label: 'Topics Discovered', desc: 'Knowledge gaps found' },
             { label: 'Research Completed', desc: 'Topics researched' },
             { label: 'Entries Validated', desc: 'Fact-checked items' }
           ].map((metric, index) => (
             <div key={metric.label} className="text-center">
               <div className="text-2xl font-bold text-primary">—</div>
               <div className="text-xs font-medium">{metric.label}</div>
               <div className="text-xs text-muted-foreground">{metric.desc}</div>
             </div>
           ))}
         </div>
       </motion.div>
     </div>
   );
 };
 
 export default LearningPipelineSection;