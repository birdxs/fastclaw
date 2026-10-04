"use client";

import { UsersRound } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { cn } from "@/lib/utils";

export interface TeamAvatarMember {
  id: string;
  avatarUrl?: string;
}

export function TeamAvatarStack({
  members,
  size = 36,
  className,
}: {
  members: TeamAvatarMember[];
  size?: number;
  className?: string;
}) {
  const visible = members.slice(0, 3);
  if (visible.length === 0) {
    return (
      <span
        className={cn("inline-flex shrink-0 items-center justify-center rounded-[34%] bg-[#ebe7ed] text-[#756878] dark:bg-white/10 dark:text-[#c9bdcc]", className)}
        style={{ width: size, height: size }}
      >
        <UsersRound style={{ width: size * 0.48, height: size * 0.48 }} />
      </span>
    );
  }

  const avatarSize = visible.length === 1 ? size : Math.round(size * 0.68);
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      {visible.map((member, index) => {
        const positions = visible.length === 2
          ? [{ left: 0, top: size * 0.16 }, { left: size * 0.32, top: size * 0.16 }]
          : [
              { left: size * 0.16, top: 0 },
              { left: 0, top: size * 0.32 },
              { left: size * 0.32, top: size * 0.32 },
            ];
        const position = visible.length === 1 ? { left: 0, top: 0 } : positions[index];
        return (
          <span
            key={member.id}
            className="absolute"
            style={{ left: position.left, top: position.top }}
          >
            <BotAvatar
              agentId={member.id}
              avatarUrl={member.avatarUrl}
              seed={member.id}
              size={avatarSize}
              className="ring-2 ring-[#f7f7f7] dark:ring-[#171717]"
            />
          </span>
        );
      })}
    </span>
  );
}
