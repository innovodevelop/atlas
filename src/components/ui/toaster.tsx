import { useToast } from "@/hooks/use-toast";
import { AnimatePresence } from "framer-motion";
import { HolographicToast, type HolographicToastProps } from "@/components/ui/holographic-toast";

export function Toaster() {
  const { toasts, dismiss } = useToast();

  if (!toasts || toasts.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-md w-full pointer-events-none">
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => {
          if (!toast || !toast.id) return null;
          
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
