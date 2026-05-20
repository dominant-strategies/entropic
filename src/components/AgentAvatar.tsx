import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { DEFAULT_AGENT_NAME } from "../lib/agentDefaults";
import { sanitizeProfileName } from "../lib/profile";

type AgentAvatarProps = {
  name: string;
  avatarUrl?: string;
  className?: string;
  alt?: string;
};

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nextHash(seed: number): number {
  let value = seed;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function buildPixelAvatar(name: string) {
  const clean = sanitizeProfileName(name, DEFAULT_AGENT_NAME);
  let cursor = hashString(clean.toLowerCase());
  const hue = cursor % 360;
  const cells: boolean[] = Array.from({ length: 25 }, () => false);

  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      cursor = nextHash(cursor + row * 17 + col * 31);
      const active = (cursor % 100) < 62;
      cells[row * 5 + col] = active;
      cells[row * 5 + (4 - col)] = active;
    }
  }

  if (cells.filter(Boolean).length < 8) {
    [6, 8, 11, 12, 13, 16, 18].forEach((index) => {
      cells[index] = true;
    });
  }

  return {
    cells,
    background: `linear-gradient(135deg, hsl(${hue} 50% 13%), hsl(${(hue + 46) % 360} 42% 20%))`,
    foreground: `hsl(${(hue + 34) % 360} 82% 64%)`,
    foregroundAlt: `hsl(${(hue + 78) % 360} 86% 72%)`,
  };
}

export function AgentAvatar({ name, avatarUrl, className, alt }: AgentAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const cleanedAvatarUrl = typeof avatarUrl === "string" ? avatarUrl.trim() : "";
  const showImage = Boolean(cleanedAvatarUrl) && !imageFailed;
  const avatar = useMemo(() => buildPixelAvatar(name), [name]);

  useEffect(() => {
    setImageFailed(false);
  }, [cleanedAvatarUrl]);

  return (
    <div
      className={clsx(
        "relative flex items-center justify-center overflow-hidden rounded-full bg-[var(--bg-tertiary)]",
        className,
      )}
      style={showImage ? undefined : { background: avatar.background }}
    >
      {showImage ? (
        <img
          src={cleanedAvatarUrl}
          alt={alt ?? `${sanitizeProfileName(name)} avatar`}
          className="h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="grid h-full w-full grid-cols-5 grid-rows-5 gap-[4%] p-[17%]" aria-hidden="true">
          {avatar.cells.map((active, index) => (
            <span
              key={index}
              className="rounded-[30%]"
              style={{
                backgroundColor: active
                  ? index % 2 === 0
                    ? avatar.foreground
                    : avatar.foregroundAlt
                  : "transparent",
                boxShadow: active ? "0 0 10px rgba(255,255,255,0.08)" : undefined,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
