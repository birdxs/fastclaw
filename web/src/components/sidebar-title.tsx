"use client";

import { cn } from "@/lib/utils";

// SidebarTitle names the area a sidebar belongs to (Chat / Console /
// Admin). The FastClaw logo and the account live in the AppRail beside it.
export function SidebarTitle({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex h-14 items-center gap-2 px-2", className)}>
      <h2 className="truncate text-[20px] font-bold tracking-[-0.02em] text-foreground group-data-[collapsible=icon]:hidden">
        {title}
      </h2>
      {children}
    </div>
  );
}
