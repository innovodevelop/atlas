 import { lazy, Suspense, useState } from 'react';
 import { motion } from 'framer-motion';
 import { Link } from 'react-router-dom';
 import { ArrowLeft, Network, Brain, Layers, GraduationCap, Sparkles, Zap } from 'lucide-react';
 import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
 import { AtlasSphereCanvas } from '@/components/atlas-ui/AtlasSphereCanvas';
 import ArchitectureOverview from '@/components/architecture/ArchitectureOverview';
 import AIProvidersSection from '@/components/architecture/AIProvidersSection';
 import MemoryArchitectureSection from '@/components/architecture/MemoryArchitectureSection';
 import LearningPipelineSection from '@/components/architecture/LearningPipelineSection';
 import SphereDocumentation from '@/components/architecture/SphereDocumentation';
 
 const AtlasArchitecture = () => {
   const [activeTab, setActiveTab] = useState('overview');
 
   const tabs = [
     { id: 'overview', label: 'Overview', icon: Network },
     { id: 'providers', label: 'AI Providers', icon: Brain },
     { id: 'memory', label: 'Memory', icon: Layers },
     { id: 'learning', label: 'Learning', icon: GraduationCap },
     { id: 'sphere', label: 'Sphere', icon: Sparkles },
   ];
 
   return (
     <div className="min-h-screen bg-background text-foreground">
       {/* Background gradient */}
       <div className="fixed inset-0 bg-gradient-to-br from-background via-background to-primary/5 pointer-events-none" />
       
       {/* Header */}
       <header className="sticky top-0 z-50 backdrop-blur-xl bg-background/80 border-b border-border/30">
         <div className="max-w-7xl mx-auto px-4 py-4">
           <div className="flex items-center justify-between">
             <div className="flex items-center gap-4">
               <Link 
                 to="/dashboard" 
                 className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
               >
                 <ArrowLeft className="w-4 h-4" />
                 <span className="text-sm">Dashboard</span>
               </Link>
               <div className="h-4 w-px bg-border/50" />
               <h1 className="text-lg font-semibold">Atlas Architecture</h1>
             </div>
             <Link 
               to="/atlas-core"
               className="text-sm text-muted-foreground hover:text-primary transition-colors"
             >
               View Atlas Core →
             </Link>
           </div>
         </div>
       </header>
 
       <main className="relative max-w-7xl mx-auto px-4 py-8">
         {/* Hero Section */}
         <motion.div 
           className="text-center mb-12"
           initial={{ opacity: 0, y: 20 }}
           animate={{ opacity: 1, y: 0 }}
         >
           <div className="flex items-center justify-center mb-6">
             <div className="w-32 h-32">
               {/* Reference art on a documentation page — there is no live
                   presence to read here, so "idle" is the honest resting state.
                   128 px, so the cloud runs at a third of the tuned count. */}
               <AtlasSphereCanvas state="idle" countScale={0.35} />
             </div>
           </div>
           <h2 className="text-3xl font-bold mb-4">
             Understanding Atlas Intelligence
           </h2>
           <p className="text-muted-foreground max-w-2xl mx-auto">
             A comprehensive guide to how Atlas works—from multi-model AI orchestration and 
             persistent memory systems to continuous learning and the live sphere.
           </p>
         </motion.div>
 
         {/* Tabs */}
         <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
           <TabsList className="w-full flex justify-center gap-1 mb-8 bg-muted/20 p-1 rounded-xl">
             {tabs.map((tab) => {
               const Icon = tab.icon;
               return (
                 <TabsTrigger
                   key={tab.id}
                   value={tab.id}
                   className="flex items-center gap-2 px-4 py-2 rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                 >
                   <Icon className="w-4 h-4" />
                   <span className="hidden sm:inline">{tab.label}</span>
                 </TabsTrigger>
               );
             })}
           </TabsList>
 
           <TabsContent value="overview">
             <ArchitectureOverview />
           </TabsContent>
 
           <TabsContent value="providers">
             <AIProvidersSection />
           </TabsContent>
 
           <TabsContent value="memory">
             <MemoryArchitectureSection />
           </TabsContent>
 
           <TabsContent value="learning">
             <LearningPipelineSection />
           </TabsContent>
 
           <TabsContent value="sphere">
             <SphereDocumentation />
           </TabsContent>
         </Tabs>
       </main>
 
       {/* Footer */}
       <footer className="border-t border-border/30 py-6 mt-12">
         <div className="max-w-7xl mx-auto px-4 text-center text-sm text-muted-foreground">
           <p>Atlas AI Architecture Documentation • Built with Lovable</p>
         </div>
       </footer>
     </div>
   );
 };
 
 export default AtlasArchitecture;