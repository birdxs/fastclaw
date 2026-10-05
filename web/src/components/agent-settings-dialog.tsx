"use client";

import * as React from "react";
import {
  BrainIcon,
  BookOpenIcon,
  ClockIcon,
  CoinsIcon,
  IdCardIcon,
  LayersIcon,
  Palette,
  Plug,
  RadioIcon,
  ServerIcon,
  SparklesIcon,
  UserCog,
  Wand2Icon,
} from "lucide-react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AgentIdContext } from "@/hooks/use-agent-id";
import { useLocale, type MessageKey } from "@/components/locale-provider";

import AgentProfilePanel from "@/components/agent-profile-panel";
import AgentCustomizePage from "@/app/console/agents/[id]/customize/page";
import AgentModelsPage from "@/app/console/agents/[id]/models/page";
import AgentContextPage from "@/app/console/agents/[id]/context/page";
import AgentKnowledgePage from "@/app/console/agents/[id]/knowledge/page";
import AgentSkillsPage from "@/app/console/agents/[id]/skills/page";
import AgentPluginsPage from "@/app/console/agents/[id]/plugins/page";
import AgentChannelsPage from "@/app/console/agents/[id]/channels/page";
import AgentSchedulerPage from "@/app/console/agents/[id]/scheduler/page";
import AgentMCPPage from "@/app/console/agents/[id]/mcp/page";
import AgentUsagePage from "@/app/console/agents/[id]/usage/page";
import AccountSettingsPage from "@/app/settings/account/page";
import GeneralSettingsPage from "@/app/settings/general/page";
import UserModelsPage from "@/app/console/models/page";

export type AgentSettingsTab =
  | "profile"
  | "customize"
  | "models"
  | "context"
  | "knowledge"
  | "skills"
  | "mcp"
  | "plugins"
  | "channels"
  | "scheduler"
  | "usage"
  | "account"
  | "general";

type TabIcon = React.ComponentType<{ className?: string }>;

const AGENT_TABS: Array<{ id: AgentSettingsTab; label: string; icon: TabIcon }> = [
  { id: "profile", label: "Profile", icon: IdCardIcon },
  { id: "models", label: "Models", icon: BrainIcon },
  { id: "customize", label: "Customize", icon: Wand2Icon },
  { id: "skills", label: "Skills", icon: SparklesIcon },
  { id: "mcp", label: "MCP", icon: ServerIcon },
  { id: "plugins", label: "Plugins", icon: Plug },
  { id: "knowledge", label: "Knowledge", icon: BookOpenIcon },
  { id: "context", label: "Context", icon: LayersIcon },
  { id: "channels", label: "Channels", icon: RadioIcon },
  { id: "scheduler", label: "Scheduler", icon: ClockIcon },
  { id: "usage", label: "Token Usage", icon: CoinsIcon },
];

const USER_TABS: Array<{ id: AgentSettingsTab; label: string; icon: TabIcon }> = [
  { id: "account", label: "Account", icon: UserCog },
  { id: "general", label: "General", icon: Palette },
];

const TAB_LABEL_KEYS: Record<AgentSettingsTab, MessageKey> = {
  profile: "settings.tab.profile",
  customize: "settings.tab.customize",
  models: "settings.tab.models",
  context: "settings.tab.context",
  knowledge: "settings.tab.knowledge",
  skills: "settings.tab.skills",
  mcp: "settings.tab.mcp",
  plugins: "settings.tab.plugins",
  channels: "settings.tab.channels",
  scheduler: "settings.tab.scheduler",
  usage: "settings.tab.usage",
  account: "settings.tab.account",
  general: "settings.tab.general",
};

// Tabbed configuration panel with two mutually-exclusive modes:
// Agent settings (the default) and User settings (`userOnly`). Keeping
// them separate prevents account preferences from appearing inside a
// Bot-specific settings surface. Each tab mounts its existing page
// component lazily.
//
// role="viewer" hides the owner-only Agent tabs (Profile, Customize,
// Skills, Scheduler, Usage) and only exposes Models + Channels under
// Agent — viewers can pin their own model for the shared agent and
// bind their own IM accounts, but can't touch the agent's identity /
// skills / scheduling. The Models tab id is shared with owners; the
// render branch below picks the agent-scope page for owners and the
// user-scope page for viewers (same tab slot, different writer).
export function AgentSettingsDialog({
  open,
  onOpenChange,
  defaultTab,
  role = "owner",
  userOnly = false,
  agentId = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: AgentSettingsTab;
  role?: "owner" | "viewer";
  // userOnly hides the Agent section entirely. Used by the account-menu
  // Settings entry to expose personal preferences. The account's own
  // models, skills and API keys live in /console; deployment-wide pages
  // in /admin.
  userOnly?: boolean;
  // agentId names the agent to edit when the dialog is opened away from
  // that agent's URL (the console Agent list). Defaults to the URL's agent.
  agentId?: string;
}) {
  const { t } = useLocale();
  const agentTabs = userOnly
    ? []
    : role === "viewer"
      ? AGENT_TABS.filter((t) => t.id === "models" || t.id === "channels")
      : AGENT_TABS;
  const userTabs = userOnly
    ? USER_TABS
    : [];
  const visibleTabs = [...agentTabs, ...userTabs];
  // Pick the landing tab: userOnly opens on General (User section);
  // viewers land on Models (the first Agent tab they have); owners on
  // Profile. Ignore a requested default that isn't visible in the
  // current mode so switching between Agent and User settings can never
  // leave the content pane blank.
  const initialTab: AgentSettingsTab =
    defaultTab && visibleTabs.some((candidate) => candidate.id === defaultTab)
      ? defaultTab
      : userOnly
        ? "general"
        : role === "viewer"
          ? "models"
          : "profile";
  const [tab, setTab] = React.useState<AgentSettingsTab>(initialTab);

  // Reset to the requested tab whenever the dialog re-opens, so a fresh
  // click on the sidebar Settings button always lands on the same place.
  React.useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  return (
    <AgentIdContext.Provider value={agentId}>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "p-0 gap-0 overflow-hidden",
          "h-[85vh] w-[95vw] max-w-[1100px] sm:max-w-[1100px]",
          "grid grid-cols-[220px_1fr] grid-rows-1",
        )}
      >
        <aside className="flex flex-col gap-1 border-r bg-muted/40 p-3 overflow-y-auto">
          {agentTabs.length > 0 && (
            <>
              <SectionLabel>{t("common.agent")}</SectionLabel>
              {agentTabs.map((agentTab) => (
                <TabButton
                  key={agentTab.id}
                  tab={{ ...agentTab, label: t(TAB_LABEL_KEYS[agentTab.id]) }}
                  active={tab === agentTab.id}
                  onSelect={setTab}
                />
              ))}
            </>
          )}
          {userTabs.length > 0 && (
            <>
              <SectionLabel>{t("common.user")}</SectionLabel>
              {userTabs.map((userTab) => (
                <TabButton
                  key={userTab.id}
                  tab={{ ...userTab, label: t(TAB_LABEL_KEYS[userTab.id]) }}
                  active={tab === userTab.id}
                  onSelect={setTab}
                />
              ))}
            </>
          )}
        </aside>
        <div className="min-w-0 overflow-auto">
          {tab === "profile" && <AgentProfilePanel />}
          {tab === "customize" && <AgentCustomizePage />}
          {tab === "models" &&
            (role === "viewer" ? <UserModelsPage /> : <AgentModelsPage />)}
          {tab === "context" && <AgentContextPage />}
          {tab === "knowledge" && <AgentKnowledgePage />}
          {tab === "skills" && <AgentSkillsPage />}
          {tab === "mcp" && <AgentMCPPage />}
          {tab === "plugins" && <AgentPluginsPage />}
          {tab === "channels" && <AgentChannelsPage />}
          {tab === "scheduler" && <AgentSchedulerPage />}
          {tab === "usage" && <AgentUsagePage />}
          {tab === "account" && (
            <div className="p-6 max-w-3xl">
              <AccountSettingsPage />
            </div>
          )}
          {tab === "general" && (
            <div className="p-6 max-w-3xl">
              <GeneralSettingsPage />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
    </AgentIdContext.Provider>
  );
}

function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-2 pt-1 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

function TabButton({
  tab,
  active,
  onSelect,
}: {
  tab: { id: AgentSettingsTab; label: string; icon: TabIcon };
  active: boolean;
  onSelect: (id: AgentSettingsTab) => void;
}) {
  const Icon = tab.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(tab.id)}
      className={cn(
        "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-left transition-colors",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-foreground/80 hover:bg-accent/50",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span>{tab.label}</span>
    </button>
  );
}
