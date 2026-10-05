"use client";
/* eslint-disable @next/next/no-img-element -- User image attachments include local data URLs. */

import * as React from "react";
import { usePathname } from "next/navigation";
import { ArrowUp, Check, ChevronsRight, LoaderCircle, PanelRight, Plus, Square, UsersRound, Settings, Paperclip, X, MoreHorizontal, Pencil, Trash2, Crown } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { ChatMarkdown } from "@/components/chat-markdown";
import { TeamSettingsDialog } from "@/components/team-settings-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TeamAvatarStack } from "@/components/team-avatar-stack";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useLocale } from "@/components/locale-provider";
import { teamProgressLabel } from "@/lib/team-progress";
import { usePageHeader } from "@/components/sidebar";
import {
  getAgents,
  getChatHistory,
  getConfig,
  getTeamRun,
  getTeamTopics,
  startTeamRun,
  stopTeamRun,
  updateConfig,
  renameTeamTopic,
  deleteTeamTopic,
  type TeamRun,
  type TeamTopic,
  type TeamMessage,
  type AgentDetail,
  type ChatHistoryMessage,
  type TeamEntry,
} from "@/lib/api";

function parseTeamRoute(pathname: string) {
  const route = pathname.match(/^\/teams\/([^/]+)\/chat\/([^/]+)/);
  if (route) {
    return {
      teamId: decodeURIComponent(route[1]),
      sessionId: decodeURIComponent(route[2]),
    };
  }
  // Keep previously shared URLs usable while all new navigation uses the
  // team-first route. Legacy groups had one deterministic conversation.
  const legacy = pathname.match(/^\/agents\/[^/]+\/team\/([^/]+)/);
  const teamId = legacy ? decodeURIComponent(legacy[1]) : "";
  return { teamId, sessionId: teamId ? `team-${teamId}` : "" };
}

function memberSessionId(sessionId: string, agentId: string) {
  return `${sessionId}-agent-${agentId}`;
}

function normalizeTeamContent(value: string, agentReply = false) {
  if (!agentReply) return value.trim();
  // Also cover legacy history and an unfinished streaming delimiter. User
  // messages and fenced code are literal content, not the group protocol.
  let fence = "";
  let inlineCode = "";
  const lines = value.split("\n");
  return lines.map((line, index) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      return line;
    }
    if (fence) return line;
    let text = line.replace(/`+|<\|split\|>/g, (token) => {
      if (token.startsWith("`")) {
        if (!inlineCode) inlineCode = token;
        else if (inlineCode === token) inlineCode = "";
        return token;
      }
      return inlineCode ? token : "\n\n";
    });
    if (!inlineCode && index === lines.length - 1) {
      const separator = "<|split|>";
      for (let length = separator.length - 1; length > 0; length--) {
        if (text.endsWith(separator.slice(0, length))) {
          text = text.slice(0, -length);
          break;
        }
      }
    }
    return text;
  }).join("\n").trim();
}

function mergeTeamHistory(
  histories: Array<{ agentId: string; history: ChatHistoryMessage[] }>,
  members: AgentDetail[],
): TeamMessage[] {
  const memberNames = new Set(members.map((member) => (member.name || member.id).toLocaleLowerCase()));
  const merged: Array<TeamMessage & { fallbackOrder: number }> = [];
  let fallbackOrder = 0;

  for (const { agentId, history } of histories) {
    for (const item of history) {
      const content = normalizeTeamContent(item.content || "", item.role === "assistant");
      if (!content) continue;
      // Bot-to-bot context is stored as a user-role message in the target
      // Agent session. The originating Agent already has its own visible
      // assistant bubble, so don't render the injected copy again.
      if (item.role === "user" && item.senderName) {
        const sender = item.senderName.toLocaleLowerCase();
        if (memberNames.has(sender) || sender === "user") continue;
      }
      if (item.role !== "user" && item.role !== "assistant") continue;
      merged.push({
        id: `history-${agentId}-${fallbackOrder}`,
        role: item.role === "user" ? "user" : "agent",
        content,
        timestamp: item.timestamp || 0,
        agentId: item.role === "assistant" ? agentId : undefined,
        groupTurnId: item.groupTurnId,
        fallbackOrder: fallbackOrder++,
      });
    }
  }

  merged.sort((a, b) => {
    if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.timestamp !== b.timestamp) return a.timestamp ? -1 : 1;
    return a.fallbackOrder - b.fallbackOrder;
  });

  const seenUsers = new Set<string>();
  return merged
    .filter((message) => {
      if (message.role !== "user") return true;
      const timeBucket = message.timestamp ? Math.floor(message.timestamp / 5000) : message.fallbackOrder;
      const key = message.groupTurnId || `${timeBucket}:${message.content}`;
      if (seenUsers.has(key)) return false;
      seenUsers.add(key);
      return true;
    })
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      agentId: message.agentId,
      groupTurnId: message.groupTurnId,
    }));
}

export function TeamChatScreen() {
  const pathname = usePathname() || "";
  const { teamId, sessionId } = React.useMemo(() => parseTeamRoute(pathname), [pathname]);
  // null follows the original desktop panel/mobile drawer layout. Keep the
  // user's panel choice while the keyed topic view changes.
  const [panelOpen, setPanelOpen] = React.useState<boolean | null>(null);
  if (!teamId || !sessionId) return null;
  // The server owns execution; a keyed view owns only this topic's UI.
  return <TeamConversation key={`${teamId}/${sessionId}`} teamId={teamId} sessionId={sessionId}
    panelOpen={panelOpen} onPanelChange={setPanelOpen} />;
}

function TeamConversation({ teamId, sessionId, panelOpen, onPanelChange }: {
  teamId: string;
  sessionId: string;
  panelOpen: boolean | null;
  onPanelChange: (open: boolean) => void;
}) {
  const { tr } = useLocale();
  const [team, setTeam] = React.useState<TeamEntry | null>(null);
  const [members, setMembers] = React.useState<AgentDetail[]>([]);
  const [addMembersOpen, setAddMembersOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [topicEdit, setTopicEdit] = React.useState<{ topic: TeamTopic; remove: boolean } | null>(null);
  const [topicTitle, setTopicTitle] = React.useState("");
  const [topicSaving, setTopicSaving] = React.useState(false);
  const [images, setImages] = React.useState<string[]>([]);
  const [attachments, setAttachments] = React.useState<Array<{ url: string; name: string }>>([]);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [caret, setCaret] = React.useState(0);
  const [mentionIndex, setMentionIndex] = React.useState(0);
  const [mentionDismissed, setMentionDismissed] = React.useState(false);
  const [history, setHistory] = React.useState<TeamMessage[]>([]);
  const [run, setRun] = React.useState<TeamRun | null>(null);
  const runRef = React.useRef<TeamRun | null>(null);
  const adoptRun = React.useCallback((next: TeamRun | null) => {
    const previous = runRef.current;
    if (next?.completeHistory) setHistory([]);
    else if (previous?.turnId && previous.turnId !== next?.turnId) {
      setHistory((current) => [
        ...current.filter((message) => message.groupTurnId !== previous.turnId),
        ...previous.messages,
      ]);
    }
    runRef.current = next;
    setRun(next);
  }, []);
  const [topics, setTopics] = React.useState<TeamTopic[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [loadError, setLoadError] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const [connectionError, setConnectionError] = React.useState(false);
  const submitRef = React.useRef(false);
  const generationRef = React.useRef(0);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stickToBottom = React.useRef(true);
  const sending = submitting || run?.status === "running" || !!run?.activeAgents.length;
  const messages = React.useMemo(() => [
    ...(run?.completeHistory ? [] : history.filter((message) => !run?.turnId || message.groupTurnId !== run.turnId)),
    ...(run?.messages || []),
  ], [history, run]);

  const replaceDeletedTopic = React.useCallback((available: TeamTopic[]) => {
    const nextId = available.find((topic) => topic.sessionId !== sessionId)?.sessionId
      || `team-${teamId}-topic-${crypto.randomUUID()}`;
    // Group contacts and old bookmarks may still point at the deleted default
    // topic. Replace that URL so Back cannot lead straight into the tombstone.
    window.history.replaceState(null, "", `/teams/${encodeURIComponent(teamId)}/chat/${encodeURIComponent(nextId)}/`);
  }, [teamId, sessionId]);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([getConfig("user"), getAgents()])
      .then(async ([config, agents]) => {
        if (cancelled) return;
        const nextTeam = config.teams?.[teamId];
        if (!nextTeam) throw new Error(tr("This group chat no longer exists.", "这个群聊不存在或已被删除。"));
        const byId = new Map(agents.map((agent) => [agent.id, agent]));
        const nextMembers = nextTeam.agents.map((id) => byId.get(id)).filter((agent): agent is AgentDetail => !!agent);
        if (!nextMembers.length) throw new Error(tr("No accessible Agents remain in this group.", "这个群聊中已没有可访问的 Agent。"));
        setTeam(nextTeam);
        setMembers(nextMembers);
        const { run: current, deleted } = await getTeamRun(teamId, sessionId);
        if (cancelled) return;
        if (deleted) {
          const available = await getTeamTopics(teamId);
          if (!cancelled) replaceDeletedTopic(available.topics);
          return;
        }
        if (!current?.completeHistory) {
          const histories = await Promise.all(nextMembers.map(async (member) => ({ agentId: member.id,
            history: await getChatHistory(member.id, memberSessionId(sessionId, member.id)),
          })));
          if (cancelled) return;
          setHistory(mergeTeamHistory(histories, nextMembers));
        }
        adoptRun(current);
      })
      .catch((cause) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, teamId, tr, adoptRun, replaceDeletedTopic]);

  React.useEffect(() => {
    if (loading || loadError) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const generation = generationRef.current;
      try {
        const [next, current] = await Promise.all([getTeamTopics(teamId), getTeamRun(teamId, sessionId)]);
        if (cancelled || submitRef.current || generation !== generationRef.current) return;
        if (current.deleted) {
          replaceDeletedTopic(next.topics);
          return;
        }
        setTopics(next.topics);
        adoptRun(current.run);
        setConnectionError(false);
      } catch { if (!cancelled) setConnectionError(true); }
      finally { if (!cancelled) timer = setTimeout(poll, 800); }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [loading, loadError, sessionId, teamId, adoptRun, replaceDeletedTopic]);

  React.useEffect(() => {
    const area = textareaRef.current;
    if (!area) return;
    area.style.height = "32px";
    area.style.height = `${Math.min(area.scrollHeight, 180)}px`;
  }, [input]);

  React.useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    if (stickToBottom.current) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, sending]);

  const teamName = team?.name?.trim() || tr("Group chat", "群聊");
  const header = React.useMemo(
    () => (
      <div className="flex h-full min-w-0 flex-1 items-center gap-3 px-4 md:px-5">
        <TeamAvatarStack members={members} size={30} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{teamName}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {tr("{{count}} Agents", "{{count}} 个 Agent", { count: members.length })}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="ml-auto size-8 text-muted-foreground"
          aria-label={tr("Toggle members and recent sessions", "展开或收起群成员和最近会话")}
          onClick={() => onPanelChange(!(panelOpen ?? window.matchMedia("(min-width: 1280px)").matches))}>
          <PanelRight className="size-4" />
        </Button>
      </div>
    ),
    [members, teamName, tr, panelOpen, onPanelChange],
  );
  usePageHeader(header, [header]);

  const send = async () => {
    const text = input.trim();
    if ((!text && !images.length && !attachments.length) || sending || submitRef.current || !team) return;
    submitRef.current = true;
    generationRef.current++;
    setSubmitting(true);
    setActionError("");
    stickToBottom.current = true;
    try {
      const next = await startTeamRun(teamId, sessionId, text || tr("Please review the attached images", "请查看附件"), images, attachments);
      generationRef.current++;
      adoptRun(next);
      setInput("");
      setImages([]);
      setAttachments([]);
      setMentionDismissed(true);
      window.dispatchEvent(new CustomEvent("fastclaw:sessions-changed"));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      generationRef.current++;
      submitRef.current = false;
      setSubmitting(false);
    }
  };

  const stop = async () => {
    try { await stopTeamRun(teamId, sessionId); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const openTopic = (id: string) => {
    window.history.pushState(null, "", `/teams/${encodeURIComponent(teamId)}/chat/${encodeURIComponent(id)}/`);
  };
  const updateTopic = async () => {
    if (!topicEdit || topicSaving) return;
    setTopicSaving(true); setActionError("");
    try {
      if (topicEdit.remove) await deleteTeamTopic(teamId, topicEdit.topic.sessionId);
      else await renameTeamTopic(teamId, topicEdit.topic.sessionId, topicTitle.trim());
      generationRef.current++;
      const next = await getTeamTopics(teamId);
      setTopics(next.topics);
      if (topicEdit.remove && topicEdit.topic.sessionId === sessionId) openTopic(next.topics[0]?.sessionId || `team-${teamId}-topic-${crypto.randomUUID()}`);
      setTopicEdit(null);
    } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
    finally { setTopicSaving(false); }
  };
  const addImages = async (files: File[]) => {
    const selected = files;
    if (selected.some((file) => file.size > 10 * 1024 * 1024)) {
      setActionError(tr("Each file must be under 10 MB", "单个附件不能超过 10 MB")); return;
    }
    try {
      const urls = await Promise.all(selected.slice(0, 8).map((file) => new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
      })));
      setImages((current) => [...current, ...urls.filter((_, index) => selected[index].type.startsWith("image/"))].slice(0, 8));
      setAttachments((current) => [...current, ...urls.flatMap((url, index) => selected[index].type.startsWith("image/") ? [] : [{ url, name: selected[index].name }])].slice(0, 8));
    } catch { setActionError(tr("Could not read image", "无法读取图片")); }
  };
  const mention = (() => {
    if (mentionDismissed) return null;
    const before = input.slice(0, caret), start = before.lastIndexOf("@");
    if (start < 0 || (start > 0 && !/[\s,，、(（]/u.test(before[start - 1]))) return null;
    const query = before.slice(start + 1);
    if (query.length > 80 || /[\n@,，。!！?？:：;；]/u.test(query)) return null;
    const names = ["all", ...members.map((m) => m.name || m.id)];
    const normalized = query.normalize("NFKC").toLocaleLowerCase();
    if (!names.some((name) => name.normalize("NFKC").toLocaleLowerCase().startsWith(normalized))
      && names.some((name) => normalized.startsWith(name.normalize("NFKC").toLocaleLowerCase() + " "))) return null;
    const options = [{ id: "all", name: tr("Everyone", "所有成员"), mention: "all" }, ...members.map((m) => ({ id: m.id, name: m.name || m.id, mention: m.name || m.id }))]
      .filter((m) => `${m.name} ${m.id}`.normalize("NFKC").toLocaleLowerCase().includes(normalized));
    return { start, options };
  })();
  const insertMention = (name: string) => {
    if (!mention) return;
    const value = `@${name} `, position = mention.start + value.length;
    setInput(input.slice(0, mention.start) + value + input.slice(caret)); setCaret(position); setMentionDismissed(true);
    requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(position, position); });
  };
  const statusLabel = (topic: TeamTopic) => {
    if (topic.status === "running" || topic.activeAgents?.length) return tr("Running", "进行中");
    if (topic.limited) return tr("Paused · round limit", "已暂停 · 达到轮数上限");
    if (topic.status === "completed") return tr("Completed", "已完成");
    if (topic.status === "stopped") return tr("Stopped", "已停止");
    if (topic.status === "failed") return tr("Failed", "失败");
    return tr("Idle", "空闲");
  };
  const visibleTopics = topics.some((topic) => topic.sessionId === sessionId) ? topics : [
    { sessionId, title: tr("New session", "新会话"), status: "idle" as const, updatedAt: Date.now(), activeAgents: [] }, ...topics,
  ];

  return (
    <main className="relative flex h-[calc(100vh-3.5rem)] min-w-0 bg-background">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 [scrollbar-gutter:stable] sm:px-6">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          {loading && (
            <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
              <LoaderCircle className="mr-2 size-4 animate-spin motion-reduce:animate-none" />
              {tr("Loading group chat…", "正在加载群聊…")}
            </div>
          )}

          {!loading && loadError && (
            <div className="mx-auto mt-20 max-w-md rounded-2xl border border-dashed px-6 py-10 text-center">
              <UsersRound className="mx-auto mb-3 size-7 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{loadError}</p>
            </div>
          )}

          {!loading && !loadError && messages.length === 0 && (
            <div className="flex min-h-[52vh] flex-col items-center justify-center text-center">
              <TeamAvatarStack members={members} size={62} />
              <h1 className="mt-5 font-heading text-3xl font-semibold tracking-tight">{teamName}</h1>
              <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
                {tr(
                  "Mention an Agent by name, use @all for everyone, or just describe the task and FastClaw will route it.",
                  "可以 @指定 Agent，使用 @all 让全员参与，或直接描述任务，由队长协调分工、接力讨论并汇总结果。",
                )}
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {members.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() => {
                      setInput(`@${member.name || member.id} `);
                      requestAnimationFrame(() => textareaRef.current?.focus());
                    }}
                    className="inline-flex items-center gap-2 rounded-full border border-black/[0.08] bg-card px-3 py-1.5 text-xs font-medium transition hover:bg-muted dark:border-white/[0.1]"
                  >
                    <BotAvatar agentId={member.id} avatarUrl={member.avatarUrl} seed={member.id} size={20} />
                    @{member.name || member.id}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!loading && !loadError && messages.map((message) => {
            if (message.role === "tool") return <details key={message.id} className="rounded-xl border px-4 py-2 text-xs text-muted-foreground"><summary className="cursor-pointer">{members.find((m) => m.id === message.agentId)?.name || message.agentId} · {tr("Tool activity", "工具执行")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">{message.content}</pre></details>;
            if (message.role === "status") {
              return (
                <div key={message.id} className="mx-auto max-w-xl rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-2.5 text-center text-sm text-destructive">
                  {message.content}
                </div>
              );
            }
            if (message.role === "user") {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="user-chat-bubble max-w-[80%] rounded-2xl rounded-br-md border border-[#ded5e2] bg-[#eee9f0] px-4 py-2.5 text-[#29252a] dark:border-[#4b404e] dark:bg-[#342d36] dark:text-[#f8f5f9]">
                    {message.imageUrls?.map((url, index) => <a key={index} href={url} target="_blank" rel="noreferrer"><img src={url} alt={tr("Attachment", "图片附件")} className="mb-2 max-h-56 rounded-lg" /></a>)}
                    {message.attachments?.map((file, index) => <a key={index} className="mb-2 block truncate text-sm underline" href={file.url} download={file.name}>{file.name}</a>)}
                    <ChatMarkdown text={normalizeTeamContent(message.content)} />
                  </div>
                </div>
              );
            }
            const member = members.find((candidate) => candidate.id === message.agentId);
            const content = normalizeTeamContent(message.content, true);
            if (!content) return null;
            return (
              <div key={message.id} className="flex items-start gap-2.5">
                <BotAvatar agentId={member?.id} avatarUrl={member?.avatarUrl} seed={member?.id || message.agentId} size={30} className="mt-0.5" />
                <div className="min-w-0 max-w-[min(88%,56rem)]">
                  <p className="mb-1 px-1 text-xs font-semibold text-muted-foreground">
                    {member?.name || message.agentId || tr("Agent", "Agent")}
                  </p>
                  <div className="rounded-2xl rounded-bl-md bg-[#f1f1f1] px-4 py-2.5 text-[#202020] dark:bg-white/[0.09] dark:text-foreground">
                    <ChatMarkdown text={content} agentId={member?.id} sessionId={member ? memberSessionId(sessionId, member.id) : undefined} />
                  </div>
                </div>
              </div>
            );
          })}

          {sending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="flex gap-1">
                {[0, 1, 2].map((dot) => (
                  <span key={dot} className="typing-dot size-1.5 rounded-full bg-current" style={{ animationDelay: `${dot * 140}ms` }} />
                ))}
              </span>
              {run?.activeAgents.length ? tr("{{names}} is replying…", "{{names}} 正在回复…", { names: run.activeAgents.map((id) => members.find((member) => member.id === id)?.name || id).join(tr(", ", "、")) }) : teamProgressLabel(run, tr)}
            </div>
          )}
        </div>
      </div>

      {(actionError || connectionError) && <p role="status" className="px-5 py-2 text-sm text-destructive">{actionError || tr("Connection interrupted. Reconnecting; replies continue in the background.", "连接暂时中断，正在重连；回复仍在后台继续。")}</p>}
      {!loading && !loadError && (
        <div className="shrink-0 px-3 pb-5 pt-2 sm:px-5">
          <div className="relative mx-auto w-full max-w-5xl rounded-[22px] border border-black/10 bg-card p-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.055)] transition-shadow focus-within:border-black/15 focus-within:ring-2 focus-within:ring-black/5 dark:border-white/10 dark:focus-within:border-white/16 dark:focus-within:ring-white/5">
            {mention && <div id="team-mentions" role="listbox" aria-label={tr("Mention a member", "提及成员")} className="absolute bottom-full left-0 z-20 mb-2 max-h-60 w-72 overflow-auto rounded-xl border bg-background p-1 shadow-lg">
              {mention.options.length ? mention.options.map((option, index) => <button key={option.id} id={`team-mention-${index}`} role="option" aria-selected={index === mentionIndex}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${index === mentionIndex ? "bg-muted" : "hover:bg-muted/50"}`}
                onMouseDown={(e) => e.preventDefault()} onClick={() => insertMention(option.mention)}>
                {option.id === "all" ? <UsersRound className="size-5" /> : <BotAvatar agentId={option.id} size={24} />}<span className="truncate">{option.name}</span>
              </button>) : <p className="p-3 text-xs text-muted-foreground">{tr("No matching members", "没有匹配的成员")}</p>}
            </div>}
            {images.length > 0 && <div className="flex gap-2 overflow-x-auto p-2">{images.map((url, index) => <div key={index} className="relative shrink-0"><img src={url} alt={tr("Image attachment", "图片附件")} className="size-16 rounded-lg object-cover" /><button aria-label={tr("Remove image", "移除图片")} className="absolute -right-1 -top-1 rounded-full bg-background p-0.5 shadow" onClick={() => setImages((current) => current.filter((_, i) => i !== index))}><X className="size-3" /></button></div>)}</div>}
            {attachments.length > 0 && <div className="flex flex-wrap gap-2 p-2">{attachments.map((file, index) => <span key={index} className="inline-flex max-w-full items-center gap-2 rounded-lg border px-2 py-1 text-xs"><Paperclip className="size-3" /><span className="truncate">{file.name}</span><button aria-label={tr("Remove attachment", "移除附件")} onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}><X className="size-3" /></button></span>)}</div>}
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { void addImages(Array.from(e.target.files || [])); e.target.value = ""; }} />
            <div className="flex items-end gap-2">
              <Button variant="ghost" size="icon" className="size-8 shrink-0 rounded-full" aria-label={tr("Attach files", "添加附件")} onClick={() => fileRef.current?.click()}><Paperclip className="size-4" /></Button>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => { setInput(event.target.value); setCaret(event.target.selectionStart); setMentionIndex(0); setMentionDismissed(false); }}
                onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                onPaste={(event) => { const files = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/")).flatMap((item) => { const file = item.getAsFile(); return file ? [file] : []; }); if (files.length) { event.preventDefault(); void addImages(files); } }}
                aria-controls={mention ? "team-mentions" : undefined}
                aria-activedescendant={mention?.options.length ? `team-mention-${mentionIndex}` : undefined}
                onKeyDown={(event) => {
                  if (mention && !event.nativeEvent.isComposing) {
                    if (event.key === "Escape") { event.preventDefault(); setMentionDismissed(true); return; }
                    if (mention.options.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setMentionIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + mention.options.length) % mention.options.length); return; }
                    if (mention.options.length && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) { event.preventDefault(); insertMention(mention.options[mentionIndex % mention.options.length].mention); return; }
                  }
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder={tr("Message group · @Agent or @all", "给群聊发消息 · @Agent 或 @all")}
                className="block min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-[15px] leading-6 placeholder:text-muted-foreground/45 outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                style={{ maxHeight: 180, minHeight: 32 }}
              />
              {sending ? (
                <Button disabled={submitting} onClick={() => void stop()} size="icon" className="size-8 shrink-0 rounded-full bg-[#111] text-white hover:bg-black dark:bg-white dark:text-black">
                  <Square className="size-3 fill-current" />
                  <span className="sr-only">{tr("Stop generating", "停止生成")}</span>
                </Button>
              ) : input.trim() || images.length || attachments.length ? (
                <Button onClick={() => void send()} size="icon" className="size-8 shrink-0 rounded-full bg-[#111] text-white hover:bg-black dark:bg-white dark:text-black">
                  <ArrowUp className="size-[17px] stroke-[2.25]" />
                  <span className="sr-only">{tr("Send message", "发送消息")}</span>
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      )}
      </div>
      {panelOpen === true && <button className="fixed inset-0 z-40 bg-black/20 xl:hidden"
        aria-label={tr("Close group sidebar", "关闭群聊侧栏")} onClick={() => onPanelChange(false)} />}
      {panelOpen !== false && (
        <aside aria-label={tr("Group sidebar", "群聊侧栏")}
          className={`${panelOpen === null ? "hidden xl:flex" : "flex"} fixed inset-y-0 right-0 z-50 h-dvh w-[min(94vw,420px)] shrink-0 flex-col border-l border-border bg-background shadow-2xl xl:relative xl:z-30 xl:-mt-14 xl:h-screen xl:w-[400px] xl:min-w-[300px] xl:max-w-[calc(100%_-_520px)] xl:shadow-none`}>
          <div className="flex h-14 shrink-0 items-center justify-between px-5">
            <h2 className="mr-auto text-sm font-medium">{tr("Group chat", "群聊")}</h2>
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" disabled={!team} aria-label={tr("Group settings", "群聊设置")} onClick={() => setSettingsOpen(true)}><Settings className="size-4" /></Button>
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground"
              aria-label={tr("Collapse group sidebar", "收起群聊侧栏")} onClick={() => onPanelChange(false)}>
              <ChevronsRight className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-1">
            <section aria-label={tr("Members", "群成员")} className="border-b border-border px-1 pb-6 pt-3">
              <div className="grid grid-cols-5 gap-x-2 gap-y-3">
                {members.map((member) => <button key={member.id}
                  title={member.name || member.id}
                  aria-label={tr("Mention {{name}}", "提及 {{name}}", { name: member.name || member.id })}
                  className="group flex min-w-0 flex-col items-center gap-1.5 rounded-lg py-1 focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => {
                    setInput((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${member.name || member.id} `);
                    if (!window.matchMedia("(min-width: 1280px)").matches) onPanelChange(false);
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }}>
                  <span className="flex size-12 items-center justify-center overflow-hidden rounded-xl bg-black/[0.06] transition group-hover:bg-black/10 dark:bg-white/[0.08] dark:group-hover:bg-white/[0.14]">
                    <BotAvatar agentId={member.id} avatarUrl={member.avatarUrl} seed={member.id} size={40} className="rounded-lg" />
                  </span>
                  <span className="flex w-full items-center justify-center gap-0.5 text-xs text-muted-foreground">{(team?.defaultAgent || team?.agents[0]) === member.id && <Crown className="size-2.5 shrink-0" />}<span className="truncate">{member.name || member.id}</span></span>
                </button>)}
                <button onClick={() => setAddMembersOpen(true)} disabled={!team}
                  aria-label={tr("Add members", "添加成员")}
                  className="group flex min-w-0 flex-col items-center gap-1.5 rounded-lg py-1 text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
                  <span className="flex size-12 items-center justify-center rounded-xl border border-dashed border-muted-foreground/60 transition group-hover:bg-muted">
                    <Plus className="size-5" />
                  </span>
                  <span className="text-xs">{tr("Add", "添加")}</span>
                </button>
              </div>
            </section>
            <section className="mt-5">
              <div className="mb-2 flex items-center justify-between px-1">
                <h3 className="text-sm font-medium text-muted-foreground">{tr("Sessions", "会话")}</h3>
                <Button variant="ghost" size="icon" className="size-8 text-muted-foreground"
                  aria-label={tr("New session", "新会话")} title={tr("New session", "新会话")}
                  onClick={() => openTopic(`team-${teamId}-topic-${crypto.randomUUID()}`)}>
                  <Plus className="size-4" />
                </Button>
              </div>
              <nav aria-label={tr("Group sessions", "群聊会话")} className="space-y-1">
                {visibleTopics.map((topic) => {
                  const running = topic.status === "running" || !!topic.activeAgents?.length;
                  return <div key={topic.sessionId} className="group/topic relative"><button onClick={() => {
                    openTopic(topic.sessionId);
                    if (!window.matchMedia("(min-width: 1280px)").matches) onPanelChange(false);
                  }} aria-current={topic.sessionId === sessionId ? "page" : undefined}
                    className={`w-full rounded-lg py-2 pl-3 pr-9 text-left transition focus-visible:outline-2 focus-visible:outline-ring ${topic.sessionId === sessionId ? "bg-black/[0.07] dark:bg-white/[0.09]" : "hover:bg-muted"}`}>
                    <span className="block truncate text-sm">{topic.title || tr("Untitled session", "未命名会话")}</span>
                    <span className={`mt-1 flex items-center gap-1.5 text-[11px] ${running ? "text-violet-600 dark:text-violet-300" : topic.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                      {running && <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />}
                      {statusLabel(topic)}
                      {running && <span className="truncate">{topic.activeAgents.map((id) => members.find((m) => m.id === id)?.name || id).join(" · ")}</span>}
                    </span>
                  </button>
                  <DropdownMenu><DropdownMenuTrigger render={<button aria-label={tr("Session actions", "会话操作")} className="absolute right-1 top-2 rounded-md p-1 text-muted-foreground hover:bg-muted"><MoreHorizontal className="size-4" /></button>} />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem disabled={running} onClick={() => { setTopicTitle(topic.title); setTopicEdit({ topic, remove: false }); }}><Pencil className="size-4" />{tr("Rename", "重命名")}</DropdownMenuItem>
                      <DropdownMenuItem disabled={running} onClick={() => setTopicEdit({ topic, remove: true })}><Trash2 className="size-4" />{tr("Delete session", "删除会话")}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  </div>;
                })}
              </nav>
            </section>
          </div>
        </aside>
      )}
      {settingsOpen && team && <TeamSettingsDialog teamId={teamId} team={team} onClose={() => setSettingsOpen(false)}
        onSaved={(next, nextMembers) => { setTeam(next); setMembers(nextMembers); setSettingsOpen(false); window.dispatchEvent(new CustomEvent("fastclaw:teams-changed")); }} />}
      {topicEdit && <Dialog open onOpenChange={(open) => { if (!open && !topicSaving) setTopicEdit(null); }}><DialogContent>
        <DialogHeader><DialogTitle>{topicEdit.remove ? tr("Delete session", "删除会话") : tr("Rename session", "重命名会话")}</DialogTitle>
          <DialogDescription>{topicEdit.remove ? tr("Remove this session from the group?", "确定从群聊中删除这个会话？") : tr("Set a title for this session.", "设置会话名称。")}</DialogDescription></DialogHeader>
        {!topicEdit.remove && <Input aria-label={tr("Session title", "会话名称")} value={topicTitle} onChange={(e) => setTopicTitle(e.target.value)} />}
        {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
        <DialogFooter><Button variant="outline" disabled={topicSaving} onClick={() => setTopicEdit(null)}>{tr("Cancel", "取消")}</Button>
          <Button disabled={topicSaving || (!topicEdit.remove && !topicTitle.trim())} onClick={() => void updateTopic()}>{tr("Confirm", "确定")}</Button></DialogFooter>
      </DialogContent></Dialog>}
      {addMembersOpen && <AddTeamMembersDialog teamId={teamId} onClose={() => setAddMembersOpen(false)}
        onAdded={(nextTeam, nextMembers) => {
          setTeam(nextTeam);
          setMembers(nextMembers);
          setAddMembersOpen(false);
          window.dispatchEvent(new CustomEvent("fastclaw:teams-changed"));
        }} />}
    </main>
  );
}

function AddTeamMembersDialog({ teamId, onClose, onAdded }: {
  teamId: string;
  onClose: () => void;
  onAdded: (team: TeamEntry, members: AgentDetail[]) => void;
}) {
  const { tr } = useLocale();
  const [agents, setAgents] = React.useState<AgentDetail[]>([]);
  const [existing, setExisting] = React.useState<string[]>([]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([getAgents(), getConfig("user")]).then(([available, config]) => {
      if (cancelled) return;
      if (!config.teams?.[teamId]) throw new Error(tr("Group chat no longer exists", "群聊已不存在"));
      setAgents(available);
      setExisting(config.teams[teamId].agents);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [teamId, tr]);

  const save = async () => {
    if (saving || !selected.length) return;
    setSaving(true);
    setError("");
    try {
      // Read the latest group so adding members preserves its other settings.
      const config = await getConfig("user");
      const current = config.teams?.[teamId];
      if (!current) throw new Error(tr("Group chat no longer exists", "群聊已不存在"));
      const next = { ...current, agents: [...new Set([...current.agents, ...selected])] };
      const response = await updateConfig({ teams: { [teamId]: next } }, "user");
      if (!response?.ok) throw new Error(response?.error || tr("Failed to add members", "添加成员失败"));
      const byId = new Map(agents.map((agent) => [agent.id, agent]));
      onAdded(next, next.agents.map((id) => byId.get(id)).filter((agent): agent is AgentDetail => !!agent));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };
  const available = agents.filter((agent) => !existing.includes(agent.id)
    && `${agent.name} ${agent.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{tr("Add members", "添加成员")}</DialogTitle>
        <DialogDescription>{tr("Choose Agents to join this group chat.", "选择要加入群聊的 Agent。")}</DialogDescription>
      </DialogHeader>
      <Input value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder={tr("Search Agents", "搜索 Agent")} aria-label={tr("Search Agents", "搜索 Agent")} />
      <div className="max-h-72 space-y-1 overflow-y-auto">
        {loading ? <p className="py-6 text-center text-sm text-muted-foreground">{tr("Loading…", "正在加载…")}</p>
          : available.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">{tr("No Agents available to add", "暂无可添加的 Agent")}</p>
          : available.map((agent) => <button key={agent.id} disabled={saving} aria-pressed={selected.includes(agent.id)}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => setSelected((current) => current.includes(agent.id) ? current.filter((id) => id !== agent.id) : [...current, agent.id])}>
            <BotAvatar agentId={agent.id} avatarUrl={agent.avatarUrl} size={32} />
            <span className="min-w-0 flex-1 truncate">{agent.name || agent.id}</span>
            {selected.includes(agent.id) && <Check className="size-4" />}
          </button>)}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={onClose}>{tr("Cancel", "取消")}</Button>
        <Button disabled={loading || saving || !selected.length} onClick={() => void save()}>
          {saving && <LoaderCircle className="size-4 animate-spin" />}{tr("Add members", "添加成员")}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
