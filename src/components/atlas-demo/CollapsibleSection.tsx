import { useState, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface CollapsibleSectionProps {
  title: string;
  icon?: ReactNode;
  color?: string;
  isCustomized?: boolean;
  isActive?: boolean;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  headerAction?: ReactNode;
}

export function CollapsibleSection({
  title,
  icon,
  color = 'violet',
  isCustomized,
  isActive,
  children,
  defaultOpen = false,
  className,
  headerAction,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  const colorClasses: Record<string, string> = {
    violet: 'from-violet-500/10 to-violet-500/5 border-violet-500/20',
    cyan: 'from-cyan-500/10 to-cyan-500/5 border-cyan-500/20',
    amber: 'from-amber-500/10 to-amber-500/5 border-amber-500/20',
    emerald: 'from-emerald-500/10 to-emerald-500/5 border-emerald-500/20',
    purple: 'from-purple-500/10 to-purple-500/5 border-purple-500/20',
    blue: 'from-blue-500/10 to-blue-500/5 border-blue-500/20',
    orange: 'from-orange-500/10 to-orange-500/5 border-orange-500/20',
    rose: 'from-rose-500/10 to-rose-500/5 border-rose-500/20',
    sky: 'from-sky-500/10 to-sky-500/5 border-sky-500/20',
    pink: 'from-pink-500/10 to-pink-500/5 border-pink-500/20',
    indigo: 'from-indigo-500/10 to-indigo-500/5 border-indigo-500/20',
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
      {/* asChild with a div: headerAction may contain buttons, which are invalid inside the default <button> trigger */}
      <CollapsibleTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen(!open);
            }
          }}
          className={cn(
            'w-full flex items-center justify-between p-3 rounded-lg bg-gradient-to-br border transition-all hover:border-opacity-50 cursor-pointer select-none',
            colorClasses[color] || colorClasses.violet,
            isActive && 'ring-1 ring-offset-1 ring-offset-background ring-primary/50'
          )}
        >
          <div className="flex items-center gap-2">
            {icon}
            <span className="text-sm font-medium text-foreground">{title}</span>
            {isCustomized && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-medium">
                customized
              </span>
            )}
            {isActive && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium">
                active
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {headerAction}
            <ChevronDown className={cn(
              'w-4 h-4 transition-transform text-muted-foreground',
              open && 'rotate-180'
            )} />
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3 space-y-3 px-1">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
