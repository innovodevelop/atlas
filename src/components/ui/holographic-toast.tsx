import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cva, type VariantProps } from "class-variance-authority";
import { X, Check, AlertTriangle, Info, Brain, Search, Lightbulb, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const toastVariants = cva(
  "relative flex items-start gap-3 p-4 rounded-xl overflow-hidden pointer-events-auto",
  {
    variants: {
      variant: {
        default: "",
        success: "",
        error: "",
        warning: "",
        info: "",
        knowledge: "",
        research: "",
        learning: "",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

const iconMap = {
  default: Info,
  success: Check,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
  knowledge: Brain,
  research: Search,
  learning: Lightbulb,
};

const glowColorMap = {
  default: "hsl(var(--primary))",
  success: "hsl(142, 76%, 36%)",
  error: "hsl(0, 84%, 60%)",
  warning: "hsl(38, 92%, 50%)",
  info: "hsl(217, 91%, 60%)",
  knowledge: "hsl(280, 80%, 60%)",
  research: "hsl(195, 100%, 50%)",
  learning: "hsl(48, 96%, 53%)",
};

const iconBgMap = {
  default: "bg-primary/20 text-primary",
  success: "bg-green-500/20 text-green-400",
  error: "bg-red-500/20 text-red-400",
  warning: "bg-amber-500/20 text-amber-400",
  info: "bg-blue-500/20 text-blue-400",
  knowledge: "bg-purple-500/20 text-purple-400",
  research: "bg-cyan-500/20 text-cyan-400",
  learning: "bg-yellow-500/20 text-yellow-400",
};

export interface HolographicToastProps extends VariantProps<typeof toastVariants> {
  id: string;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  onDismiss?: () => void;
  duration?: number;
}

export const HolographicToast = React.forwardRef<
  HTMLDivElement,
  HolographicToastProps
>(({ id, title, description, action, onDismiss, variant = "default", duration = 5000 }, ref) => {
  const safeVariant = (variant && variant in iconMap) ? variant : "default";
  const Icon = iconMap[safeVariant] || iconMap.default;
  const glowColor = glowColorMap[safeVariant] || glowColorMap.default;
  const iconBg = iconBgMap[safeVariant] || iconBgMap.default;
  
  const [progress, setProgress] = React.useState(100);
  // The bar running out used to be all that happened: nothing dismissed the
  // toast, so it sat on screen for the store's 1000 s removal delay.
  const dismissRef = React.useRef(onDismiss);
  dismissRef.current = onDismiss;
  
  React.useEffect(() => {
    if (duration <= 0) return;
    
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, 100 - (elapsed / duration) * 100);
      setProgress(remaining);
      
      if (remaining <= 0) {
        clearInterval(interval);
        dismissRef.current?.();
      }
    }, 50);
    
    return () => clearInterval(interval);
  }, [duration]);

  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, x: 100, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 100, scale: 0.9 }}
      transition={{ type: "spring", damping: 20, stiffness: 300 }}
      className={cn(toastVariants({ variant }))}
    >
      {/* Glass background */}
      <div className="absolute inset-0 bg-card/90 backdrop-blur-xl" />
      
      {/* Gradient border */}
      <div className="absolute inset-0 rounded-xl border border-border/50" />
      
      {/* Glow effect */}
      <motion.div
        className="absolute -inset-1 rounded-xl opacity-30 blur-xl"
        style={{ background: glowColor }}
        animate={{ opacity: [0.2, 0.35, 0.2] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
      />
      
      {/* HUD corner accents */}
      <div className="absolute top-0 left-0 w-4 h-4 border-l-2 border-t-2 border-primary/40 rounded-tl-xl" />
      <div className="absolute top-0 right-0 w-4 h-4 border-r-2 border-t-2 border-primary/40 rounded-tr-xl" />
      <div className="absolute bottom-0 left-0 w-4 h-4 border-l-2 border-b-2 border-primary/40 rounded-bl-xl" />
      <div className="absolute bottom-0 right-0 w-4 h-4 border-r-2 border-b-2 border-primary/40 rounded-br-xl" />
      
      {/* Progress bar */}
      {duration > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-border/30">
          <motion.div
            className="h-full"
            style={{ 
              background: `linear-gradient(90deg, ${glowColor}, transparent)`,
              width: `${progress}%` 
            }}
          />
        </div>
      )}
      
      {/* Content */}
      <div className="relative flex items-start gap-3 z-10">
        {/* Animated icon */}
        <motion.div
          className={cn("flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center", iconBg)}
          animate={{ 
            boxShadow: [
              `0 0 10px ${glowColor}40`,
              `0 0 20px ${glowColor}60`,
              `0 0 10px ${glowColor}40`
            ]
          }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          <Icon className="w-4 h-4" />
        </motion.div>
        
        {/* Text content */}
        <div className="flex-1 min-w-0">
          {title && (
            <p className="text-sm font-medium text-foreground">{title}</p>
          )}
          {description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{description}</p>
          )}
          {action && <div className="mt-2">{action}</div>}
        </div>
        
        {/* Close button */}
        {onDismiss && (
          <motion.button
            onClick={onDismiss}
            className="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
          >
            <X className="w-3.5 h-3.5" />
          </motion.button>
        )}
      </div>
    </motion.div>
  );
});

HolographicToast.displayName = "HolographicToast";
