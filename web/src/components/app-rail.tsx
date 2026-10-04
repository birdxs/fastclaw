"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboardIcon, MessagesSquareIcon, SettingsIcon, ShieldIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocale } from "@/components/locale-provider";
import { getMe } from "@/lib/api";
import { areaHome, areaOf, resolveChatLanding, type Area } from "@/lib/landing";
import { cn } from "@/lib/utils";

// Width of the rail. SidebarLayout passes it to the sidebar as
// --sidebar-offset so the (fixed-position) sidebar sits right of it.
export const APP_RAIL_WIDTH = "3.5rem";

// AppRail is the far-left switcher between the web UI's areas — chat,
// console and (super_admin) admin — plus Settings. Each area reopens where
// the user left it. Desktop only: on mobile the sidebar is a sheet.
export function AppRail() {
  const { tr } = useLocale();
  const pathname = usePathname() || "";
  const router = useRouter();
  const [isAdmin, setIsAdmin] = React.useState(false);
  const area = areaOf(pathname);

  React.useEffect(() => {
    getMe()
      .then((me) => setIsAdmin(me?.user?.role === "super_admin"))
      .catch(() => {});
  }, []);

  const go = async (target: Area) => {
    if (target === area) return;
    router.push(target === "chat" ? await resolveChatLanding() : areaHome(target));
  };

  return (
    <div className="hidden w-(--app-rail-width) shrink-0 md:block" style={{ "--app-rail-width": APP_RAIL_WIDTH } as React.CSSProperties}>
      <nav
        aria-label={tr("Areas", "功能区")}
        className="fixed inset-y-0 left-0 z-20 flex w-(--app-rail-width) flex-col items-center gap-1 border-r border-sidebar-border bg-sidebar py-3"
      >
        <RailButton
          label={tr("Chat", "对话")}
          active={area === "chat"}
          onClick={() => go("chat")}
          icon={MessagesSquareIcon}
        />
        <RailButton
          label={tr("Console", "控制台")}
          active={area === "console"}
          onClick={() => go("console")}
          icon={LayoutDashboardIcon}
        />
        {isAdmin && (
          <RailButton
            label={tr("Admin", "管理后台")}
            active={area === "admin"}
            onClick={() => go("admin")}
            icon={ShieldIcon}
          />
        )}
        <div className="mt-auto">
          <RailButton
            label={tr("Settings", "设置")}
            onClick={() => window.dispatchEvent(new CustomEvent("fastclaw:open-user-settings"))}
            icon={SettingsIcon}
          />
        </div>
      </nav>
    </div>
  );
}

function RailButton({
  label,
  active = false,
  onClick,
  icon: Icon,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={active ? "page" : undefined}
            onClick={onClick}
            className={cn(
              "flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              active && "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          />
        }
      >
        <Icon className="size-5" />
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
