import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { 
  Settings, 
  Bell, 
  Brain, 
  Search, 
  Zap, 
  Volume2, 
  VolumeX,
  Save,
  RotateCcw,
  Sliders,
  Target,
  Clock,
  DollarSign
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { LovableAIControlPanel } from './LovableAIControlPanel';
import { BudgetSettingsPanel } from './BudgetSettingsPanel';
import { VoiceSettingsPanel } from './VoiceSettingsPanel';

interface AtlasSettings {
  notifications: {
    enabled: boolean;
    soundEnabled: boolean;
    knowledgeAlerts: boolean;
    researchAlerts: boolean;
    learningAlerts: boolean;
  };
  learning: {
    autoLearn: boolean;
    depthLevel: number;
    priorityThreshold: number;
    maxConcurrentSessions: number;
  };
  research: {
    autoResearch: boolean;
    maxDepth: number;
    sourcePriority: ('web' | 'academic' | 'internal')[];
    confidenceThreshold: number;
  };
}

const defaultSettings: AtlasSettings = {
  notifications: {
    enabled: true,
    soundEnabled: false,
    knowledgeAlerts: true,
    researchAlerts: true,
    learningAlerts: true,
  },
  learning: {
    autoLearn: true,
    depthLevel: 2,
    priorityThreshold: 0.5,
    maxConcurrentSessions: 3,
  },
  research: {
    autoResearch: false,
    maxDepth: 3,
    sourcePriority: ['web', 'academic', 'internal'],
    confidenceThreshold: 0.7,
  },
};

const STORAGE_KEY = 'atlas-core-settings';

interface AtlasSettingsPanelProps {
  onClose?: () => void;
}

export const AtlasSettingsPanel = ({ onClose }: AtlasSettingsPanelProps) => {
  const [settings, setSettings] = useState<AtlasSettings>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
  });
  const [hasChanges, setHasChanges] = useState(false);

  const updateSettings = <K extends keyof AtlasSettings>(
    section: K,
    key: keyof AtlasSettings[K],
    value: AtlasSettings[K][keyof AtlasSettings[K]]
  ) => {
    setSettings(prev => ({
      ...prev,
      [section]: {
        ...prev[section],
        [key]: value,
      },
    }));
    setHasChanges(true);
  };

  const saveSettings = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    setHasChanges(false);
    toast({
      title: '✓ Settings Saved',
      description: 'Your Atlas Core preferences have been updated.',
    });
  };

  const resetSettings = () => {
    setSettings(defaultSettings);
    localStorage.removeItem(STORAGE_KEY);
    setHasChanges(false);
    toast({
      title: 'Settings Reset',
      description: 'All settings have been restored to defaults.',
    });
  };

  const toggleSourcePriority = (source: 'web' | 'academic' | 'internal') => {
    setSettings(prev => {
      const current = prev.research.sourcePriority;
      const newPriority = current.includes(source)
        ? current.filter(s => s !== source)
        : [...current, source];
      return {
        ...prev,
        research: {
          ...prev.research,
          sourcePriority: newPriority,
        },
      };
    });
    setHasChanges(true);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="backdrop-blur-xl bg-background/40 border border-border/30 rounded-2xl p-6 space-y-6"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-primary/20">
            <Settings className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Atlas Core Settings</h3>
            <p className="text-sm text-muted-foreground">Configure AI, budget, and preferences</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={resetSettings}>
            <RotateCcw className="w-4 h-4 mr-2" />
            Reset
          </Button>
          <Button size="sm" onClick={saveSettings} disabled={!hasChanges}>
            <Save className="w-4 h-4 mr-2" />
            Save
          </Button>
        </div>
      </div>

      {/* Tabs for Settings Categories */}
      <Tabs defaultValue="ai" className="w-full">
        <TabsList className="grid w-full grid-cols-5 mb-4">
          <TabsTrigger value="ai" className="gap-2">
            <Zap className="w-4 h-4" />
            <span className="hidden sm:inline">AI Control</span>
          </TabsTrigger>
          <TabsTrigger value="voice" className="gap-2">
            <Volume2 className="w-4 h-4" />
            <span className="hidden sm:inline">Voice</span>
          </TabsTrigger>
          <TabsTrigger value="budget" className="gap-2">
            <DollarSign className="w-4 h-4" />
            <span className="hidden sm:inline">Budget</span>
          </TabsTrigger>
          <TabsTrigger value="learning" className="gap-2">
            <Brain className="w-4 h-4" />
            <span className="hidden sm:inline">Learning</span>
          </TabsTrigger>
          <TabsTrigger value="notifications" className="gap-2">
            <Bell className="w-4 h-4" />
            <span className="hidden sm:inline">Alerts</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ai" className="mt-0">
          <LovableAIControlPanel />
        </TabsContent>

        <TabsContent value="voice" className="mt-0">
          <VoiceSettingsPanel />
        </TabsContent>

        <TabsContent value="budget" className="mt-0">
          <BudgetSettingsPanel />
        </TabsContent>

        <TabsContent value="learning" className="mt-0 space-y-4">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <h4 className="font-medium">Learning Preferences</h4>
          </div>
          
          <div className="grid gap-4 pl-6">
            <div className="flex items-center justify-between">
              <Label htmlFor="auto-learn">Auto-Learning Mode</Label>
              <Switch
                id="auto-learn"
                checked={settings.learning.autoLearn}
                onCheckedChange={(checked) => updateSettings('learning', 'autoLearn', checked)}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2">
                  <Target className="w-4 h-4" />
                  Learning Depth
                </Label>
                <span className="text-sm text-muted-foreground">Level {settings.learning.depthLevel}</span>
              </div>
              <Slider
                value={[settings.learning.depthLevel]}
                onValueChange={([value]) => updateSettings('learning', 'depthLevel', value)}
                min={1}
                max={5}
                step={1}
                className="w-full"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2">
                  <Sliders className="w-4 h-4" />
                  Priority Threshold
                </Label>
                <span className="text-sm text-muted-foreground">{Math.round(settings.learning.priorityThreshold * 100)}%</span>
              </div>
              <Slider
                value={[settings.learning.priorityThreshold * 100]}
                onValueChange={([value]) => updateSettings('learning', 'priorityThreshold', value / 100)}
                min={10}
                max={100}
                step={5}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="notifications" className="mt-0 space-y-4">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-amber-400" />
            <h4 className="font-medium">Notifications</h4>
          </div>
          
          <div className="grid gap-4 pl-6">
            <div className="flex items-center justify-between">
              <Label htmlFor="notifications-enabled">Enable Notifications</Label>
              <Switch
                id="notifications-enabled"
                checked={settings.notifications.enabled}
                onCheckedChange={(checked) => updateSettings('notifications', 'enabled', checked)}
              />
            </div>
            
            <div className="flex items-center justify-between">
              <Label htmlFor="sound-enabled" className="flex items-center gap-2">
                {settings.notifications.soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                Sound Alerts
              </Label>
              <Switch
                id="sound-enabled"
                checked={settings.notifications.soundEnabled}
                onCheckedChange={(checked) => updateSettings('notifications', 'soundEnabled', checked)}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Badge 
                variant={settings.notifications.knowledgeAlerts ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => updateSettings('notifications', 'knowledgeAlerts', !settings.notifications.knowledgeAlerts)}
              >
                <Brain className="w-3 h-3 mr-1" />
                Knowledge
              </Badge>
              <Badge 
                variant={settings.notifications.researchAlerts ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => updateSettings('notifications', 'researchAlerts', !settings.notifications.researchAlerts)}
              >
                <Search className="w-3 h-3 mr-1" />
                Research
              </Badge>
              <Badge 
                variant={settings.notifications.learningAlerts ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => updateSettings('notifications', 'learningAlerts', !settings.notifications.learningAlerts)}
              >
                <Zap className="w-3 h-3 mr-1" />
                Learning
              </Badge>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </motion.div>
  );
};

// Hook to access settings
export const useAtlasSettings2 = () => {
  const [settings, setSettings] = useState<AtlasSettings>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
  });

  useEffect(() => {
    const handleStorage = () => {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setSettings({ ...defaultSettings, ...JSON.parse(saved) });
      }
    };
    
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  return settings;
};
