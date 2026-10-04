"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { SidebarLayout } from "@/components/sidebar";
import AgentAccessGate from "@/components/agent-access-gate";
import { ChatScreen } from "@/components/chat-screen";
import { TeamChatScreen } from "@/components/team-chat-screen";
import { LegacyTeamChatRedirect } from "@/components/legacy-team-chat-redirect";

// Paths that render on their own (no sidebar chrome). /signup is in
// here because hitting it directly while signed out (e.g. from an admin
// invite link) was leaking the authenticated app chrome — Overview /
// Agents / Models in the sidebar — to a not-yet-registered visitor.
const BARE_PATHS = ["/", "/onboard", "/signup"];

function wantsSidebar(pathname: string) {
  if (BARE_PATHS.includes(pathname)) return false;
  if (pathname.startsWith("/onboard/")) return false;
  if (pathname.startsWith("/signup/")) return false;
  return true;
}

// AppShell mounts SidebarLayout once for every authenticated page and keeps
// that instance alive across client-side navigations. Previously each route
// segment had its own layout.tsx that re-wrapped SidebarLayout, so Next
// unmounted and remounted the sidebar on every top-level nav — triggering a
// fresh status / agents / sessions fetch and a visible flash. One shell at
// the root means the sidebar (and its effects) persists across navigations.
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (!wantsSidebar(pathname)) {
    return <>{children}</>;
  }
  // Native history navigation updates the pathname without replacing Next's
  // static-export route tree. Choose the conversation here so crossing from a
  // group to an Agent cannot leave the previous route's screen mounted.
  let content = children;
  if (/^\/teams\/[^/]+\/chat\/[^/]+\/?$/.test(pathname)) {
    content = <TeamChatScreen />;
  } else if (/^\/agents\/[^/]+\/team\/[^/]+\/?$/.test(pathname)) {
    content = <LegacyTeamChatRedirect />;
  } else if (/^\/agents\/[^/]+(?:\/(?:chat(?:\/[^/]+)?|chats|project(?:\/[^/]+)?))?\/?$/.test(pathname)) {
    content = <AgentAccessGate><ChatScreen /></AgentAccessGate>;
  }
  return <SidebarLayout>{content}</SidebarLayout>;
}
