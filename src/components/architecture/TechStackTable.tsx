 import { motion } from 'framer-motion';
 
 interface TechItem {
   category: string;
   technology: string;
   version?: string;
   purpose: string;
 }
 
 const TechStackTable = () => {
   const techStack: TechItem[] = [
     { category: 'Frontend', technology: 'React', version: '18', purpose: 'UI framework' },
     { category: 'Frontend', technology: 'TypeScript', purpose: 'Type safety' },
     { category: 'Frontend', technology: 'Vite', purpose: 'Build tool & dev server' },
     { category: 'Styling', technology: 'Tailwind CSS', purpose: 'Utility-first styling' },
     { category: 'Animation', technology: 'Framer Motion', purpose: 'Declarative animations' },
     // Three.js and React Three Fiber were removed with the WebGL sphere; the
     // only renderer now is src/lib/atlasSphere.ts on a 2D canvas.
     //
     // NOTE for whoever owns this page next: several rows BELOW are also stale —
     // Lovable Cloud, the Lovable AI Gateway and Perplexity are all gone from
     // the product (see CLAUDE.md). They were left alone because they are not
     // fallout from the sphere teardown.
     { category: 'Sphere', technology: 'Canvas 2D', purpose: 'Particle sphere/field renderer, no GPU context' },
     { category: 'Backend', technology: 'Lovable Cloud', purpose: 'Database, Auth, Edge Functions' },
     { category: 'AI/LLM', technology: 'Lovable AI Gateway', purpose: 'GPT-5, Gemini Flash access' },
     { category: 'AI/LLM', technology: 'Claude Opus 4.5', purpose: 'Memory synthesis' },
     { category: 'AI/LLM', technology: 'Perplexity', purpose: 'Web research with citations' },
     { category: 'Voice STT', technology: 'ElevenLabs Scribe', purpose: 'Real-time transcription' },
     { category: 'Voice TTS', technology: 'ElevenLabs TTS', purpose: 'Streaming speech synthesis' },
     { category: 'State', technology: 'TanStack Query', purpose: 'Server state management' },
   ];
 
   const groupedStack = techStack.reduce((acc, item) => {
     if (!acc[item.category]) acc[item.category] = [];
     acc[item.category].push(item);
     return acc;
   }, {} as Record<string, TechItem[]>);
 
   return (
     <motion.div
       className="backdrop-blur-xl bg-background/30 border border-border/30 rounded-2xl overflow-hidden"
       initial={{ opacity: 0, y: 20 }}
       animate={{ opacity: 1, y: 0 }}
       transition={{ duration: 0.4 }}
     >
       <div className="overflow-x-auto">
         <table className="w-full text-sm">
           <thead>
             <tr className="border-b border-border/30 bg-muted/20">
               <th className="text-left p-4 font-medium text-muted-foreground">Category</th>
               <th className="text-left p-4 font-medium text-muted-foreground">Technology</th>
               <th className="text-left p-4 font-medium text-muted-foreground">Purpose</th>
             </tr>
           </thead>
           <tbody>
             {Object.entries(groupedStack).map(([category, items], categoryIndex) => (
               items.map((item, itemIndex) => (
                 <motion.tr
                   key={`${category}-${item.technology}`}
                   className="border-b border-border/10 hover:bg-primary/5 transition-colors"
                   initial={{ opacity: 0, x: -20 }}
                   animate={{ opacity: 1, x: 0 }}
                   transition={{ delay: (categoryIndex * items.length + itemIndex) * 0.03 }}
                 >
                   <td className="p-4">
                     {itemIndex === 0 && (
                       <span className="px-2 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary">
                         {category}
                       </span>
                     )}
                   </td>
                   <td className="p-4 font-medium">
                     {item.technology}
                     {item.version && (
                       <span className="ml-2 text-xs text-muted-foreground">{item.version}</span>
                     )}
                   </td>
                   <td className="p-4 text-muted-foreground">{item.purpose}</td>
                 </motion.tr>
               ))
             ))}
           </tbody>
         </table>
       </div>
     </motion.div>
   );
 };
 
 export default TechStackTable;