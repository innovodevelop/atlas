import { memo } from 'react';
import { FileText, FileSpreadsheet, Presentation, Folder, Upload, Download, MoreHorizontal, Share2, ChevronRight } from 'lucide-react';
import { DashboardCard } from './DashboardCard';
import { motion } from 'framer-motion';

interface DocumentsCardProps {
  isFocused?: boolean;
  streamingData?: any[];
  onExpand?: () => void;
}

const recentDocuments = [
  {
    id: 1,
    name: 'Q4 Budget Report.xlsx',
    type: 'spreadsheet',
    size: '2.4 MB',
    modified: '2 hours ago',
    shared: true,
    icon: FileSpreadsheet,
    bgColor: 'from-emerald-500/20 to-teal-500/20',
    borderColor: 'border-emerald-500/20',
    iconColor: 'text-emerald-400'
  },
  {
    id: 2,
    name: 'Product Roadmap 2025.pptx',
    type: 'presentation',
    size: '8.7 MB',
    modified: 'Yesterday',
    shared: true,
    icon: Presentation,
    bgColor: 'from-orange-500/20 to-amber-500/20',
    borderColor: 'border-orange-500/20',
    iconColor: 'text-orange-400'
  },
  {
    id: 3,
    name: 'Meeting Notes - Dec 12.docx',
    type: 'document',
    size: '145 KB',
    modified: 'Yesterday',
    shared: false,
    icon: FileText,
    bgColor: 'from-blue-500/20 to-cyan-500/20',
    borderColor: 'border-blue-500/20',
    iconColor: 'text-blue-400'
  },
  {
    id: 4,
    name: 'Brand Assets',
    type: 'folder',
    size: '24 files',
    modified: '3 days ago',
    shared: true,
    icon: Folder,
    bgColor: 'from-violet-500/20 to-purple-500/20',
    borderColor: 'border-violet-500/20',
    iconColor: 'text-violet-400'
  },
];

const storageUsed = 67;

const DocumentsCardComponent = ({ isFocused, onExpand }: DocumentsCardProps) => {
  return (
    <DashboardCard
      glowColor="rgba(59, 130, 246, 0.15)"
      onClick={onExpand}
      header={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-blue-500/20">
              <FileText className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Documents</h3>
              <p className="text-xs text-muted-foreground">4 recent files</p>
            </div>
          </div>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-400 bg-blue-500/10 rounded-lg hover:bg-blue-500/20 transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            Upload
          </motion.button>
        </div>
      }
    >
      <div className="space-y-1">
        {recentDocuments.map((doc, index) => {
          const IconComponent = doc.icon;
          
          return (
            <motion.div
              key={doc.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.1 }}
              className={`
                group flex items-center gap-3 p-3 rounded-xl
                cursor-pointer transition-all duration-200
                hover:bg-accent/50
                ${isFocused ? 'animate-pulse' : ''}
              `}
            >
              {/* File icon */}
              <div className={`
                w-10 h-10 rounded-xl flex items-center justify-center
                bg-gradient-to-br ${doc.bgColor} border ${doc.borderColor}
              `}>
                <IconComponent className={`w-5 h-5 ${doc.iconColor}`} />
              </div>
              
              {/* File info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground truncate">{doc.name}</p>
                  {doc.shared && (
                    <Share2 className="w-3 h-3 text-muted-foreground shrink-0" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {doc.size} · Modified {doc.modified}
                </p>
              </div>
              
              {/* Quick actions */}
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button className="p-1.5 rounded-lg hover:bg-accent transition-colors">
                  <Download className="w-4 h-4 text-muted-foreground" />
                </button>
                <button className="p-1.5 rounded-lg hover:bg-accent transition-colors">
                  <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
              
              {/* Hover arrow */}
              <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </motion.div>
          );
        })}
      </div>
      
      {/* Storage usage */}
      <div className="mt-4 pt-4 border-t border-border/50">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">Storage Used</span>
          <span className="text-xs font-medium text-foreground">{storageUsed}% of 100 GB</span>
        </div>
        <div className="h-2 bg-muted/20 rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${storageUsed}%` }}
            transition={{ duration: 1, delay: 0.3 }}
          />
        </div>
        <div className="flex items-center justify-between mt-2 text-[10px] text-muted-foreground">
          <span>67 GB used</span>
          <span>33 GB available</span>
        </div>
      </div>
    </DashboardCard>
  );
};

export const DocumentsCard = memo(DocumentsCardComponent);
