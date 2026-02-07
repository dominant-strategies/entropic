// Shared wallpaper definitions used by Files desktop view and Settings page

export type Wallpaper = {
  id: string;
  label: string;
  css: string;
  type: "gradient" | "photo";
  thumbnail?: string; // smaller version for picker
};

const UQ = "?w=1920&h=1080&fit=crop&q=80";
const TQ = "?w=200&h=120&fit=crop&q=60";

// Scenic HD photos from Unsplash (free license)
export const WALLPAPERS: Wallpaper[] = [
  {
    id: "texas-hills",
    label: "Texas Hill Country",
    type: "photo",
    css: `url(https://images.unsplash.com/photo-1500382017468-9049fed747ef${UQ})`,
    thumbnail: `https://images.unsplash.com/photo-1500382017468-9049fed747ef${TQ}`,
  },
  {
    id: "mountain-lake",
    label: "Mountain Lake",
    type: "photo",
    css: `url(https://images.unsplash.com/photo-1439066615861-d1af74d74000${UQ})`,
    thumbnail: `https://images.unsplash.com/photo-1439066615861-d1af74d74000${TQ}`,
  },
  {
    id: "ocean-coast",
    label: "Ocean Coast",
    type: "photo",
    css: `url(https://images.unsplash.com/photo-1507525428034-b723cf961d3e${UQ})`,
    thumbnail: `https://images.unsplash.com/photo-1507525428034-b723cf961d3e${TQ}`,
  },
  {
    id: "northern-lights",
    label: "Northern Lights",
    type: "photo",
    css: `url(https://images.unsplash.com/photo-1483347756197-71ef80e95f73${UQ})`,
    thumbnail: `https://images.unsplash.com/photo-1483347756197-71ef80e95f73${TQ}`,
  },
  {
    id: "forest",
    label: "Forest",
    type: "photo",
    css: `url(https://images.unsplash.com/photo-1448375240586-882707db888b${UQ})`,
    thumbnail: `https://images.unsplash.com/photo-1448375240586-882707db888b${TQ}`,
  },
  {
    id: "desert",
    label: "Desert",
    type: "photo",
    css: `url(https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9${UQ})`,
    thumbnail: `https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9${TQ}`,
  },
  {
    id: "snowy-peaks",
    label: "Snowy Peaks",
    type: "photo",
    css: `url(https://images.unsplash.com/photo-1464822759023-fed622ff2c3b${UQ})`,
    thumbnail: `https://images.unsplash.com/photo-1464822759023-fed622ff2c3b${TQ}`,
  },
  {
    id: "tropical-sunset",
    label: "Tropical Sunset",
    type: "photo",
    css: `url(https://images.unsplash.com/photo-1506929562872-bb421503ef21${UQ})`,
    thumbnail: `https://images.unsplash.com/photo-1506929562872-bb421503ef21${TQ}`,
  },
  // Solid gradients
  {
    id: "gradient-dusk",
    label: "Dusk",
    type: "gradient",
    css: "linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)",
  },
  {
    id: "gradient-ocean",
    label: "Ocean Gradient",
    type: "gradient",
    css: "linear-gradient(135deg, #141e30 0%, #243b55 100%)",
  },
  {
    id: "gradient-aurora",
    label: "Aurora Gradient",
    type: "gradient",
    css: "linear-gradient(135deg, #0b486b 0%, #3b8d99 50%, #6b93d6 100%)",
  },
  {
    id: "gradient-sunset",
    label: "Sunset Gradient",
    type: "gradient",
    css: "linear-gradient(135deg, #2c1654 0%, #6b2fa0 30%, #d4418e 60%, #fb8b24 100%)",
  },
  {
    id: "gradient-midnight",
    label: "Midnight",
    type: "gradient",
    css: "linear-gradient(135deg, #020024 0%, #090979 50%, #00d4ff 100%)",
  },
  {
    id: "solid-dark",
    label: "Dark",
    type: "gradient",
    css: "#1a1a2e",
  },
];

export const DEFAULT_WALLPAPER_ID = "texas-hills";

export function getWallpaperById(id: string): Wallpaper | undefined {
  return WALLPAPERS.find((w) => w.id === id);
}
