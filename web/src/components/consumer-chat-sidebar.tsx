"use client";

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import { Bot, Check, ChevronDown, ChevronsLeft, ChevronsRight, ImagePlus, Plus, Search, UsersRound } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BotAvatar } from "@/components/bot-avatar";
import { TeamAvatarStack } from "@/components/team-avatar-stack";
import { NavUser } from "@/components/nav-user";
import { SidebarTitle } from "@/components/sidebar-title";
import { useLocale, type Locale } from "@/components/locale-provider";
import { apiFetch, createAgent, updateConfig, getTeamInbox, type TeamInboxNotice, type MeResponse, type TeamEntry } from "@/lib/api";
import { rememberAgentAccess } from "@/lib/agent-access-cache";

export interface ConsumerAgentItem {
  id: string;
  name: string;
  description?: string;
  preview?: string;
  avatarUrl?: string;
  sessionId?: string;
  updatedAt?: number;
}

export interface ConsumerTeamItem extends TeamEntry {
  id: string;
  name: string;
}

const AGENT_PAGE_SIZE = 20;
const INLINE_MARKDOWN_TOKEN = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|~~[^~\n]+?~~|`[^`\n]+?`|\[[^\]\n]+?\]\([^)]+\)|\*[^*\n]+?\*|_[^_\n]+?_)/g;

// Sidebar summaries are deliberately one line, so a full block Markdown
// renderer would introduce invalid nested controls and list/table layout.
// Render the inline subset descriptions and message previews actually use,
// preserving emphasis while keeping links non-interactive inside the row.
function renderInlineMarkdown(text: string, keyPrefix = "md"): React.ReactNode[] {
  const normalized = text.replace(/\s*\n+\s*/g, " ").trim();
  return normalized
    .split(INLINE_MARKDOWN_TOKEN)
    .filter(Boolean)
    .map((part, index) => {
      const key = `${keyPrefix}-${index}`;
      if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
        return <strong key={key}>{renderInlineMarkdown(part.slice(2, -2), key)}</strong>;
      }
      if (part.startsWith("~~") && part.endsWith("~~")) {
        return <del key={key}>{renderInlineMarkdown(part.slice(2, -2), key)}</del>;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return <code key={key} className="rounded bg-black/[0.05] px-0.5 font-mono text-[0.92em] dark:bg-white/[0.08]">{part.slice(1, -1)}</code>;
      }
      const link = /^\[([^\]]+)\]\([^)]+\)$/.exec(part);
      if (link) {
        return <span key={key} className="underline decoration-current/35 underline-offset-2">{renderInlineMarkdown(link[1], key)}</span>;
      }
      if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) {
        return <em key={key}>{renderInlineMarkdown(part.slice(1, -1), key)}</em>;
      }
      return <React.Fragment key={key}>{part}</React.Fragment>;
    });
}

function relativeSessionTime(updatedAt: number | undefined, locale: Locale) {
  if (!updatedAt) return "";
  const date = new Date(updatedAt);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return locale === "zh-CN" ? "昨天" : "Yesterday";
  }
  return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

export function ConsumerChatSidebar({
  activeAgentId,
  activeTeamId,
  agents,
  teams = [],
  loading = false,
  me,
}: {
  activeAgentId?: string;
  activeTeamId?: string;
  agents: ConsumerAgentItem[];
  teams?: ConsumerTeamItem[];
  loading?: boolean;
  me: MeResponse | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [inbox, setInbox] = React.useState<TeamInboxNotice[]>([]);
  React.useEffect(() => {
    const uid = me?.user?.id;
    if (!uid) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const { messages } = await getTeamInbox();
        if (cancelled) return;
        const unread = (messages || []).filter((notice) => {
          const key = `fastclaw:group-inbox-read:${uid}:${notice.agentId}:${notice.sessionId}`;
          if (pathname === `/agents/${encodeURIComponent(notice.agentId)}/chat/${encodeURIComponent(notice.sessionId)}/`) {
            localStorage.setItem(key, String(Math.max(Number(localStorage.getItem(key) || 0), notice.timestamp)));
            return false;
          }
          return notice.timestamp > Number(localStorage.getItem(key) || 0);
        });
        setInbox(unread);
      } catch { /* Retry on the next poll. */ }
      finally { if (!cancelled) timer = setTimeout(refresh, 3000); }
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [me?.user?.id, pathname]);
  const { state: sidebarState, toggleSidebar } = useSidebar();
  const { locale, t, tr } = useLocale();
  const [query, setQuery] = React.useState("");
  const [visibleCount, setVisibleCount] = React.useState(AGENT_PAGE_SIZE);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createTeamOpen, setCreateTeamOpen] = React.useState(false);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return agents;
    return agents.filter((agent) =>
      `${agent.name} ${agent.description || ""} ${agent.preview || ""}`.toLocaleLowerCase().includes(q),
    );
  }, [query, agents]);
  const visibleAgents = React.useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );
  const hasMoreAgents = visibleAgents.length < filtered.length;
  const filteredTeams = React.useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return teams;
    return teams.filter((team) => {
      const memberNames = team.agents
        .map((id) => agents.find((agent) => agent.id === id)?.name || id)
        .join(" ");
      return `${team.name} ${memberNames}`.toLocaleLowerCase().includes(q);
    });
  }, [agents, query, teams]);

  const openAgent = (agent: ConsumerAgentItem) => {
    const base = `/agents/${encodeURIComponent(agent.id)}/chat/`;
    const latestPrivate = inbox.filter((notice) => notice.agentId === agent.id).sort((a, b) => b.timestamp - a.timestamp)[0];
    const sessionId = latestPrivate?.sessionId || agent.sessionId;
    const target = sessionId ? `${base}${encodeURIComponent(sessionId)}/` : base;
    // This row came from the caller's authenticated agent list, so the access
    // gate can safely keep the current shell visible during the route swap.
    rememberAgentAccess(agent.id);
    // Dynamic agent ids are served through the static-export fallback. A
    // router navigation can remount that fallback and briefly replace the
    // persistent Bot list with its loading state. Next patches pushState into
    // its reactive router, so this swaps only the active conversation while
    // the left list stays mounted and visually stable.
    window.history.pushState(null, "", target);
  };

  const openTeam = (team: ConsumerTeamItem) => {
    const sessionId = team.sessionId || `team-${team.id}`;
    rememberAgentAccess(team.agents);
    window.history.pushState(null, "", `/teams/${encodeURIComponent(team.id)}/chat/${encodeURIComponent(sessionId)}/`);
  };

  return (
    <>
      <Sidebar
        collapsible="icon"
        className="border-r border-black/8 bg-[#f7f7f7] dark:border-white/8 dark:bg-[#171717]"
      >
      {/* Same header box as the Console / Admin sidebars (SidebarHeader's
          p-2 + SidebarTitle), with the search row below. */}
      <SidebarHeader className="pb-5 group-data-[collapsible=icon]:pb-2">
        <SidebarTitle
          title={tr("Chat", "对话")}
          className="group-data-[collapsible=icon]:justify-center"
        >
          <button
            type="button"
            onClick={toggleSidebar}
            className="group/sidebar-toggle relative ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:ml-0 group-data-[collapsible=icon]:size-10 dark:hover:bg-white/8"
            aria-label={sidebarState === "collapsed" ? t("sidebar.expandContacts") : t("sidebar.collapseContacts")}
            title={sidebarState === "collapsed" ? t("sidebar.expandContacts") : t("sidebar.collapseContacts")}
          >
            {sidebarState === "collapsed" ? (
              <ChevronsRight className="size-4" />
            ) : (
              <ChevronsLeft className="size-4" />
            )}
          </button>
        </SidebarTitle>
        <div className="flex items-center gap-1.5 group-data-[collapsible=icon]:hidden">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-[15px] -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(AGENT_PAGE_SIZE);
              }}
              placeholder={t("sidebar.searchBots")}
              aria-label={t("sidebar.searchBots")}
              className="h-8 w-full rounded-md border border-black/7 bg-black/[0.035] pl-8 pr-2.5 text-sm outline-none transition focus:border-black/15 focus:bg-white focus:ring-2 focus:ring-black/5 dark:border-white/8 dark:bg-white/[0.055] dark:focus:border-white/15 dark:focus:bg-white/[0.08]"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/8"
                  aria-label={tr("Create", "新建")}
                  title={tr("Create", "新建")}
                >
                  <Plus className="size-4" />
                </button>
              }
            />
            <DropdownMenuContent align="end" sideOffset={7} className="w-52 rounded-xl p-1.5">
              <DropdownMenuItem onClick={() => setCreateOpen(true)} className="h-10 gap-2 rounded-lg px-2.5">
                <Bot className="size-4" />
                {t("sidebar.createBot")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCreateTeamOpen(true)} className="h-10 gap-2 rounded-lg px-2.5">
                <UsersRound className="size-4" />
                {tr("Create group chat", "创建群聊")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </SidebarHeader>

      <SidebarContent
        aria-busy={loading}
        className="px-1.5 pb-3 group-data-[collapsible=icon]:overflow-x-hidden! group-data-[collapsible=icon]:overflow-y-auto! group-data-[collapsible=icon]:px-2"
      >
        <SidebarMenu className="gap-1 group-data-[collapsible=icon]:gap-2">
          {loading && filtered.length === 0 && (
            <>
              {[0, 1, 2].map((item) => (
                <SidebarMenuItem key={`agent-loading-${item}`}>
                  <div className="flex h-[58px] items-center gap-3 rounded-lg px-2.5 py-2 group-data-[collapsible=icon]:size-12! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-xl group-data-[collapsible=icon]:p-[7px]!">
                    <div className="size-[34px] shrink-0 animate-pulse rounded-full bg-black/[0.075] motion-reduce:animate-none dark:bg-white/[0.1]" />
                    <div className="min-w-0 flex-1 space-y-2 group-data-[collapsible=icon]:hidden">
                      <div className="h-3 w-2/5 animate-pulse rounded-full bg-black/[0.08] motion-reduce:animate-none dark:bg-white/[0.11]" />
                      <div className="h-2.5 w-4/5 animate-pulse rounded-full bg-black/[0.055] motion-reduce:animate-none dark:bg-white/[0.075]" />
                    </div>
                  </div>
                </SidebarMenuItem>
              ))}
              <span className="sr-only" role="status">
                {tr("Loading Agents…", "正在加载 Agent…")}
              </span>
            </>
          )}
          {filteredTeams.map((team) => {
            const members = team.agents
              .map((id) => agents.find((agent) => agent.id === id))
              .filter((agent): agent is ConsumerAgentItem => !!agent);
            const memberLabel = members.map((member) => member.name).join("、");
            return (
              <SidebarMenuItem key={`team-${team.id}`}>
                <SidebarMenuButton
                  isActive={activeTeamId === team.id}
                  onClick={() => openTeam(team)}
                  tooltip={team.name}
                  className="h-[58px] gap-3 rounded-lg px-2.5 py-2 data-active:bg-[#e9e3ec] data-active:font-normal hover:bg-black/[0.05] group-data-[collapsible=icon]:size-12! group-data-[collapsible=icon]:rounded-xl group-data-[collapsible=icon]:p-[7px]! dark:data-active:bg-[#3a303d] dark:hover:bg-white/[0.07]"
                >
                  <TeamAvatarStack members={members} size={34} />
                  <span className="grid min-w-0 flex-1 gap-0.5 group-data-[collapsible=icon]:hidden">
                    <span className="flex min-w-0 items-baseline justify-between gap-2">
                      <span className="truncate text-[15px] font-semibold leading-5 text-foreground">
                        {team.name}
                      </span>
                      <span className="shrink-0 rounded-full bg-[#e8e1eb] px-1.5 py-0.5 text-[10px] font-semibold text-[#756878] dark:bg-white/10 dark:text-[#c9bdcc]">
                        {tr("Group", "群聊")}
                      </span>
                    </span>
                    <span className="truncate text-[13px] font-normal leading-5 text-muted-foreground">
                      {memberLabel || tr("No Agents", "暂无 Agent")}
                    </span>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
          {visibleAgents.map((agent) => {
            const active = !activeTeamId && activeAgentId === agent.id;
            const summary = agent.preview || agent.description || t("sidebar.greeting", { name: agent.name });
            return (
              <SidebarMenuItem key={agent.id}>
                <SidebarMenuButton
                  isActive={active}
                  onClick={() => openAgent(agent)}
                  tooltip={agent.name}
                  className="h-[58px] gap-3 rounded-lg px-2.5 py-2 data-active:bg-black/[0.075] data-active:font-normal hover:bg-black/[0.05] group-data-[collapsible=icon]:size-12! group-data-[collapsible=icon]:rounded-xl group-data-[collapsible=icon]:p-[7px]! dark:data-active:bg-white/[0.11] dark:hover:bg-white/[0.07]"
                >
                  <BotAvatar
                    agentId={agent.id}
                    avatarUrl={agent.avatarUrl}
                    seed={agent.id}
                    size={34}
                  />
                  <span className="grid min-w-0 flex-1 gap-0.5 group-data-[collapsible=icon]:hidden">
                    <span className="flex min-w-0 items-baseline justify-between gap-2">
                      <span className="truncate text-[15px] font-semibold leading-5 text-foreground">
                        {agent.name || t("sidebar.untitledBot")}
                        {inbox.some((notice) => notice.agentId === agent.id) && <span aria-label={tr("Unread private messages", "未读私信")} className="ml-2 inline-flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-4 text-white">{inbox.filter((notice) => notice.agentId === agent.id).length}</span>}
                      </span>
                      <span className="shrink-0 text-[11px] font-normal text-muted-foreground/80">
                        {relativeSessionTime(agent.updatedAt, locale)}
                      </span>
                    </span>
                    <span className="truncate text-[13px] font-normal leading-5 text-muted-foreground">
                      {renderInlineMarkdown(summary)}
                    </span>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
          {hasMoreAgents && (
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => setVisibleCount((count) => count + AGENT_PAGE_SIZE)}
                tooltip={t("sidebar.loadMore")}
                className="h-9 justify-center gap-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:bg-black/[0.05] hover:text-foreground group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:rounded-xl group-data-[collapsible=icon]:p-0! dark:hover:bg-white/[0.07]"
              >
                <ChevronDown className="size-3.5 shrink-0" />
                <span className="group-data-[collapsible=icon]:hidden">
                  {t("sidebar.loadMore")}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="mx-auto mt-2 hidden size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:flex dark:hover:bg-white/8"
                aria-label={tr("Create", "新建")}
                title={tr("Create", "新建")}
              >
                <Plus className="size-4" />
              </button>
            }
          />
          <DropdownMenuContent side="right" align="start" sideOffset={8} className="w-48 rounded-xl p-1.5">
            <DropdownMenuItem onClick={() => setCreateOpen(true)} className="h-9 gap-2 rounded-lg px-2.5">
              <Bot className="size-4" />
              {t("sidebar.createBot")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setCreateTeamOpen(true)} className="h-9 gap-2 rounded-lg px-2.5">
              <UsersRound className="size-4" />
              {tr("Create group chat", "创建群聊")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {!loading && filtered.length === 0 && filteredTeams.length === 0 && (
          <div className="mx-2 mt-4 rounded-lg border border-dashed border-black/10 px-4 py-8 text-center group-data-[collapsible=icon]:hidden dark:border-white/10">
            <p className="text-sm font-medium">
              {query ? t("sidebar.noMatches") : t("sidebar.noBots")}
            </p>
            <button
              type="button"
              onClick={() => router.push("/console/agents/")}
              className="mt-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {t("sidebar.manageBots")}
            </button>
          </div>
        )}
      </SidebarContent>

      {/* The account lives in the AppRail on desktop; the rail is hidden
          on mobile, so the sheet keeps it here. */}
      <SidebarFooter className="px-2 pb-3 pt-2 group-data-[collapsible=icon]:px-4 md:hidden">
        <NavUser
          name={me?.user?.displayName || me?.user?.username || tr("User", "用户")}
          subtitle={me?.user?.role || tr("user", "用户")}
        />
      </SidebarFooter>
      <SidebarRail toggleOnClick={false} />
      </Sidebar>
      <CreateBotDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(agentId) => {
          router.push(`/agents/${encodeURIComponent(agentId)}/chat/`);
        }}
      />
      <CreateTeamDialog
        open={createTeamOpen}
        onOpenChange={setCreateTeamOpen}
        agents={agents}
        onCreated={(team) => {
          window.dispatchEvent(new CustomEvent("fastclaw:teams-changed"));
          openTeam(team);
        }}
      />
    </>
  );
}

function CreateTeamDialog({
  open,
  onOpenChange,
  agents,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: ConsumerAgentItem[];
  onCreated: (team: ConsumerTeamItem) => void;
}) {
  const { tr } = useLocale();
  const [name, setName] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  const reset = () => {
    setName("");
    setQuery("");
    setSelected([]);
    setSaving(false);
    setError("");
  };
  const close = () => {
    onOpenChange(false);
    reset();
  };
  const visibleAgents = agents.filter((agent) =>
    `${agent.name} ${agent.description || ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

  const createTeam = async () => {
    const teamName = name.trim();
    if (!teamName || selected.length < 2 || saving) return;
    setSaving(true);
    setError("");
    const id = `tm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const sessionId = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const entry: TeamEntry = {
      name: teamName,
      agents: selected,
      defaultAgent: selected[0],
      sessionId,
      groupBehavior: "coordinated",
      createdAt: Date.now(),
    };
    try {
      const response = await updateConfig({ teams: { [id]: entry } }, "user");
      if (!response?.ok) {
        setError(response?.error || tr("Failed to create group chat", "创建群聊失败"));
        return;
      }
      close();
      onCreated({ id, ...entry, name: teamName });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("Failed to create group chat", "创建群聊失败"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{tr("Create group chat", "创建群聊")}</DialogTitle>
          <DialogDescription>
            {tr(
              "Choose at least two Agents. Mention one by name, or use @all when everyone should answer.",
              "选择至少两个 Agent。对话中可以 @某个 Agent，或用 @all 让所有成员回复。",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-2">
            <Label htmlFor="team-name">{tr("Group name", "群聊名称")}</Label>
            <Input
              id="team-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
              placeholder={tr("Launch crew", "项目讨论组")}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="team-agent-search">{tr("Members", "群成员")}</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="team-agent-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={tr("Search Agents", "搜索 Agent")}
                className="pl-9"
              />
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border p-1.5">
              {visibleAgents.map((agent) => {
                const checked = selected.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => {
                      setSelected((current) => checked
                        ? current.filter((id) => id !== agent.id)
                        : [...current, agent.id]);
                      setError("");
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition ${
                      checked ? "bg-[#eee9f0] dark:bg-[#342d36]" : "hover:bg-muted/70"
                    }`}
                  >
                    <BotAvatar agentId={agent.id} avatarUrl={agent.avatarUrl} seed={agent.id} size={34} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{agent.name}</span>
                      {agent.description && (
                        <span className="block truncate text-xs text-muted-foreground">{renderInlineMarkdown(agent.description, `team-${agent.id}`)}</span>
                      )}
                    </span>
                    <span className={`flex size-5 items-center justify-center rounded-full border transition ${
                      checked
                        ? "border-[#79677f] bg-[#79677f] text-white"
                        : "border-border text-transparent"
                    }`}>
                      <Check className="size-3" />
                    </span>
                  </button>
                );
              })}
              {visibleAgents.length === 0 && (
                <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {tr("No matching Agents", "没有匹配的 Agent")}
                </p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {tr("{{count}} selected", "已选择 {{count}} 个", { count: selected.length })}
            </p>
          </div>
          {agents.length < 2 && (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {tr("Create at least two Agents before starting a group chat.", "至少创建两个 Agent 后才能发起群聊。")}
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            {tr("Cancel", "取消")}
          </Button>
          <Button
            type="button"
            onClick={() => void createTeam()}
            disabled={!name.trim() || selected.length < 2 || saving}
          >
            {saving ? tr("Creating…", "正在创建…") : tr("Create group", "创建群聊")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateBotDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agentId: string) => void;
}) {
  const { t } = useLocale();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [avatar, setAvatar] = React.useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const avatarInput = React.useRef<HTMLInputElement>(null);

  const reset = () => {
    setName("");
    setDescription("");
    setAvatar(null);
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    setAvatarPreview(null);
    setError("");
    setSaving(false);
  };

  const close = () => {
    onOpenChange(false);
    reset();
  };

  const handleCreate = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || saving) return;
    setSaving(true);
    setError("");

    try {
      const response = await createAgent({
        name: trimmedName,
        description: description.trim() || undefined,
      });
      if (!response || response.ok === false || response.error) {
        setError(response?.error || t("createBot.failed"));
        return;
      }

      const agentId = response.agent?.id as string | undefined;
      if (!agentId) {
        setError(t("createBot.missingId"));
        return;
      }

      if (avatar) {
        const form = new FormData();
        form.append("file", avatar, "avatar.png");
        await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/files`, {
          method: "POST",
          body: form,
        }).catch(() => null);
      }

      close();
      onCreated(agentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("createBot.failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("createBot.title")}</DialogTitle>
          <DialogDescription>
            {t("createBot.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-start gap-4">
            <button
              type="button"
              onClick={() => avatarInput.current?.click()}
              className="group relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-dashed bg-muted/40 transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("createBot.uploadAvatar")}
            >
              {avatarPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarPreview} alt={t("createBot.avatarAlt")} className="size-full object-cover" />
              ) : (
                <ImagePlus className="size-6 text-muted-foreground" />
              )}
              <input
                ref={avatarInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0] || null;
                  setAvatar(file);
                  if (avatarPreview) URL.revokeObjectURL(avatarPreview);
                  setAvatarPreview(file ? URL.createObjectURL(file) : null);
                }}
              />
            </button>
            <div className="min-w-0 flex-1 space-y-2">
              <Label htmlFor="new-bot-name">{t("createBot.name")}</Label>
              <Input
                id="new-bot-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError("");
                }}
                placeholder={t("createBot.namePlaceholder")}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void handleCreate();
                  }
                }}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-bot-description">{t("createBot.descriptionLabel")}</Label>
            <Textarea
              id="new-bot-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("createBot.descriptionPlaceholder")}
              rows={3}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={() => void handleCreate()} disabled={!name.trim() || saving}>
            {saving ? t("createBot.creating") : t("createBot.title")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
