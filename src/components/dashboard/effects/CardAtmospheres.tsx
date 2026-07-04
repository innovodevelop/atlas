import { motion } from 'framer-motion';
import { memo } from 'react';
import { useWindowActivity } from '@/hooks/useWindowActivity';

// Ambient card backgrounds. Perf rules for this file:
// - Every component is memo()'d — parent re-renders must not restart loops
// - Particle configs live at module scope — computed once per app load
// - Counts are tuned down: these are ambience, nobody counts the particles
// - When the window is hidden/blurred every atmosphere renders null, killing
//   all infinite framer-motion loops at once

// Email Card - Data Stream Background
const EMAIL_STREAMS = Array.from({ length: 8 }, (_, i) => ({
  id: i,
  left: `${Math.random() * 100}%`,
  width: 1 + Math.random() * 2,
  height: 50 + Math.random() * 100,
  duration: 3 + Math.random() * 4,
  delay: Math.random() * 5,
}));

export const EmailAtmosphere = memo(() => {
  const active = useWindowActivity();
  if (!active) return null;

  return (
    <div className="absolute inset-0 overflow-hidden opacity-30">
      {EMAIL_STREAMS.map((stream) => (
        <motion.div
          key={stream.id}
          className="absolute bg-gradient-to-b from-pink-500/40 via-rose-500/20 to-transparent rounded-full"
          style={{
            left: stream.left,
            width: stream.width,
            height: stream.height,
            top: '-20%',
          }}
          animate={{
            y: ['0%', '150vh'],
            opacity: [0, 0.8, 0],
          }}
          transition={{
            duration: stream.duration,
            delay: stream.delay,
            repeat: Infinity,
            ease: 'linear',
          }}
        />
      ))}
    </div>
  );
});
EmailAtmosphere.displayName = 'EmailAtmosphere';

// Stocks Card - Market Pulse Background
const STOCK_PULSES = Array.from({ length: 4 }, (_, i) => ({
  id: i,
  delay: i * 0.8,
  size: 200 + i * 160,
}));

export const StocksAtmosphere = memo(() => {
  const active = useWindowActivity();
  if (!active) return null;

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        {STOCK_PULSES.map((pulse) => (
          <motion.div
            key={pulse.id}
            className="absolute rounded-full border border-emerald-500/20"
            style={{
              width: pulse.size,
              height: pulse.size,
              left: -pulse.size / 2,
              top: -pulse.size / 2,
            }}
            animate={{
              scale: [1, 1.5, 1],
              opacity: [0.3, 0.1, 0.3],
            }}
            transition={{
              duration: 4,
              delay: pulse.delay,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
          />
        ))}
      </div>

      {/* Trend lines */}
      <svg className="absolute inset-0 w-full h-full opacity-10" viewBox="0 0 100 100" preserveAspectRatio="none">
        <motion.path
          d="M0 50 Q 25 30, 50 50 T 100 40"
          fill="none"
          stroke="hsl(142, 71%, 45%)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 3, repeat: Infinity }}
        />
      </svg>
    </div>
  );
});
StocksAtmosphere.displayName = 'StocksAtmosphere';

// Calendar Card - Time Flow Background
const CALENDAR_ORBS = Array.from({ length: 6 }, (_, i) => ({
  id: i,
  left: 10 + i * 14,
  size: 8 + Math.random() * 20,
  duration: 8 + Math.random() * 4,
  delay: i * 0.3,
}));

export const CalendarAtmosphere = memo(() => {
  const active = useWindowActivity();
  if (!active) return null;

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* Flowing time orbs */}
      {CALENDAR_ORBS.map((orb) => (
        <motion.div
          key={orb.id}
          className="absolute rounded-full bg-gradient-to-br from-blue-500/30 to-cyan-500/20"
          style={{
            left: `${orb.left}%`,
            width: orb.size,
            height: orb.size,
            top: '50%',
          }}
          animate={{
            y: ['-50%', '-150%', '50%', '-50%'],
            opacity: [0.3, 0.6, 0.3, 0.3],
            scale: [1, 1.2, 0.9, 1],
          }}
          transition={{
            duration: orb.duration,
            delay: orb.delay,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />
      ))}

      {/* Horizontal time flow lines */}
      <div className="absolute inset-0 opacity-10">
        {[1, 2, 3].map((i) => (
          <motion.div
            key={i}
            className="absolute h-px bg-gradient-to-r from-transparent via-blue-500 to-transparent"
            style={{ top: `${20 + i * 25}%`, left: 0, right: 0 }}
            animate={{ opacity: [0.2, 0.5, 0.2] }}
            transition={{ duration: 3, delay: i * 0.5, repeat: Infinity }}
          />
        ))}
      </div>
    </div>
  );
});
CalendarAtmosphere.displayName = 'CalendarAtmosphere';

// Tasks Card - Zen Ripple Background
const TASK_PARTICLES = Array.from({ length: 8 }, (_, i) => ({
  id: i,
  left: `${Math.random() * 100}%`,
  top: `${Math.random() * 100}%`,
  duration: 3 + Math.random() * 2,
  delay: Math.random() * 2,
}));

export const TasksAtmosphere = memo(() => {
  const active = useWindowActivity();
  if (!active) return null;

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* Central zen ripples */}
      <div className="absolute bottom-1/4 left-1/2 -translate-x-1/2">
        {[1, 2, 3].map((i) => (
          <motion.div
            key={i}
            className="absolute rounded-full border border-blue-500/20"
            style={{
              width: 130 * i,
              height: 130 * i,
              left: -65 * i,
              top: -65 * i,
            }}
            animate={{
              scale: [1, 1.3],
              opacity: [0.3, 0],
            }}
            transition={{
              duration: 3,
              delay: i * 0.5,
              repeat: Infinity,
              ease: 'easeOut',
            }}
          />
        ))}
      </div>

      {/* Floating focus particles */}
      {TASK_PARTICLES.map((p) => (
        <motion.div
          key={p.id}
          className="absolute w-1 h-1 rounded-full bg-indigo-400/40"
          style={{ left: p.left, top: p.top }}
          animate={{
            y: [0, -20, 0],
            opacity: [0.2, 0.6, 0.2],
          }}
          transition={{
            duration: p.duration,
            delay: p.delay,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />
      ))}
    </div>
  );
});
TasksAtmosphere.displayName = 'TasksAtmosphere';

// Notes Card - Creative Paper Texture
const INK_SPLASHES = Array.from({ length: 4 }, (_, i) => ({
  id: i,
  left: 10 + Math.random() * 80,
  top: 10 + Math.random() * 80,
  size: 30 + Math.random() * 60,
  rotation: Math.random() * 360,
  duration: 5 + Math.random() * 3,
  delay: Math.random() * 2,
}));

export const NotesAtmosphere = memo(() => {
  const active = useWindowActivity();
  if (!active) return null;

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* Paper texture grain */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        }}
      />

      {/* Ink splashes */}
      {INK_SPLASHES.map((splash) => (
        <motion.div
          key={splash.id}
          className="absolute rounded-full bg-gradient-to-br from-amber-500/10 to-orange-500/5 blur-xl"
          style={{
            left: `${splash.left}%`,
            top: `${splash.top}%`,
            width: splash.size,
            height: splash.size,
            transform: `rotate(${splash.rotation}deg)`,
          }}
          animate={{
            scale: [1, 1.1, 1],
            opacity: [0.3, 0.5, 0.3],
          }}
          transition={{
            duration: splash.duration,
            delay: splash.delay,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />
      ))}
    </div>
  );
});
NotesAtmosphere.displayName = 'NotesAtmosphere';

// News Card - Information Flow
const NEWS_BARS = Array.from({ length: 6 }, (_, i) => ({
  id: i,
  top: `${10 + i * 15}%`,
  width: 100 + Math.random() * 200,
  duration: 8 + Math.random() * 4,
  delay: i * 0.5,
}));

export const NewsAtmosphere = memo(() => {
  const active = useWindowActivity();
  if (!active) return null;

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* Headline bars flowing */}
      {NEWS_BARS.map((bar) => (
        <motion.div
          key={bar.id}
          className="absolute h-1 rounded-full bg-gradient-to-r from-violet-500/30 via-purple-500/20 to-transparent"
          style={{
            top: bar.top,
            left: '-100%',
            width: bar.width,
          }}
          animate={{
            x: ['0%', '200vw'],
          }}
          transition={{
            duration: bar.duration,
            delay: bar.delay,
            repeat: Infinity,
            ease: 'linear',
          }}
        />
      ))}

      {/* Trending indicator pulses */}
      <motion.div
        className="absolute top-10 right-10 w-4 h-4 rounded-full bg-amber-500/40"
        animate={{
          scale: [1, 1.5, 1],
          opacity: [0.6, 0.3, 0.6],
        }}
        transition={{
          duration: 2,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />
    </div>
  );
});
NewsAtmosphere.displayName = 'NewsAtmosphere';

// Documents Card - File Constellation
const DOC_NODES = Array.from({ length: 10 }, (_, i) => ({
  id: i,
  x: Math.random() * 100,
  y: Math.random() * 100,
  size: 2 + Math.random() * 4,
  duration: 3 + Math.random() * 2,
  delay: Math.random() * 2,
}));

export const DocumentsAtmosphere = memo(() => {
  const active = useWindowActivity();
  if (!active) return null;

  return (
    <div className="absolute inset-0 overflow-hidden opacity-40">
      {/* File nodes */}
      {DOC_NODES.map((node) => (
        <motion.div
          key={node.id}
          className="absolute rounded-full bg-blue-400"
          style={{
            left: `${node.x}%`,
            top: `${node.y}%`,
            width: node.size,
            height: node.size,
          }}
          animate={{
            opacity: [0.3, 0.7, 0.3],
            scale: [1, 1.2, 1],
          }}
          transition={{
            duration: node.duration,
            delay: node.delay,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />
      ))}

      {/* Connection lines */}
      <svg className="absolute inset-0 w-full h-full">
        {DOC_NODES.map((node, i) => {
          const next = DOC_NODES[(i + 1) % DOC_NODES.length];
          return (
            <motion.line
              key={i}
              x1={`${node.x}%`}
              y1={`${node.y}%`}
              x2={`${next.x}%`}
              y2={`${next.y}%`}
              stroke="hsl(210, 100%, 60%)"
              strokeWidth="0.5"
              strokeOpacity="0.2"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{
                duration: 2,
                delay: i * 0.1,
                repeat: Infinity,
                repeatType: 'reverse',
              }}
            />
          );
        })}
      </svg>
    </div>
  );
});
DocumentsAtmosphere.displayName = 'DocumentsAtmosphere';

// Travel Card - Journey Path
export const TravelAtmosphere = memo(() => {
  const active = useWindowActivity();
  if (!active) return null;

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* World map grid lines */}
      <div className="absolute inset-0 opacity-10">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={`h-${i}`}
            className="absolute h-px bg-violet-500/50"
            style={{ top: `${i * 10}%`, left: 0, right: 0 }}
          />
        ))}
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={`v-${i}`}
            className="absolute w-px bg-violet-500/50"
            style={{ left: `${i * 10}%`, top: 0, bottom: 0 }}
          />
        ))}
      </div>

      {/* Destination beacon */}
      <motion.div
        className="absolute top-1/3 right-1/4"
        animate={{
          scale: [1, 1.5, 1],
          opacity: [0.5, 1, 0.5],
        }}
        transition={{
          duration: 2,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      >
        <div className="w-4 h-4 rounded-full bg-violet-500/60" />
        <div className="absolute inset-0 w-4 h-4 rounded-full bg-violet-500/30 animate-ping" />
      </motion.div>

      {/* Flight path */}
      <svg className="absolute inset-0 w-full h-full opacity-30" viewBox="0 0 100 100" preserveAspectRatio="none">
        <motion.path
          d="M10 80 Q 30 20, 50 50 T 85 30"
          fill="none"
          stroke="hsl(260, 80%, 60%)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
          strokeDasharray="8 4"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 3, repeat: Infinity }}
        />
      </svg>
    </div>
  );
});
TravelAtmosphere.displayName = 'TravelAtmosphere';
