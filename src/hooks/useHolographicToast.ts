import { useToast } from "@/hooks/use-toast";

type ToastVariant = "default" | "success" | "error" | "warning" | "info" | "knowledge" | "research" | "learning";

interface ToastOptions {
  title: string;
  description?: string;
  duration?: number;
  action?: React.ReactNode;
}

export const useHolographicToast = () => {
  const { toast, dismiss, toasts } = useToast();

  const showToast = (variant: ToastVariant, options: ToastOptions) => {
    return toast({
      ...options,
      // @ts-expect-error - custom variant property
      variant,
    });
  };

  return {
    toast: (options: ToastOptions) => showToast("default", options),
    success: (options: ToastOptions) => showToast("success", options),
    error: (options: ToastOptions) => showToast("error", options),
    warning: (options: ToastOptions) => showToast("warning", options),
    info: (options: ToastOptions) => showToast("info", options),
    knowledge: (options: ToastOptions) => showToast("knowledge", options),
    research: (options: ToastOptions) => showToast("research", options),
    learning: (options: ToastOptions) => showToast("learning", options),
    dismiss,
    toasts,
  };
};

// Standalone functions for use outside of React components
export const holographicToast = {
  success: (title: string, description?: string) => {
    const event = new CustomEvent("holographic-toast", {
      detail: { variant: "success", title, description },
    });
    window.dispatchEvent(event);
  },
  error: (title: string, description?: string) => {
    const event = new CustomEvent("holographic-toast", {
      detail: { variant: "error", title, description },
    });
    window.dispatchEvent(event);
  },
  warning: (title: string, description?: string) => {
    const event = new CustomEvent("holographic-toast", {
      detail: { variant: "warning", title, description },
    });
    window.dispatchEvent(event);
  },
  info: (title: string, description?: string) => {
    const event = new CustomEvent("holographic-toast", {
      detail: { variant: "info", title, description },
    });
    window.dispatchEvent(event);
  },
  knowledge: (title: string, description?: string) => {
    const event = new CustomEvent("holographic-toast", {
      detail: { variant: "knowledge", title, description },
    });
    window.dispatchEvent(event);
  },
  research: (title: string, description?: string) => {
    const event = new CustomEvent("holographic-toast", {
      detail: { variant: "research", title, description },
    });
    window.dispatchEvent(event);
  },
  learning: (title: string, description?: string) => {
    const event = new CustomEvent("holographic-toast", {
      detail: { variant: "learning", title, description },
    });
    window.dispatchEvent(event);
  },
};
