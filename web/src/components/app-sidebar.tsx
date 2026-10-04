"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { AgentSwitcher, AgentSwitcherItem } from "@/components/team-switcher";
import { NavMain, NavItem } from "@/components/nav-main";
import { NavSessions, SessionItem } from "@/components/nav-projects";
import { NavProjectsList } from "@/components/nav-projects-list";
import { NavUser } from "@/components/nav-user";
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
  PlusIcon,
  SettingsIcon,
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
  listProjects,
  type MeResponse,
  type ProjectEntry,
  type StatusResponse,
} from "@/lib/api";
import { useLocale } from "@/components/locale-provider";
import { rememberAgentAccess } from "@/lib/agent-access-cache";

// Extract agent ID from pathname like /agents/default/chat/ or an Agent's
// console page like /console/agents/default/skills/. The second capture is
// an explicit allow-list of sub-routes so the Agent list keeps the Platform
// nav instead of flipping to Agent nav.
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

// "New chat" is active iff we're parked on the bare /chat/ page with
// no session open. A session can be encoded two ways:
//   - `?session=<id>` query param on `/chat/`
//   - path segment: `/chat/<sessionId>/`
// Either form means a specific session is open, so the New chat entry
// must NOT light up. We check the exact pathname (rather than
// startsWith) so the path-segment form falls through.
//
// Configuration tabs (Customize / Models / Skills / Channels /
// Scheduler) live in the footer Settings dialog — for owners only —
// so the sidebar nav itself just exposes "New chat" regardless of role.
const AGENT_NAV = (
  agentId: string,
  pathname: string,
  hasSession: boolean,
): NavItem[] => {
  const base = `/agents/${agentId}/chat`;
  const onNewChatRoute = pathname === base || pathname === `${base}/`;
  return [
    {
      title: "New chat",
      url: `${base}/`,
      icon: PlusIcon,
      active: onNewChatRoute && !hasSession,
    },
  ];
};

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { t, tr } = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeAgentId = extractAgentId(pathname);
  const activeTeamId = extractTeamId(pathname);
  const hasOpenSession = !!searchParams?.get("session");

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
  const [sessions, setSessions] = React.useState<SessionItem[]>([]);
  const [projects, setProjects] = React.useState<ProjectEntry[]>([]);
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

  // Sessions + projects only matter while a specific agent is selected.
  // We re-run both whenever the active agent changes *or* the chat page
  // broadcasts a `fastclaw:sessions-changed` event (e.g. after rename /
  // new chat / project create) so the sidebar stays in sync without a
  // page refresh. Projects are bundled with sessions because creating a
  // chat in a project also affects which sessions appear under it.
  React.useEffect(() => {
    if (!activeAgentId) {
      setSessions([]);
      setProjects([]);
      return;
    }
    const refetch = () => {
      getChatSessions(activeAgentId)
        .then((list) =>
          setSessions(
            list.map((s) => ({
              id: s.id,
              title: s.title || s.preview || s.id,
              preview: s.preview,
              thumbnailUrl: s.thumbnailUrl,
              channel: s.channel,
              projectId: s.projectId,
              updatedAt: s.updatedAt,
            })),
          ),
        )
        .catch(() => {});
      listProjects(activeAgentId)
        .then(setProjects)
        .catch(() => {});
    };
    refetch();
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ agentId?: string }>).detail;
      if (!detail || !detail.agentId || detail.agentId === activeAgentId) {
        refetch();
      }
    };
    window.addEventListener("fastclaw:sessions-changed", onChange);
    return () => {
      window.removeEventListener("fastclaw:sessions-changed", onChange);
    };
  }, [activeAgentId]);

  // broadcastSessionsChanged fires the same custom event NavSessions
  // listens to, so a project mutation refreshes both the projects list
  // AND the sessions list (a new chat-in-project shows up under its
  // project, and the project's session count drives the delete-block).
  const broadcastSessionsChanged = React.useCallback(() => {
    if (typeof window !== "undefined" && activeAgentId) {
      window.dispatchEvent(
        new CustomEvent("fastclaw:sessions-changed", {
          detail: { agentId: activeAgentId },
        }),
      );
    }
  }, [activeAgentId]);

  const isAdmin = status?.isAdmin ?? false;
  // quotaLocked = caller has agent_quota=0 (admin-provisions-only,
  // typical single-agent customer model). The agent switcher header
  // is locked (static label, no "Manage agents" dropdown), but the
  // /agents page itself stays reachable so they can browse what's
  // been provisioned and jump into chat — it just hides the Create
  // button. So we keep the Agents nav entry visible.
  const quotaLocked = me?.user?.agentQuota === 0;
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
        <AgentSwitcher
          agents={agents}
          activeAgentId={activeAgentId}
          locked={
            quotaLocked ||
            (!!activeAgentId && agentRoles[activeAgentId] === "viewer")
          }
        />
      </SidebarHeader>
      <SidebarContent>
        {activeAgentId ? (
          <NavMain
            label={t("common.agent")}
            items={localizeNavItems(AGENT_NAV(activeAgentId, pathname, hasOpenSession))}
          />
        ) : isAdminRoute(pathname) ? (
          <NavMain items={localizeNavItems(ADMIN_NAV)} />
        ) : (
          <NavMain items={localizeNavItems(consoleNav(pathname))} />
        )}
        {/* Projects are per-(user, agent), so viewers on a shared agent
            see/create their OWN projects — the owner's projects stay
            private. The owner-only Settings dialog below is unaffected:
            project CRUD is read-write for whoever opened the agent, but
            agent configuration (skills, channels, models) stays the
            owner's. */}
        {activeAgentId && (
          <NavProjectsList
            agentId={activeAgentId}
            projects={projects}
            sessions={sessions}
            onChanged={broadcastSessionsChanged}
          />
        )}
        <NavSessions agentId={activeAgentId} sessions={sessions} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t("common.settings")}
              onClick={() => {
                setSettingsUserOnly(!activeAgentId);
                setSettingsDefaultTab(activeAgentId ? "profile" : "general");
                setSettingsOpen(true);
              }}
            >
              <SettingsIcon />
              <span>{t("common.settings")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <NavUser
          name={
            me?.user?.displayName ||
            me?.user?.username ||
            t("common.user")
          }
          subtitle={me?.user?.role || (isAdmin ? "super_admin" : "user")}
          isAdmin={isAdmin}
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
