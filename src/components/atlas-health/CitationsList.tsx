import { ExternalLink, Globe, FileText, Shield, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface Citation {
  url: string;
  title?: string;
  snippet?: string;
  domain?: string;
  credibility_score?: number;
  accessed_at?: string;
}

interface CitationsListProps {
  citations: (Citation | string)[];
  className?: string;
  compact?: boolean;
}

// Extract domain from URL
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

// Get credibility badge color
function getCredibilityColor(score: number): string {
  if (score >= 0.8) return 'text-green-400';
  if (score >= 0.6) return 'text-yellow-400';
  return 'text-orange-400';
}

// Source chips are rendered locally instead of loading a favicon: fetching one
// would hand a third party the user's IP plus the domain of every source Atlas
// consulted. Colour is deterministic per domain so a source always looks the same.
const MONOGRAM_COLORS = [
  'bg-blue-400/15 text-blue-400',
  'bg-violet-400/15 text-violet-400',
  'bg-emerald-400/15 text-emerald-400',
  'bg-amber-400/15 text-amber-400',
  'bg-rose-400/15 text-rose-400',
  'bg-cyan-400/15 text-cyan-400',
];

function hashDomain(domain: string): number {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Initials from the domain's own label: "nature.com" → "NA", "bbc.co.uk" → "BB"
function getMonogram(domain: string, letters: number): string {
  const label = domain.replace(/^www\./, '').split('.')[0];
  return (label.slice(0, letters) || '?').toUpperCase();
}

const SourceMonogram = ({
  domain,
  letters = 2,
  className,
}: {
  domain: string;
  letters?: number;
  className?: string;
}) => (
  <span
    aria-hidden="true"
    className={cn(
      'inline-flex items-center justify-center font-semibold leading-none tracking-tight select-none',
      MONOGRAM_COLORS[hashDomain(domain) % MONOGRAM_COLORS.length],
      className
    )}
  >
    {getMonogram(domain, letters)}
  </span>
);

export const CitationsList = ({ citations, className, compact = false }: CitationsListProps) => {
  if (!citations || citations.length === 0) {
    return null;
  }

  // Normalize citations to objects
  const normalizedCitations: Citation[] = citations.map(c => 
    typeof c === 'string' ? { url: c } : c
  );

  if (compact) {
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        {normalizedCitations.slice(0, 5).map((citation, idx) => {
          const domain = citation.domain || extractDomain(citation.url);
          return (
            <a
              key={idx}
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
              title={citation.title || citation.url}
            >
              <SourceMonogram domain={domain} letters={1} className="w-3.5 h-3.5 rounded-[3px] text-[8px]" />
              <span className="truncate max-w-[100px]">{domain}</span>
              <ExternalLink className="w-2.5 h-2.5 opacity-50" />
            </a>
          );
        })}
        {normalizedCitations.length > 5 && (
          <Badge variant="outline" className="text-xs">
            +{normalizedCitations.length - 5} more
          </Badge>
        )}
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <FileText className="w-4 h-4" />
        <span>Sources ({normalizedCitations.length})</span>
      </div>
      
      <div className="space-y-2">
        {normalizedCitations.map((citation, idx) => {
          const domain = citation.domain || extractDomain(citation.url);
          
          return (
            <a
              key={idx}
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-3 p-3 rounded-lg bg-background/50 border border-border/30 hover:border-primary/30 hover:bg-background/80 transition-all group"
            >
              <SourceMonogram domain={domain} className="flex-shrink-0 w-8 h-8 rounded-lg text-xs" />
              
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-primary group-hover:underline truncate">
                    {citation.title || domain}
                  </span>
                  <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground" />
                </div>
                
                <div className="flex items-center gap-2 mt-0.5">
                  <Globe className="w-3 h-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground truncate">{domain}</span>
                  
                  {citation.credibility_score !== undefined && (
                    <span className={cn("flex items-center gap-0.5 text-xs", getCredibilityColor(citation.credibility_score))}>
                      <Shield className="w-3 h-3" />
                      {Math.round(citation.credibility_score * 100)}%
                    </span>
                  )}
                </div>
                
                {citation.snippet && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {citation.snippet}
                  </p>
                )}
              </div>
              
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted/50 flex items-center justify-center text-xs text-muted-foreground">
                {idx + 1}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
};

// Inline citation component for use within text
export const InlineCitation = ({ 
  index, 
  url, 
  title 
}: { 
  index: number; 
  url: string; 
  title?: string;
}) => {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center justify-center w-4 h-4 text-[10px] font-medium rounded-full bg-primary/20 text-primary hover:bg-primary/30 transition-colors align-super ml-0.5"
      title={title || url}
    >
      {index}
    </a>
  );
};
