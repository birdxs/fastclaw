import { getAgents } from "@/lib/api";

// Where a signed-in user lands. FastClaw's web UI has two areas: the chat
// (the official FastClaw client) and /console (managing agents, models,
// keys). We remember which one the user was last in, and where, so
// signing in resumes it; chat is the default.

const MODE_KEY = "fastclaw:last-mode";
const CHAT_KEY = "fastclaw:last-chat";
const CONSOLE_KEY = "fastclaw:last-console";

type Mode = "chat" | "console";

const CHAT_ROUTE = /^\/(?:agents\/[^/]+\/(?:chat|project)(?:\/|$)|teams\/[^/]+\/chat\/)/;

function read(key: string): string {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode / blocked storage: landing just falls back to defaults.
  }
}

// rememberLocation records the current page as the place to resume.
// Read-only audit views (?actAs=) are someone else's chats and are skipped.
export function rememberLocation(pathname: string, search: string) {
  if (!pathname || search.includes("actAs=")) return;
  if (CHAT_ROUTE.test(pathname)) {
    write(MODE_KEY, "chat");
    write(CHAT_KEY, pathname + search);
  } else if (pathname === "/console" || pathname.startsWith("/console/")) {
    write(MODE_KEY, "console");
    write(CONSOLE_KEY, pathname + search);
  }
}

// resolveAppLanding picks the first page after sign-in:
//   - no agents yet → the console's Agents page, to create one
//   - last in the console → back to that console page
//   - otherwise → the last conversation, or the newest agent's chat
export async function resolveAppLanding(): Promise<string> {
  const agents = await getAgents().catch(() => []);
  if (agents.length === 0) return "/console/agents/";
  const mode = read(MODE_KEY) as Mode | "";
  if (mode === "console") return read(CONSOLE_KEY) || "/console/";
  const lastChat = read(CHAT_KEY);
  const lastAgent = lastChat.match(/^\/agents\/([^/]+)\//)?.[1];
  // Agent chats only resume while the agent still exists for this user;
  // group chats re-check access on their own screen.
  if (lastChat && (!lastAgent || agents.some((a) => a.id === decodeURIComponent(lastAgent)))) {
    return lastChat;
  }
  return `/agents/${encodeURIComponent(agents[0].id)}/chat/`;
}
