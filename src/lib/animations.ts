import { Variants, Transition } from 'framer-motion';

// ============================================
// GLOBAL ANIMATION SYSTEM
// ============================================

// Spring configurations for different use cases
export const springs = {
  gentle: { type: 'spring', stiffness: 120, damping: 14 } as Transition,
  snappy: { type: 'spring', stiffness: 400, damping: 30 } as Transition,
  bouncy: { type: 'spring', stiffness: 300, damping: 10 } as Transition,
  smooth: { type: 'spring', stiffness: 200, damping: 25 } as Transition,
};

// ============================================
// CARD ANIMATIONS
// ============================================
export const cardAnimations = {
  hover: {
    scale: 1.02,
    y: -4,
    transition: springs.snappy,
  },
  tap: {
    scale: 0.98,
    transition: { duration: 0.1 },
  },
  glow: {
    boxShadow: '0 0 30px rgba(99, 102, 241, 0.4)',
  },
};

export const cardVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 30,
    scale: 0.95,
    filter: 'blur(10px)',
  },
  visible: (delay: number = 0) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    filter: 'blur(0px)',
    transition: {
      duration: 0.5,
      delay: delay * 0.08,
      ease: [0.25, 0.46, 0.45, 0.94],
    },
  }),
  exit: {
    opacity: 0,
    scale: 0.9,
    filter: 'blur(10px)',
    transition: { duration: 0.3 },
  },
};

// Card expand/collapse animation
export const expandCardVariants: Variants = {
  collapsed: {
    opacity: 0,
    scale: 0.8,
    y: 50,
    filter: 'blur(20px)',
  },
  expanded: {
    opacity: 1,
    scale: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: {
      type: 'spring',
      stiffness: 300,
      damping: 30,
      staggerChildren: 0.05,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: -20,
    filter: 'blur(10px)',
    transition: { duration: 0.2 },
  },
};

// ============================================
// LIST ITEM ANIMATIONS
// ============================================
export const listItemVariants: Variants = {
  hidden: {
    opacity: 0,
    x: -20,
    scale: 0.95,
  },
  visible: (delay: number = 0) => ({
    opacity: 1,
    x: 0,
    scale: 1,
    transition: {
      duration: 0.3,
      delay: delay * 0.05,
      ease: 'easeOut',
    },
  }),
  exit: {
    opacity: 0,
    x: 20,
    scale: 0.95,
    transition: { duration: 0.2 },
  },
  hover: {
    x: 4,
    backgroundColor: 'hsl(var(--accent) / 0.1)',
    transition: { duration: 0.2 },
  },
};

export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.1,
    },
  },
  exit: {
    opacity: 0,
    transition: {
      staggerChildren: 0.03,
      staggerDirection: -1,
    },
  },
};

// ============================================
// BUTTON ANIMATIONS
// ============================================
export const buttonAnimations = {
  hover: {
    scale: 1.05,
    transition: springs.snappy,
  },
  tap: {
    scale: 0.95,
    transition: { duration: 0.1 },
  },
  glow: {
    boxShadow: '0 0 20px rgba(99, 102, 241, 0.5)',
  },
};

export const iconButtonVariants: Variants = {
  idle: { scale: 1, rotate: 0 },
  hover: { scale: 1.1, rotate: 5 },
  tap: { scale: 0.9 },
};

// ============================================
// PAGE TRANSITIONS
// ============================================
export const pageVariants: Variants = {
  initial: {
    opacity: 0,
    y: 20,
    filter: 'blur(10px)',
  },
  animate: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: {
      duration: 0.4,
      ease: [0.25, 0.46, 0.45, 0.94],
      staggerChildren: 0.1,
    },
  },
  exit: {
    opacity: 0,
    y: -20,
    filter: 'blur(10px)',
    transition: { duration: 0.3 },
  },
};

// ============================================
// MODAL / OVERLAY ANIMATIONS
// ============================================
export const overlayVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.3 },
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.2 },
  },
};

export const modalVariants: Variants = {
  hidden: {
    opacity: 0,
    scale: 0.9,
    y: 20,
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: springs.smooth,
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 10,
    transition: { duration: 0.2 },
  },
};

// ============================================
// SPECIALIZED ANIMATIONS
// ============================================

// Success check animation (for task completion)
export const checkmarkVariants: Variants = {
  hidden: {
    pathLength: 0,
    opacity: 0,
  },
  visible: {
    pathLength: 1,
    opacity: 1,
    transition: {
      pathLength: { duration: 0.4, ease: 'easeOut' },
      opacity: { duration: 0.1 },
    },
  },
};

// Pulse animation for notifications
export const pulseVariants: Variants = {
  idle: { scale: 1, opacity: 1 },
  pulse: {
    scale: [1, 1.2, 1],
    opacity: [1, 0.7, 1],
    transition: {
      duration: 1,
      repeat: Infinity,
      ease: 'easeInOut',
    },
  },
};

// Float animation for subtle movement
export const floatVariants: Variants = {
  float: {
    y: [0, -8, 0],
    transition: {
      duration: 3,
      repeat: Infinity,
      ease: 'easeInOut',
    },
  },
};

// Shimmer loading effect
export const shimmerVariants: Variants = {
  shimmer: {
    backgroundPosition: ['200% 0', '-200% 0'],
    transition: {
      duration: 1.5,
      repeat: Infinity,
      ease: 'linear',
    },
  },
};

// Slide in from different directions
export const slideVariants = {
  left: {
    hidden: { x: -100, opacity: 0 },
    visible: { x: 0, opacity: 1, transition: springs.smooth },
    exit: { x: -100, opacity: 0 },
  },
  right: {
    hidden: { x: 100, opacity: 0 },
    visible: { x: 0, opacity: 1, transition: springs.smooth },
    exit: { x: 100, opacity: 0 },
  },
  up: {
    hidden: { y: 100, opacity: 0 },
    visible: { y: 0, opacity: 1, transition: springs.smooth },
    exit: { y: 100, opacity: 0 },
  },
  down: {
    hidden: { y: -100, opacity: 0 },
    visible: { y: 0, opacity: 1, transition: springs.smooth },
    exit: { y: -100, opacity: 0 },
  },
};

// Scale animations
export const scaleVariants: Variants = {
  hidden: { scale: 0, opacity: 0 },
  visible: {
    scale: 1,
    opacity: 1,
    transition: springs.bouncy,
  },
  exit: {
    scale: 0,
    opacity: 0,
    transition: { duration: 0.2 },
  },
};

// Rotate animations
export const rotateVariants: Variants = {
  idle: { rotate: 0 },
  spin: {
    rotate: 360,
    transition: {
      duration: 1,
      repeat: Infinity,
      ease: 'linear',
    },
  },
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

// Generate staggered delay for list items
export const getStaggerDelay = (index: number, baseDelay: number = 0.05) => 
  index * baseDelay;

// Generate a random animation delay within a range
export const getRandomDelay = (min: number = 0, max: number = 0.3) =>
  Math.random() * (max - min) + min;

// Create custom spring animation
export const createSpring = (stiffness: number, damping: number): Transition => ({
  type: 'spring',
  stiffness,
  damping,
});

// Combine multiple animations
export const combineAnimations = (...animations: Record<string, unknown>[]) =>
  animations.reduce((acc, anim) => ({ ...acc, ...anim }), {});

// ============================================
// EXPERIMENTAL / IMMERSIVE ANIMATIONS
// ============================================

// Premium card enter - reality-bending effect
export const immersiveCardEnter: Variants = {
  hidden: {
    opacity: 0,
    scale: 0.85,
    y: 60,
    filter: 'blur(20px) saturate(0.5)',
    rotateX: 15,
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    filter: 'blur(0px) saturate(1)',
    rotateX: 0,
    transition: {
      type: 'spring',
      damping: 20,
      stiffness: 100,
      mass: 0.8,
      staggerChildren: 0.08,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: -30,
    filter: 'blur(15px)',
    transition: { duration: 0.3 },
  },
};

// Parallax depth layer animations
export const parallaxLayerVariants = {
  background: {
    depth: 0.3,
    transition: { type: 'spring', damping: 30, stiffness: 100 },
  },
  midground: {
    depth: 1,
    transition: { type: 'spring', damping: 25, stiffness: 150 },
  },
  foreground: {
    depth: 2,
    transition: { type: 'spring', damping: 20, stiffness: 200 },
  },
};

// Magnetic button attraction effect
export const magneticButtonVariants: Variants = {
  idle: { scale: 1, x: 0, y: 0 },
  hover: {
    scale: 1.05,
    transition: { type: 'spring', damping: 15, stiffness: 300 },
  },
  attracted: {
    transition: { type: 'spring', damping: 10, stiffness: 200 },
  },
};

// Glassmorphic reveal animation
export const glassRevealVariants: Variants = {
  hidden: {
    opacity: 0,
    backdropFilter: 'blur(0px)',
    backgroundColor: 'transparent',
  },
  visible: {
    opacity: 1,
    backdropFilter: 'blur(20px)',
    backgroundColor: 'hsl(var(--card) / 0.6)',
    transition: { duration: 0.5, ease: 'easeOut' },
  },
};

// Weather-specific animations
export const weatherTransitions = {
  sunRays: {
    animate: {
      opacity: [0.3, 0.6, 0.3],
      scale: [1, 1.05, 1],
    },
    transition: {
      duration: 4,
      repeat: Infinity,
      ease: 'easeInOut',
    },
  },
  rainDrop: {
    initial: { y: -20, opacity: 0 },
    animate: { y: 100, opacity: [0, 1, 0] },
    transition: { duration: 1, ease: 'linear' },
  },
  cloudDrift: {
    animate: { x: [0, 20, 0] },
    transition: { duration: 20, repeat: Infinity, ease: 'linear' },
  },
  lightning: {
    flash: {
      opacity: [0, 1, 0.5, 1, 0],
      transition: { duration: 0.15, times: [0, 0.2, 0.4, 0.6, 1] },
    },
  },
};

// Data stream animation for backgrounds
export const dataStreamVariants: Variants = {
  hidden: { pathLength: 0, opacity: 0 },
  visible: {
    pathLength: 1,
    opacity: 0.5,
    transition: {
      pathLength: { duration: 2, ease: 'linear' },
      opacity: { duration: 0.5 },
    },
  },
};

// Holographic shimmer effect
export const holographicShimmer: Variants = {
  shimmer: {
    backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'],
    transition: {
      duration: 3,
      repeat: Infinity,
      ease: 'linear',
    },
  },
};

// Orb pulsation for AI elements
export const orbPulseVariants: Variants = {
  idle: {
    scale: 1,
    opacity: 0.8,
  },
  active: {
    scale: [1, 1.1, 1],
    opacity: [0.8, 1, 0.8],
    transition: {
      duration: 2,
      repeat: Infinity,
      ease: 'easeInOut',
    },
  },
  speaking: {
    scale: [1, 1.15, 1.05, 1.2, 1],
    opacity: [0.8, 1, 0.9, 1, 0.8],
    transition: {
      duration: 0.8,
      repeat: Infinity,
      ease: 'easeInOut',
    },
  },
};
