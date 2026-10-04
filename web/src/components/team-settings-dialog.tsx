"use client";

import * as React from "react";
import { Check, LoaderCircle } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { useLocale } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getAgents, getConfig, updateConfig, type AgentDetail, type TeamEntry } from "@/lib/api";

export function TeamSettingsDialog({ teamId, team, onClose, onSaved }: {
  teamId: string; team: TeamEntry; onClose: () => void;
  onSaved: (team: TeamEntry, members: AgentDetail[]) => void;
}) {
  const { tr } = useLocale();
  const [name, setName] = React.useState(team.name || "");
  const [description, setDescription] = React.useState(team.description || "");
  const [humanName, setHumanName] = React.useState(team.humanName || "");
  const [selected, setSelected] = React.useState(team.agents);
  const [lead, setLead] = React.useState(team.defaultAgent || team.agents[0]);
  const [agents, setAgents] = React.useState<AgentDetail[]>([]);
  const [query, setQuery] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let cancelled = false;
    getAgents().then((next) => { if (!cancelled) setAgents(next); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  const visible = agents.filter((agent) => `${agent.name} ${agent.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const save = async () => {
    if (saving || !name.trim() || selected.length < 2) return;
    setSaving(true); setError("");
    try {
      const config = await getConfig("user");
      const current = config.teams?.[teamId];
      if (!current) throw new Error(tr("Group no longer exists", "群聊已不存在"));
      const next: TeamEntry = { ...current, name: name.trim(), description: description.trim(), humanName: humanName.trim(),
        agents: selected, defaultAgent: selected.includes(lead) ? lead : selected[0], groupBehavior: "coordinated" };
      const result = await updateConfig({ teams: { [teamId]: next } }, "user");
      if (!result?.ok) throw new Error(result?.error || tr("Save failed", "保存失败"));
      onSaved(next, selected.flatMap((id) => agents.filter((agent) => agent.id === id)));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader><DialogTitle>{tr("Group settings", "群聊设置")}</DialogTitle>
        <DialogDescription>{tr("Set the group profile, members, and lead. Changes apply to the next message.", "设置群资料、成员和队长，修改从下一条消息开始生效。")}</DialogDescription></DialogHeader>
      <label className="space-y-1 text-sm">{tr("Name", "群名称")}<Input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="space-y-1 text-sm">{tr("Description", "群简介")}<Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tr("What this group works on", "这个群一起做什么")} /></label>
      <label className="space-y-1 text-sm">{tr("Your name in this group", "群成员对你的称呼")}<Input value={humanName} onChange={(e) => setHumanName(e.target.value)} /></label>
      <label className="space-y-1 text-sm">{tr("Lead member", "队长")}
        <select className="h-9 w-full rounded-md border bg-background px-3" value={selected.includes(lead) ? lead : selected[0]} onChange={(e) => setLead(e.target.value)}>
          {selected.map((id) => <option key={id} value={id}>{agents.find((agent) => agent.id === id)?.name || id}</option>)}
        </select>
        <p className="text-xs text-muted-foreground">{tr("The lead coordinates tasks and reviews results using its configured model.", "使用队长配置的模型协调分工、检查进度和汇总结果。")}</p>
      </label>
      <div className="flex items-center justify-between text-sm"><span>{tr("Members", "成员")} · {selected.length}</span>
        <Button size="sm" variant="ghost" onClick={() => setSelected((current) => visible.every((a) => current.includes(a.id))
          ? current.filter((id) => !visible.some((a) => a.id === id)) : [...new Set([...current, ...visible.map((a) => a.id)])])}>
          {visible.length > 0 && visible.every((a) => selected.includes(a.id)) ? tr("Deselect results", "取消选择结果") : tr("Select results", "全选结果")}
        </Button>
      </div>
      <Input aria-label={tr("Search members", "搜索成员")} placeholder={tr("Search members", "搜索成员")} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="max-h-48 space-y-1 overflow-y-auto">
        {visible.map((a) => <button key={a.id} aria-pressed={selected.includes(a.id)} disabled={saving}
          className="flex w-full items-center gap-3 rounded-lg p-2 text-left text-sm hover:bg-muted"
          onClick={() => setSelected((current) => current.includes(a.id) ? current.filter((id) => id !== a.id) : [...current, a.id])}>
          <BotAvatar agentId={a.id} avatarUrl={a.avatarUrl} size={28} /><span className="min-w-0 flex-1 truncate">{a.name || a.id}</span>{selected.includes(a.id) && <Check className="size-4" />}
        </button>)}
      </div>
      {selected.length < 2 && <p className="text-xs text-muted-foreground">{tr("Select at least two members", "请至少选择两个成员")}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={saving} onClick={onClose}>{tr("Cancel", "取消")}</Button>
        <Button disabled={loading || saving || !name.trim() || selected.length < 2} onClick={() => void save()}>{saving && <LoaderCircle className="size-4 animate-spin" />}{tr("Save", "保存")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
