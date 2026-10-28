import { useToast } from "@/hooks/use-toast";
import { AnimatePresence } from "framer-motion";
import { HolographicToast, type HolographicToastProps } from "@/components/ui/holographic-toast";

export function Toaster() {
  const { toasts, dismiss } = useToast();

  if (!toasts || toasts.length === 0) {
    return null;
  }

  // Full width less the 1rem inset on each side, not `w-full`: at phone width
  // a 100% box pinned 1rem from the right started 1rem off the left edge, and
  // every toast lost its icon and first letters there.
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-md w-[calc(100%-2rem)] pointer-events-none">
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => {
          // A dismissed toast stays in the store (open: false) until its
          // removal timer; drawing it anyway made the close button do nothing.
          if (!toast || !toast.id || toast.open === false) return null;
          
          return (
            <HolographicToast
              key={toast.id}
              id={toast.id}
              title={typeof toast.title === 'string' ? toast.title : undefined}
              description={typeof toast.description === 'string' ? toast.description : undefined}
              action={toast.action}
              variant={(toast as { variant?: HolographicToastProps["variant"] }).variant || "default"}
              onDismiss={() => dismiss(toast.id)}
              duration={5000}
            />
          );
        })}
      </AnimatePresence>
    </div>
  );
}
