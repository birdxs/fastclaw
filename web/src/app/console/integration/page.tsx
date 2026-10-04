"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { getAgents, type AgentDetail } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChatMarkdown } from "@/components/chat-markdown";
import { useLocale } from "@/components/locale-provider";

// The integration page hands a coding agent (in another project) what it
// needs to wire that project to FastClaw: the public guide at
// /integration.md and a ready-to-paste prompt naming this deployment and
// the agent to call.
export default function IntegrationPage() {
  const { tr } = useLocale();
  // window.location.origin, "" while statically prerendering.
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
  const [agents, setAgents] = useState<AgentDetail[]>([]);
  const [agentId, setAgentId] = useState("");
  const [guide, setGuide] = useState("");
  const [copied, setCopied] = useState<"" | "url" | "prompt">("");

  useEffect(() => {
    getAgents()
      .then((list) => {
        setAgents(list);
        if (list.length > 0) setAgentId(list[0].id);
      })
      .catch(() => {});
    fetch("/integration.md")
      .then((res) => (res.ok ? res.text() : ""))
      .then(setGuide)
      .catch(() => {});
  }, []);

  const guideURL = `${origin}/integration.md`;
  const agent = agents.find((a) => a.id === agentId);
  // The prompt is for an agent, so it stays in English regardless of the
  // UI language.
  const prompt = useMemo(
    () =>
      [
        "Integrate this project with FastClaw, a cloud agent runtime.",
        "",
        `1. Read the integration guide first and follow it over guesses: ${guideURL}`,
        `2. FastClaw base URL: ${origin}`,
        "3. API key: read it on the server side from the FASTCLAW_API_KEY environment variable. Never send it to browsers or mobile clients — route calls through this project's backend.",
        agent
          ? `4. Agent: ${agent.name || agent.id} — agent_id \`${agent.id}\``
          : "4. Agent: create one first, or call POST /v1/agents with a user key.",
        "5. For each conversation call POST /v1/chat/completions with agent_id, a deterministic X-Fastclaw-Session-Key, and `user` set to the end user's stable ID when their history and memory must stay private to them.",
        "6. Handle errors by error.code (e.g. agent_not_found, unauthorized, rate_limited).",
      ].join("\n"),
    [agent, guideURL, origin],
  );

  async function copy(kind: "url" | "prompt", text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(""), 1500);
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">{tr("Integration", "接入文档")}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {tr(
            "Connect another app to your FastClaw agents. Give the guide and the prompt below to the coding agent working on that app.",
            "把其他应用接入你的 FastClaw Agent。把下面的文档链接和提示词交给负责那个应用的编程 Agent 即可。",
          )}
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div>
            <p className="text-sm font-medium">{tr("Integration guide", "接入文档链接")}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {tr(
                "Public and readable by any agent — it contains no keys. It already names this FastClaw's address.",
                "公开可读，任何 Agent 都能直接读取，不含任何密钥；文档开头已写明这台 FastClaw 的地址。",
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded border bg-muted px-3 py-2 font-mono text-xs">{guideURL}</code>
            <Button size="sm" variant="outline" onClick={() => copy("url", guideURL)}>
              {copied === "url" ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.open("/integration.md", "_blank")}>
              <ExternalLink className="size-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{tr("Prompt for your agent", "给 Agent 的提示词")}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {tr(
                  "Pick the agent to integrate, then paste this into the coding agent. Issue an API key under API Keys — an \"Agent\" key granted only this agent is enough.",
                  "选择要接入的 Agent，然后把这段话粘贴给编程 Agent。API 密钥在「API 密钥」页签发：只授权这个 Agent 的「Agent」类型密钥就够了。",
                )}
              </p>
            </div>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-sm"
              aria-label={tr("Agent", "Agent")}
            >
              {agents.length === 0 && <option value="">{tr("No agents yet", "还没有 Agent")}</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name || a.id}
                </option>
              ))}
            </select>
          </div>
          <div className="relative">
            <pre className="whitespace-pre-wrap rounded border bg-muted px-3 py-2 pr-12 font-mono text-xs leading-relaxed">
              {prompt}
            </pre>
            <Button
              size="sm"
              variant="outline"
              className="absolute right-2 top-2"
              onClick={() => copy("prompt", prompt)}
            >
              {copied === "prompt" ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>
        </CardContent>
      </Card>

      {guide && (
        <Card>
          <CardContent className="pt-6">
            <ChatMarkdown text={guide} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
