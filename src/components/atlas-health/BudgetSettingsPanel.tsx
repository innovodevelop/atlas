import { DollarSign, AlertTriangle, Zap, Bell, PowerOff } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { useSpendingAlerts } from "@/hooks/useSpendingAlerts";
import { useAtlasProviderStatus } from "@/hooks/useAtlasProviderStatus";
import { useHolographicToast } from "@/hooks/useHolographicToast";
import { Skeleton } from "@/components/ui/skeleton";

export function BudgetSettingsPanel() {
  const toast = useHolographicToast();
  const {
    budgetSettings,
    isLoading,
    updateBudgetSettings,
    isUpdating,
    dailySpending,
    weeklySpending,
    dailyBudgetUsedPct,
    weeklyBudgetUsedPct,
    hasSpendData,
  } = useSpendingAlerts();
  
  const { settings, updateSettings, lovableAIEnabled } = useAtlasProviderStatus();
  
  const handleEmergencyStop = () => {
    updateSettings({ 
      lovable_ai_enabled: false,
      disable_reason: 'emergency_stop',
      disabled_at: new Date().toISOString(),
    });
    toast.warning({ title: 'Emergency Stop', description: 'All AI operations have been stopped' });
  };

  if (isLoading) {
    return (
      <Card className="bg-card/50 backdrop-blur-sm border-border/50">
        <CardHeader>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-48 mt-2" />
        </CardHeader>
        <CardContent className="space-y-6">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!budgetSettings) return null;

  return (
    <Card className="bg-card/50 backdrop-blur-sm border-border/50">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-primary" />
              Budget Settings
            </CardTitle>
            <CardDescription>
              Set spending limits to control AI costs
            </CardDescription>
          </div>
          {lovableAIEnabled && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleEmergencyStop}
              disabled={isUpdating}
              className="gap-2"
            >
              <PowerOff className="w-4 h-4" />
              Emergency Stop
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Current spending. These used to read a fabricated estimate
            (successful_calls × a literal 500 tokens × a hardcoded price table
            for providers Atlas does not call). They now read the recorded spend
            log — and when there is no log, they say so rather than printing a
            confident $0.00 that looks like a measurement. */}
        {hasSpendData ? (
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="text-xs text-muted-foreground mb-1">Daily Usage</p>
              <p className="text-lg font-semibold">${dailySpending.toFixed(2)}</p>
              <p className="text-xs text-muted-foreground">
                of ${budgetSettings.daily_budget_usd.toFixed(2)} ({dailyBudgetUsedPct.toFixed(0)}%)
              </p>
            </div>
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="text-xs text-muted-foreground mb-1">Weekly Usage</p>
              <p className="text-lg font-semibold">${weeklySpending.toFixed(2)}</p>
              <p className="text-xs text-muted-foreground">
                of ${budgetSettings.weekly_budget_usd.toFixed(2)} ({weeklyBudgetUsedPct.toFixed(0)}%)
              </p>
            </div>
          </div>
        ) : (
          <div className="p-3 rounded-lg bg-muted/50">
            <p className="text-xs text-muted-foreground mb-1">Current usage</p>
            <p className="text-sm">Not measured</p>
            <p className="text-xs text-muted-foreground">
              Atlas keeps no per-day spend log yet, so it cannot say how much of your
              ${budgetSettings.daily_budget_usd.toFixed(2)} daily limit is used. The limits below are still
              recorded — they are simply not enforced against a measured figure.
            </p>
          </div>
        )}

        <Separator />

        {/* Daily Budget */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-yellow-500" />
              Daily Budget
            </Label>
            <span className="text-sm font-medium">${budgetSettings.daily_budget_usd.toFixed(2)}</span>
          </div>
          <Slider
            value={[budgetSettings.daily_budget_usd]}
            min={1}
            max={50}
            step={1}
            disabled={isUpdating}
            onValueCommit={([value]) => updateBudgetSettings({ daily_budget_usd: value })}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Maximum amount to spend on AI operations per day
          </p>
        </div>

        {/* Weekly Budget */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-green-500" />
              Weekly Budget
            </Label>
            <span className="text-sm font-medium">${budgetSettings.weekly_budget_usd.toFixed(2)}</span>
          </div>
          <Slider
            value={[budgetSettings.weekly_budget_usd]}
            min={5}
            max={200}
            step={5}
            disabled={isUpdating}
            onValueCommit={([value]) => updateBudgetSettings({ weekly_budget_usd: value })}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Maximum amount to spend on AI operations per week
          </p>
        </div>

        <Separator />

        {/* Alert Thresholds */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-yellow-500" />
              Warning Threshold
            </Label>
            <span className="text-sm font-medium">{budgetSettings.alert_threshold_pct}%</span>
          </div>
          <Slider
            value={[budgetSettings.alert_threshold_pct]}
            min={50}
            max={90}
            step={5}
            disabled={isUpdating}
            onValueCommit={([value]) => updateBudgetSettings({ alert_threshold_pct: value })}
            className="w-full"
          />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-orange-500" />
              Critical Threshold
            </Label>
            <span className="text-sm font-medium">{budgetSettings.critical_threshold_pct}%</span>
          </div>
          <Slider
            value={[budgetSettings.critical_threshold_pct]}
            min={80}
            max={99}
            step={1}
            disabled={isUpdating}
            onValueCommit={([value]) => updateBudgetSettings({ critical_threshold_pct: value })}
            className="w-full"
          />
        </div>

        <Separator />

        {/* Toggles */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-primary" />
                Enable Alerts
              </Label>
              <p className="text-xs text-muted-foreground">
                Show notifications when approaching limits
              </p>
            </div>
            <Switch
              checked={budgetSettings.alerts_enabled}
              disabled={isUpdating}
              onCheckedChange={(checked) => updateBudgetSettings({ alerts_enabled: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-destructive" />
                Auto-disable Learning
              </Label>
              {/*
                Honest copy. This setting persists to `atlas_budget_settings`
                and the column exists (db_schema.sql:693), but NOTHING reads it
                to actually pause anything — verified repo-wide. Its sibling
                `alerts_enabled` IS read (useSpendingAlerts.ts:156,
                SpendingAlertBanner.tsx:25), which is what makes the asymmetry
                easy to miss.

                Left visible and switchable rather than deleted, because the
                preference is worth recording and the storage is real — but the
                copy now says what it does instead of what it implies. It must
                not read as an active safety net; someone relying on it to cap
                spend would be relying on nothing.
              */}
              <p className="text-xs text-muted-foreground">
                Records your preference to pause learning when the budget is
                exceeded. <strong>Not enforced yet</strong> — nothing currently
                acts on it, so treat the budget alert as the live control.
              </p>
            </div>
            <Switch
              checked={budgetSettings.auto_disable_on_limit}
              disabled={isUpdating}
              onCheckedChange={(checked) => updateBudgetSettings({ auto_disable_on_limit: checked })}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
