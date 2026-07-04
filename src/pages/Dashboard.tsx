import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { useAuth } from '@/hooks/useAuth';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useDashboardVoice } from '@/hooks/useDashboardVoice';
import { useUnifiedChat } from '@/hooks/useUnifiedChat';
import { useCardPriority } from '@/hooks/useCardPriority';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { AtlasInterface } from '@/components/dashboard/AtlasInterface';
import { MiniAICard } from '@/components/dashboard/MiniAICard';
import { ImmersiveCardShell } from '@/components/dashboard/ImmersiveCardShell';
import { MorphableCard } from '@/components/dashboard/MorphableCard';
import { CardErrorBoundary } from '@/components/dashboard/CardErrorBoundary';
import { EmailCard } from '@/components/dashboard/EmailCard';
import { CalendarCard } from '@/components/dashboard/CalendarCard';
import { WeatherCard } from '@/components/dashboard/WeatherCard';
import { StocksCard } from '@/components/dashboard/StocksCard';
import { TravelCard } from '@/components/dashboard/TravelCard';
import { DocumentsCard } from '@/components/dashboard/DocumentsCard';
import { NotesCard } from '@/components/dashboard/NotesCard';
import { TasksCard } from '@/components/dashboard/TasksCard';
import { NewsCard } from '@/components/dashboard/NewsCard';
import { ConversationDrawer } from '@/components/dashboard/ConversationDrawer';
import { 
  ExpandedNotesCard, 
  ExpandedTasksCard, 
  ExpandedCalendarCard,
  ExpandedWeatherCard,
  ExpandedStocksCard,
  ExpandedNewsCard,
  ExpandedEmailCard,
  ExpandedTravelCard,
  ExpandedDocumentsCard
} from '@/components/dashboard/expanded';
import {
  EmailAtmosphere,
  StocksAtmosphere,
  CalendarAtmosphere,
  TasksAtmosphere,
  NotesAtmosphere,
  NewsAtmosphere,
  DocumentsAtmosphere,
  TravelAtmosphere,
} from '@/components/dashboard/effects/CardAtmospheres';

// Card animation variants
const cardVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.95 },
  visible: (delay: number) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.4,
      delay: delay * 0.08,
      ease: [0.25, 0.46, 0.45, 0.94],
    },
  }),
  exit: { opacity: 0, scale: 0.9, transition: { duration: 0.2 } },
};

// Glow effect for focused cards
const getFocusedClasses = (cardName: string, focusedCards: string[], isSpeaking: boolean) => {
  const isFocused = focusedCards.includes(cardName);
  if (!isFocused) return '';
  return 'ring-2 ring-primary/60 ring-offset-2 ring-offset-background rounded-2xl shadow-[0_0_30px_rgba(99,102,241,0.4)]';
};

// Get dim classes for non-focused cards during speech
const getDimClasses = (cardName: string, focusedCards: string[], isSpeaking: boolean) => {
  if (!isSpeaking || focusedCards.length === 0) return '';
  if (focusedCards.includes(cardName)) return '';
  return 'opacity-40 scale-[0.98] blur-[1px]';
};

// Get card styles with order for grid positioning
const getCardStyles = (isEmpty: boolean, order: number) => {
  return {
    opacity: isEmpty ? 0.6 : 1,
    order: order,
  };
};

// Get glow color for each card type
const getGlowColor = (cardName: string) => {
  const colors: Record<string, string> = {
    notes: 'hsl(45, 93%, 47%, 0.2)',
    tasks: 'hsl(217, 91%, 60%, 0.2)',
    calendar: 'hsl(217, 91%, 60%, 0.2)',
    weather: 'hsl(38, 92%, 50%, 0.2)',
    stocks: 'hsl(160, 84%, 39%, 0.2)',
    news: 'hsl(263, 70%, 50%, 0.2)',
    email: 'hsl(350, 70%, 55%, 0.2)',
    documents: 'hsl(200, 70%, 50%, 0.2)',
    travel: 'hsl(280, 70%, 50%, 0.2)',
  };
  return colors[cardName] || 'hsl(var(--primary) / 0.15)';
};

// Get accent color for each card type
const getAccentColor = (cardName: string) => {
  const colors: Record<string, string> = {
    notes: 'hsl(45, 93%, 47%)',
    tasks: 'hsl(217, 91%, 60%)',
    calendar: 'hsl(217, 91%, 60%)',
    weather: 'hsl(38, 92%, 50%)',
    stocks: 'hsl(160, 84%, 39%)',
    news: 'hsl(263, 70%, 50%)',
    email: 'hsl(350, 70%, 55%)',
    documents: 'hsl(200, 70%, 50%)',
    travel: 'hsl(280, 70%, 50%)',
  };
  return colors[cardName] || 'hsl(var(--primary))';
};

// Get atmospheric background for each card type
const getCardAtmosphere = (cardName: string) => {
  switch (cardName) {
    case 'email': return <EmailAtmosphere />;
    case 'stocks': return <StocksAtmosphere />;
    case 'calendar': return <CalendarAtmosphere />;
    case 'tasks': return <TasksAtmosphere />;
    case 'notes': return <NotesAtmosphere />;
    case 'news': return <NewsAtmosphere />;
    case 'documents': return <DocumentsAtmosphere />;
    case 'travel': return <TravelAtmosphere />;
    default: return null;
  }
};

const Dashboard = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading, signOut } = useAuth();
  const { profile } = useUserProfile();
  const [isConversationOpen, setIsConversationOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [focusedCards, setFocusedCards] = useState<string[]>([]);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);

  // Card priority system
  const { sortedCards, cardMeta } = useCardPriority();

  // Handle multi-card focus callback
  const handleCardFocus = useCallback((cardIds: string[] | null) => {
    setFocusedCards(cardIds || []);
  }, []);

  // Sentence-streamed speech: useUnifiedChat emits sentences during the LLM
  // stream; useDashboardVoice consumes them. The ref breaks the circular
  // dependency between the two hooks.
  const speakSentenceRef = useRef<(sentence: string) => void>(() => {});
  const handleSpeakSentence = useCallback((sentence: string) => {
    speakSentenceRef.current(sentence);
  }, []);

  const { messages, aiState, setAiState, isLoading, sendMessage, clearMessages } = useUnifiedChat({
    enableMemory: true,
    onCardFocus: handleCardFocus,
    onSpeakSentence: handleSpeakSentence,
  });

  // Voice logic - extracted to hook
  const {
    voiceEnabled,
    isVoiceProcessing,
    isRecording,
    isPlaying,
    audioLevel,
    effectiveAtlasState,
    effectiveAiState,
    isWakeWordSupported,
    handleEnableVoice,
    handleVoicePress,
    handleVoiceRelease,
    handleManualActivate,
    stopCurrentAudio,
    speakSentence,
  } = useDashboardVoice({
    sendMessage,
    stopAudio: undefined,
    aiState,
    isLoading,
    setAiState,
  });

  useEffect(() => {
    speakSentenceRef.current = speakSentence;
  }, [speakSentence]);

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  // Is Atlas speaking with focused cards?
  const isSpeakingWithFocus = effectiveAiState === 'speaking' && focusedCards.length > 0;

  const handleSendMessage = useCallback(async () => {
    if (!inputValue.trim()) return;
    const message = inputValue;
    setInputValue('');
    await sendMessage(message);
  }, [inputValue, sendMessage]);

  const handleAssistantClick = useCallback(() => {
    setIsConversationOpen(true);
  }, []);

  const handleLogout = useCallback(async () => {
    await signOut();
    navigate('/auth');
  }, [signOut, navigate]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <motion.div
          className="w-12 h-12 rounded-full border-2 border-primary border-t-transparent"
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
        />
      </div>
    );
  }

  const userName = profile?.first_name || profile?.display_name;

  // Render expanded card content
  const renderExpandedContent = () => {
    switch (expandedCard) {
      case 'notes': return <ExpandedNotesCard />;
      case 'tasks': return <ExpandedTasksCard />;
      case 'calendar': return <ExpandedCalendarCard />;
      case 'weather': return <ExpandedWeatherCard />;
      case 'stocks': return <ExpandedStocksCard />;
      case 'news': return <ExpandedNewsCard />;
      case 'email': return <ExpandedEmailCard />;
      case 'documents': return <ExpandedDocumentsCard />;
      case 'travel': return <ExpandedTravelCard />;
      default: return null;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Ambient background effects */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <motion.div
          className="absolute top-0 left-1/4 w-[600px] h-[600px] rounded-full opacity-20"
          style={{
            background: 'radial-gradient(circle, hsl(var(--primary) / 0.3) 0%, transparent 70%)',
          }}
          animate={{
            x: [0, 100, 0],
            y: [0, 50, 0],
          }}
          transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute bottom-0 right-1/4 w-[500px] h-[500px] rounded-full opacity-20"
          style={{
            background: 'radial-gradient(circle, hsl(var(--accent) / 0.3) 0%, transparent 70%)',
          }}
          animate={{
            x: [0, -100, 0],
            y: [0, -50, 0],
          }}
          transition={{ duration: 25, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      <DashboardHeader 
        userName={userName}
        onLogoutClick={handleLogout}
        voiceEnabled={voiceEnabled}
        onEnableVoice={handleEnableVoice}
      />
      
      <main className="relative z-10 w-full px-4 sm:px-6 lg:px-8 py-6">
        {/* Mosaic Grid Layout */}
        <AnimatePresence mode="wait">
          {!expandedCard ? (
        <LayoutGroup>
        <div 
          className="grid gap-5 w-full"
          style={{
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gridAutoRows: 'minmax(140px, auto)',
            gridAutoFlow: 'dense',
          }}
        >
          {/* Atlas AI Interface */}
          <motion.div 
            layoutId="card-assistant"
            className={`md:col-span-2 xl:col-span-2 h-[200px] transition-all duration-300 ${getFocusedClasses('assistant', focusedCards, isSpeakingWithFocus)}`}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            custom={0}
          >
            <AtlasInterface
              state={effectiveAtlasState}
              audioLevel={audioLevel}
              isSupported={isWakeWordSupported}
              voiceEnabled={voiceEnabled}
              onManualActivate={handleManualActivate}
              onEnableVoice={handleEnableVoice}
            />
          </motion.div>

          {/* Weather */}
          <motion.div 
            layoutId="card-weather"
            className={`row-span-2 transition-all duration-300 ${getFocusedClasses('weather', focusedCards, isSpeakingWithFocus)} ${getDimClasses('weather', focusedCards, isSpeakingWithFocus)}`}
            style={getCardStyles(cardMeta['weather']?.isEmpty || false, sortedCards.indexOf('weather'))}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            custom={1}
          >
            <CardErrorBoundary cardName="Weather">
              <MorphableCard notch="bottom-right" notchSize={20} enabled={false}>
                <WeatherCard onExpand={() => setExpandedCard('weather')} />
              </MorphableCard>
            </CardErrorBoundary>
          </motion.div>

          {/* Travel */}
          <motion.div 
            layoutId="card-travel"
            className={`${cardMeta['travel']?.isEmpty ? 'row-span-1 h-[60px]' : 'row-span-2'} transition-all duration-300 ${getFocusedClasses('travel', focusedCards, isSpeakingWithFocus)} ${getDimClasses('travel', focusedCards, isSpeakingWithFocus)}`}
            style={getCardStyles(cardMeta['travel']?.isEmpty || false, sortedCards.indexOf('travel'))}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            custom={2}
          >
            <CardErrorBoundary cardName="Travel">
              <MorphableCard notch="bottom-left" notchSize={20} enabled={false}>
                <TravelCard onExpand={() => setExpandedCard('travel')} />
              </MorphableCard>
            </CardErrorBoundary>
          </motion.div>

          {/* Email */}
          <motion.div 
            layoutId="card-email"
            className={`row-span-3 transition-all duration-300 ${getFocusedClasses('email', focusedCards, isSpeakingWithFocus)} ${getDimClasses('email', focusedCards, isSpeakingWithFocus)}`}
            style={getCardStyles(cardMeta['email']?.isEmpty || false, sortedCards.indexOf('email'))}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            custom={3}
          >
            <CardErrorBoundary cardName="Email">
              <EmailCard onExpand={() => setExpandedCard('email')} />
            </CardErrorBoundary>
          </motion.div>

          {/* Calendar */}
          <motion.div 
            layoutId="card-calendar"
            className={`${cardMeta['calendar']?.isEmpty ? 'row-span-1 h-[60px]' : 'row-span-3'} transition-all duration-300 ${getFocusedClasses('calendar', focusedCards, isSpeakingWithFocus)} ${getDimClasses('calendar', focusedCards, isSpeakingWithFocus)}`}
            style={getCardStyles(cardMeta['calendar']?.isEmpty || false, sortedCards.indexOf('calendar'))}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            custom={4}
          >
            <CardErrorBoundary cardName="Calendar">
              <CalendarCard onExpand={() => setExpandedCard('calendar')} />
            </CardErrorBoundary>
          </motion.div>

          {/* Stocks */}
          <motion.div 
            layoutId="card-stocks"
            className={`md:col-span-2 xl:col-span-2 2xl:col-span-2 ${cardMeta['stocks']?.isEmpty ? 'row-span-1 h-[60px]' : 'row-span-2'} transition-all duration-300 ${getFocusedClasses('stocks', focusedCards, isSpeakingWithFocus)} ${getDimClasses('stocks', focusedCards, isSpeakingWithFocus)}`}
            style={getCardStyles(cardMeta['stocks']?.isEmpty || false, sortedCards.indexOf('stocks'))}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            custom={5}
          >
            <CardErrorBoundary cardName="Stocks">
              <MorphableCard notch="top-left" notchSize={12} enabled={false}>
                <StocksCard onExpand={() => setExpandedCard('stocks')} />
              </MorphableCard>
            </CardErrorBoundary>
          </motion.div>

          {/* Tasks */}
          <motion.div 
            layoutId="card-tasks"
            className={`${cardMeta['tasks']?.isEmpty ? 'row-span-1 h-[60px]' : 'row-span-2'} transition-all duration-300 ${getFocusedClasses('tasks', focusedCards, isSpeakingWithFocus)} ${getDimClasses('tasks', focusedCards, isSpeakingWithFocus)}`}
            style={getCardStyles(cardMeta['tasks']?.isEmpty || false, sortedCards.indexOf('tasks'))}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            custom={6}
          >
            <CardErrorBoundary cardName="Tasks">
              <TasksCard onExpand={() => setExpandedCard('tasks')} />
            </CardErrorBoundary>
          </motion.div>

          {/* Notes */}
          <motion.div 
            layoutId="card-notes"
            className={`${cardMeta['notes']?.isEmpty ? 'row-span-1 h-[60px]' : 'row-span-2'} transition-all duration-300 ${getFocusedClasses('notes', focusedCards, isSpeakingWithFocus)} ${getDimClasses('notes', focusedCards, isSpeakingWithFocus)}`}
            style={getCardStyles(cardMeta['notes']?.isEmpty || false, sortedCards.indexOf('notes'))}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            custom={7}
          >
            <CardErrorBoundary cardName="Notes">
              <NotesCard onExpand={() => setExpandedCard('notes')} />
            </CardErrorBoundary>
          </motion.div>

          {/* News */}
          <motion.div 
            layoutId="card-news"
            className={`md:col-span-2 xl:col-span-2 2xl:col-span-3 ${cardMeta['news']?.isEmpty ? 'row-span-1 h-[60px]' : 'row-span-2'} transition-all duration-300 ${getFocusedClasses('news', focusedCards, isSpeakingWithFocus)} ${getDimClasses('news', focusedCards, isSpeakingWithFocus)}`}
            style={getCardStyles(cardMeta['news']?.isEmpty || false, sortedCards.indexOf('news'))}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            custom={8}
          >
            <CardErrorBoundary cardName="News">
              <NewsCard onExpand={() => setExpandedCard('news')} />
            </CardErrorBoundary>
          </motion.div>

          {/* Documents */}
          <motion.div 
            layoutId="card-documents"
            className={`md:col-span-2 xl:col-span-2 2xl:col-span-2 ${cardMeta['documents']?.isEmpty ? 'row-span-1 h-[60px]' : 'row-span-2'} transition-all duration-300 ${getFocusedClasses('documents', focusedCards, isSpeakingWithFocus)} ${getDimClasses('documents', focusedCards, isSpeakingWithFocus)}`}
            style={getCardStyles(cardMeta['documents']?.isEmpty || false, sortedCards.indexOf('documents'))}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            custom={9}
          >
            <CardErrorBoundary cardName="Documents">
              <MorphableCard notch="top-right" notchSize={10} enabled={false}>
                <DocumentsCard onExpand={() => setExpandedCard('documents')} />
              </MorphableCard>
            </CardErrorBoundary>
          </motion.div>
        </div>
        </LayoutGroup>
          ) : (
            <ImmersiveCardShell 
              layoutId={`card-${expandedCard}`}
              onClose={() => setExpandedCard(null)}
              title={expandedCard.charAt(0).toUpperCase() + expandedCard.slice(1)}
              glowColor={getGlowColor(expandedCard)}
              accentColor={getAccentColor(expandedCard)}
              backgroundElement={getCardAtmosphere(expandedCard)}
              enableParallax={true}
              showHUD={true}
            >
              {renderExpandedContent()}
            </ImmersiveCardShell>
          )}
        </AnimatePresence>

        {/* Mini AI Card when a card is expanded */}
        <AnimatePresence>
          {expandedCard && (
            <MiniAICard
              state={effectiveAiState}
              audioLevel={audioLevel}
              isRecording={isRecording}
              isProcessing={isVoiceProcessing || isLoading}
              onVoicePress={handleVoicePress}
              onVoiceRelease={handleVoiceRelease}
              onClick={handleAssistantClick}
            />
          )}
        </AnimatePresence>
      </main>

      {/* Conversation Drawer */}
      <AnimatePresence>
        {isConversationOpen && (
          <ConversationDrawer
            isOpen={isConversationOpen}
            onClose={() => setIsConversationOpen(false)}
            messages={messages}
            inputValue={inputValue}
            onInputChange={setInputValue}
            onSend={handleSendMessage}
            isLoading={isLoading}
            aiState={effectiveAiState}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default Dashboard;
