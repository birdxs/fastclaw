"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";
import type { AgentSwitcherItem } from "@/components/team-switcher";
import { NavMain, NavItem } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import { SidebarTitle } from "@/components/sidebar-title";
import {
  AgentSettingsDialog,
  type AgentSettingsTab,
} from "@/components/agent-settings-dialog";
import {
  ConsumerChatSidebar,
  type ConsumerAgentItem,
  type ConsumerTeamItem,
} from "@/components/consumer-chat-sidebar";
import {
  BotIcon,
  BoxesIcon,
  BrainIcon,
  CoinsIcon,
  InfoIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  MessagesSquareIcon,
  SparklesIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";
import {
  getAgent,
  getAgents,
  getChatSessions,
  getConfig,
  getMe,
  getStatus,
  type MeResponse,
  type StatusResponse,
} from "@/lib/api";
import { useLocale } from "@/components/locale-provider";
import { rememberAgentAccess } from "@/lib/agent-access-cache";

// Extract agent ID from pathname like /agents/default/chat/ or an Agent's
// console page like /console/agents/default/skills/ — the agent the chat
// sidebar highlights and the agent settings dialog opens for. The second
// capture is an explicit allow-list of agent sub-routes.
// Add new agent-scoped routes here when they ship — `project` was
// missed when the project chat route was introduced and that left
// the sidebar showing the platform nav for /agents/<id>/project/...
function extractAgentId(pathname: string): string | null {
  const match = pathname.match(
    /^\/(?:console\/)?agents\/([^/]+)\/(chat|customize|skills|models|sessions|channels|chats|scheduler|project|team|context|knowledge|mcp|plugins|usage)/,
  );
  return match ? match[1] : null;
}

function extractTeamId(pathname: string): string | null {
  const match = pathname.match(/^\/teams\/([^/]+)\/chat\/[^/]+/) ||
    pathname.match(/^\/agents\/[^/]+\/team\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// The console sidebar is one flat list of the caller's own (user-level)
// pages — the same for every account. Deployment-wide configuration
// (users, all chats, token usage, system models / skills / tools) lives
// under /admin for super_admins instead (adminNav).
// Overview is the console root, so a prefix match would light it up on
// every console page; it's active only on /console itself.
const consoleNav = (pathname: string): NavItem[] => [
  {
    title: "Overview",
    url: "/console/",
    icon: LayoutDashboardIcon,
    active: pathname.replace(/\/$/, "") === "/console",
  },
  { title: "Agents", url: "/console/agents/", icon: BotIcon },
  { title: "Models", url: "/console/models/", icon: BrainIcon },
  { title: "Skills", url: "/console/skills/", icon: SparklesIcon },
  { title: "Apps", url: "/console/apps/", icon: BoxesIcon },
  { title: "API Keys", url: "/console/apikeys/", icon: KeyRoundIcon },
];

// The /admin sidebar: deployment-wide pages, super_admin only (AuthGuard
// gates the routes, the APIs enforce it).
const ADMIN_NAV: NavItem[] = [
  { title: "Users", url: "/admin/users/", icon: UsersIcon },
  { title: "Chats", url: "/admin/chats/", icon: MessagesSquareIcon },
  { title: "Token Usage", url: "/admin/usage/", icon: CoinsIcon },
  { title: "Models", url: "/admin/models/", icon: BrainIcon },
  { title: "Skills", url: "/admin/skills/", icon: SparklesIcon },
  { title: "Tools", url: "/admin/tools/", icon: WrenchIcon },
  { title: "About", url: "/admin/about/", icon: InfoIcon },
];

function isAdminRoute(pathname: string) {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}


export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { t, tr } = useLocale();
  const pathname = usePathname();
  const activeAgentId = extractAgentId(pathname);
  const activeTeamId = extractTeamId(pathname);

  const [status, setStatus] = React.useState<StatusResponse | null>(null);
  const [me, setMe] = React.useState<MeResponse | null>(null);
  const [agents, setAgents] = React.useState<AgentSwitcherItem[]>([]);
  const [consumerAgents, setConsumerAgents] = React.useState<ConsumerAgentItem[]>([]);
  const [consumerTeams, setConsumerTeams] = React.useState<ConsumerTeamItem[]>([]);
  const [consumerAgentsLoading, setConsumerAgentsLoading] = React.useState(true);
  // role flag per agent the caller can see — owner vs viewer (read-only
  // shared from another user). Drives whether the AGENT_NAV exposes
  // configuration tabs.
  const [agentRoles, setAgentRoles] = React.useState<Record<string, "owner" | "viewer">>({});
  // Single dialog state covers both entry points: the agent-scoped
  // footer button (full Agent + User tabs) and the platform-nav
  // Settings entry (User tabs only). `settingsUserOnly` picks the mode.
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsUserOnly, setSettingsUserOnly] = React.useState(false);
  const [settingsDefaultTab, setSettingsDefaultTab] =
    React.useState<AgentSettingsTab>("profile");

  // ChatScreen owns the sticky header while AppSidebar owns the existing
  // tabbed settings dialog. A small window event connects the two without
  // introducing route-level state or putting settings controls back into
  // the deliberately minimal consumer sidebar footer.
  React.useEffect(() => {
    const openAgentSettings = (event: Event) => {
      const detail = (event as CustomEvent<{
        agentId?: string;
        tab?: AgentSettingsTab;
        userOnly?: boolean;
      }>).detail;
      if (detail?.agentId && detail.agentId !== activeAgentId) return;
      const userOnly = detail?.userOnly === true;
      setSettingsUserOnly(userOnly);
      setSettingsDefaultTab(detail?.tab || (userOnly ? "general" : "profile"));
      setSettingsOpen(true);
    };
    const openUserSettings = () => {
      setSettingsUserOnly(true);
      setSettingsDefaultTab("general");
      setSettingsOpen(true);
    };
    window.addEventListener("fastclaw:open-agent-settings", openAgentSettings);
    window.addEventListener("fastclaw:open-user-settings", openUserSettings);
    return () => {
      window.removeEventListener("fastclaw:open-agent-settings", openAgentSettings);
      window.removeEventListener("fastclaw:open-user-settings", openUserSettings);
    };
  }, [activeAgentId]);

  // Keep status polling so the online dot / admin flag stay fresh.
  React.useEffect(() => {
    getStatus().then(setStatus).catch(() => {});
    const iv = setInterval(() => {
      getStatus().then(setStatus).catch(() => {});
    }, 15000);
    return () => clearInterval(iv);
  }, []);

  // Keep the footer in sync with the current profile. Account settings live
  // inside a dialog, so saving them does not remount the sidebar.
  React.useEffect(() => {
    const refreshProfile = () => {
      getMe().then(setMe).catch(() => {});
    };
    refreshProfile();
    window.addEventListener("fastclaw:user-profile-changed", refreshProfile);
    return () => {
      window.removeEventListener("fastclaw:user-profile-changed", refreshProfile);
    };
  }, []);

  // Agent list drives the switcher dropdown at the top of the sidebar.
  React.useEffect(() => {
    getAgents()
      .then((list) => {
        rememberAgentAccess(list.map((agent) => agent.id));
        setAgents(
          list.map((a) => ({
            id: a.id,
            name: a.name,
            model: a.model,
            description: a.description,
            avatarUrl: a.avatarUrl,
          })),
        );
        const roles: Record<string, "owner" | "viewer"> = {};
        for (const a of list) {
          roles[a.id] = a.role === "viewer" ? "viewer" : "owner";
        }
        setAgentRoles(roles);
      })
      .catch(() => {});
  }, []);

  // The conversation-first sidebar is a Bot switcher, not a list of
  // database sessions. Enrich each visible Bot with its most recent chat so
  // the row can show a useful preview and resume where the user left off.
  React.useEffect(() => {
    if (agents.length === 0) {
      setConsumerAgents([]);
      return;
    }

    let aborted = false;
    setConsumerAgentsLoading(true);
    const refresh = () => {
      Promise.all(
        agents.map(async (agent) => {
          const list = await getChatSessions(agent.id).catch(() => []);
          // Group-member sessions use their team id as a hidden project
          // scope. They belong to the group row, not the Agent's direct
          // contact row; otherwise creating a group would make clicking an
          // Agent unexpectedly reopen its private group transcript.
          const latest = list.filter((session) => !session.projectId?.startsWith("tm-")).sort(
            (a, b) =>
              (b.lastMessageAt || b.updatedAt || b.createdAt || 0) -
              (a.lastMessageAt || a.updatedAt || a.createdAt || 0),
          )[0];
          return {
            id: agent.id,
            name: agent.name || agent.id,
            description: agent.description,
            avatarUrl: agent.avatarUrl,
            preview: latest?.lastMessage || latest?.preview,
            updatedAt: latest?.lastMessageAt || latest?.updatedAt || latest?.createdAt,
            sessionId: latest?.id,
          } satisfies ConsumerAgentItem;
        }),
      )
        .then((items) => {
          if (!aborted) {
            setConsumerAgents(
              [...items].sort(
                (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
              ),
            );
            setConsumerAgentsLoading(false);
          }
        })
        .catch(() => {
          if (!aborted) {
            setConsumerAgents(
              agents.map((agent) => ({
                id: agent.id,
                name: agent.name || agent.id,
                description: agent.description,
                avatarUrl: agent.avatarUrl,
              })),
            );
            setConsumerAgentsLoading(false);
          }
        });
    };

    refresh();
    window.addEventListener("fastclaw:sessions-changed", refresh);
    return () => {
      aborted = true;
      window.removeEventListener("fastclaw:sessions-changed", refresh);
    };
  }, [agents]);

  React.useEffect(() => {
    let aborted = false;
    const refreshTeams = () => {
      getConfig("user")
        .then((cfg) => {
          if (aborted) return;
          const items = Object.entries(cfg.teams || {}).map(([id, team]) => ({
            id,
            ...team,
            name: team.name?.trim() || tr("Group chat", "群聊"),
          }));
          setConsumerTeams(items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
        })
        .catch(() => {
          if (!aborted) setConsumerTeams([]);
        });
    };
    refreshTeams();
    window.addEventListener("fastclaw:teams-changed", refreshTeams);
    return () => {
      aborted = true;
      window.removeEventListener("fastclaw:teams-changed", refreshTeams);
    };
  }, [tr]);

  // When the active agent isn't in the caller's owned list — e.g. a
  // super_admin chatting with another user's agent — fetch its name
  // separately and splice it in so the switcher header shows the real
  // name instead of falling back to "FastClaw". The single-agent
  // endpoint also returns role, so capture it here too.
  React.useEffect(() => {
    if (!activeAgentId) return;
    if (agents.some((a) => a.id === activeAgentId)) return;
    let aborted = false;
    getAgent(activeAgentId)
      .then((a) => {
        if (aborted || !a) return;
        rememberAgentAccess(a.id);
        setAgents((prev) =>
          prev.some((x) => x.id === a.id)
            ? prev
            : [
                { id: a.id, name: a.name, model: a.model, description: a.description, avatarUrl: a.avatarUrl },
                ...prev,
              ],
        );
        if (a.role === "viewer" || a.role === "owner") {
          setAgentRoles((prev) => ({ ...prev, [a.id]: a.role as "owner" | "viewer" }));
        }
      })
      .catch(() => {});
    return () => {
      aborted = true;
    };
  }, [activeAgentId, agents]);



  const isAdmin = status?.isAdmin ?? false;
  const localizeNavItems = React.useCallback(
    (items: NavItem[]) =>
      items.map((item) => ({
        ...item,
        title: tr(
          item.title,
          ({
            Overview: "概览",
            Agents: "Agent",
            Models: "模型",
            Skills: "技能",
            Tools: "工具",
            Users: "用户",
            Chats: "聊天记录",
            "Token Usage": "Token 用量",
            "API Keys": "API 密钥",
            Apps: "应用",
            About: "关于",
            "New chat": "新建对话",
          } as Record<string, string>)[item.title] || item.title,
        ),
      })),
    [tr],
  );

  const isConsumerChat =
    (!!activeAgentId && /^\/agents\/[^/]+\/(chat|project|chats|team)(?:\/|$)/.test(pathname)) ||
    /^\/teams\/[^/]+\/chat\/[^/]+(?:\/|$)/.test(pathname);

  if (isConsumerChat) {
    return (
      <>
        <ConsumerChatSidebar
          activeAgentId={activeAgentId || undefined}
          activeTeamId={activeTeamId || undefined}
          agents={consumerAgents}
          teams={consumerTeams}
          loading={consumerAgentsLoading}
          me={me}
        />
        <AgentSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          defaultTab={settingsDefaultTab}
          role={activeAgentId && agentRoles[activeAgentId] === "viewer" ? "viewer" : "owner"}
          userOnly={settingsUserOnly || !activeAgentId}
        />
      </>
    );
  }

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarTitle
          title={isAdminRoute(pathname) ? tr("Admin", "管理后台") : tr("Console", "控制台")}
        />
      </SidebarHeader>
      <SidebarContent>
        {/* Console agent pages (/console/agents/<id>/…) keep the console
            nav, with Agents highlighted. */}
        {isAdminRoute(pathname) ? (
          <NavMain items={localizeNavItems(ADMIN_NAV)} />
        ) : (
          <NavMain items={localizeNavItems(consoleNav(pathname))} />
        )}
      </SidebarContent>
      {/* The account lives in the AppRail on desktop; the rail is hidden on
          mobile, so the sheet keeps it there. */}
      <SidebarFooter className="md:hidden">
        <NavUser
          name={
            me?.user?.displayName ||
            me?.user?.username ||
            t("common.user")
          }
          subtitle={me?.user?.role || (isAdmin ? "super_admin" : "user")}
        />
      </SidebarFooter>
      <SidebarRail />
      <AgentSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        defaultTab={settingsDefaultTab}
        userOnly={settingsUserOnly}
        role={
          activeAgentId && agentRoles[activeAgentId] === "viewer"
            ? "viewer"
            : "owner"
        }
      />
    </Sidebar>
  );
}
