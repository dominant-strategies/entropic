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

type PixelAvatar = {
  image: string;
  background: string;
};

const PIXEL_AVATAR_GRID_SIZE = 16;
const PIXEL_AVATAR_CELL_COUNT = PIXEL_AVATAR_GRID_SIZE * PIXEL_AVATAR_GRID_SIZE;
const pixelAvatarCache = new Map<string, PixelAvatar>();

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

function colorForPixel(index: number, primary: string, secondary: string, highlight: string) {
  if (index % 11 === 0) return highlight;
  return index % 3 === 0 ? secondary : primary;
}

function buildPixelAvatar(name: string): PixelAvatar {
  const clean = sanitizeProfileName(name, DEFAULT_AGENT_NAME);
  const cacheKey = clean.toLowerCase();
  const cached = pixelAvatarCache.get(cacheKey);
  if (cached) return cached;

  let cursor = hashString(clean.toLowerCase());
  const hue = cursor % 360;
  const cells: boolean[] = Array.from({ length: PIXEL_AVATAR_CELL_COUNT }, () => false);
  const grid = PIXEL_AVATAR_GRID_SIZE;
  const halfGrid = grid / 2;

  for (let row = 0; row < grid; row += 1) {
    for (let col = 0; col < halfGrid; col += 1) {
      cursor = nextHash(cursor + row * 97 + col * 53);
      const active = (cursor % 100) < 56;
      cells[row * grid + col] = active;
      cells[row * grid + (grid - 1 - col)] = active;
    }
  }

  if (cells.filter(Boolean).length < PIXEL_AVATAR_CELL_COUNT * 0.38) {
    for (let row = 4; row < 12; row += 1) {
      for (let col = 4; col < 12; col += 1) {
        cells[row * grid + col] = true;
      }
    }
  }

  const foreground = `hsl(${(hue + 34) % 360} 82% 64%)`;
  const foregroundAlt = `hsl(${(hue + 78) % 360} 86% 72%)`;
  const highlight = `hsl(${(hue + 112) % 360} 88% 78%)`;
  const backgroundPrimary = `hsl(${hue} 50% 15%)`;
  const backgroundSecondary = `hsl(${(hue + 46) % 360} 42% 21%)`;
  const rects = cells
    .map((active, index) => {
      const x = index % grid;
      const y = Math.floor(index / grid);
      const baseColor = (x + y + index) % 4 === 0 ? backgroundSecondary : backgroundPrimary;
      const fill = active ? colorForPixel(index, foreground, foregroundAlt, highlight) : baseColor;
      return `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`;
    })
    .join("");
  // 16x16 is ~10x the old 5x5 grid, emitted as one SVG background instead of 256 DOM nodes.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${grid} ${grid}" shape-rendering="crispEdges">${rects}</svg>`;
  const avatar = {
    image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    background: `linear-gradient(135deg, hsl(${hue} 50% 13%), hsl(${(hue + 46) % 360} 42% 20%))`,
  };
  pixelAvatarCache.set(cacheKey, avatar);
  if (pixelAvatarCache.size > 96) {
    const oldest = pixelAvatarCache.keys().next().value;
    if (oldest) pixelAvatarCache.delete(oldest);
  }
  return avatar;
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
      style={{
        ...(showImage ? {} : { background: avatar.background }),
        borderRadius: "9999px",
        clipPath: "circle(50% at 50% 50%)",
      }}
    >
      {showImage ? (
        <img
          src={cleanedAvatarUrl}
          alt={alt ?? `${sanitizeProfileName(name)} avatar`}
          className="h-full w-full object-cover"
          style={{ borderRadius: "inherit" }}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div
          className="h-full w-full"
          aria-hidden="true"
          style={{
            backgroundImage: `url("${avatar.image}")`,
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            backgroundSize: "100% 100%",
            borderRadius: "inherit",
            imageRendering: "pixelated",
            filter: "drop-shadow(0 0 8px rgba(255,255,255,0.08))",
          }}
        />
      )}
    </div>
  );
}
