import type { ChangeEvent, RefObject } from "react";
import { Image } from "lucide-react";
import { WALLPAPERS } from "../../lib/wallpapers";

type WallpaperPickerProps = {
  wallpaperId: string;
  customWallpaper: string | null;
  inputRef: RefObject<HTMLInputElement>;
  onSelectWallpaper: (id: string, custom?: string | null) => void | Promise<void>;
  onChooseCustom: () => void;
  onCustomUpload: (event: ChangeEvent<HTMLInputElement>) => void;
};

export function WallpaperPicker({
  wallpaperId,
  customWallpaper,
  inputRef,
  onSelectWallpaper,
  onChooseCustom,
  onCustomUpload,
}: WallpaperPickerProps) {
  return (
    <div
      className="absolute bottom-4 left-1/2 z-40 -translate-x-1/2 animate-fade-in rounded-xl p-4"
      style={{
        background: "rgba(20,20,20,0.92)",
        backdropFilter: "blur(20px)",
        border: "1px solid rgba(255,255,255,0.1)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <p className="mb-2 text-xs font-medium" style={{ color: "rgba(255,255,255,0.6)" }}>
        Scenic
      </p>
      <div className="mb-3 grid grid-cols-4 gap-2">
        {WALLPAPERS.filter((wallpaper) => wallpaper.type === "photo").map((wallpaper) => (
          <button
            key={wallpaper.id}
            type="button"
            onClick={() => {
              void onSelectWallpaper(wallpaper.id, null);
            }}
            className="h-10 w-16 overflow-hidden rounded-lg transition-transform hover:scale-105"
            style={{
              backgroundImage: wallpaper.thumbnail ? `url(${wallpaper.thumbnail})` : wallpaper.css,
              backgroundSize: "cover",
              backgroundPosition: "center",
              border: wallpaperId === wallpaper.id ? "2px solid white" : "2px solid transparent",
              boxShadow: wallpaperId === wallpaper.id ? "0 0 0 1px rgba(255,255,255,0.3)" : "none",
            }}
            title={wallpaper.label}
          />
        ))}
      </div>
      <p className="mb-2 text-xs font-medium" style={{ color: "rgba(255,255,255,0.6)" }}>
        Gradients
      </p>
      <div className="grid grid-cols-4 gap-2">
        {WALLPAPERS.filter((wallpaper) => wallpaper.type === "gradient").map((wallpaper) => (
          <button
            key={wallpaper.id}
            type="button"
            onClick={() => {
              void onSelectWallpaper(wallpaper.id, null);
            }}
            className="h-10 w-16 rounded-lg transition-transform hover:scale-105"
            style={{
              background: wallpaper.css,
              border: wallpaperId === wallpaper.id ? "2px solid white" : "2px solid transparent",
              boxShadow: wallpaperId === wallpaper.id ? "0 0 0 1px rgba(255,255,255,0.3)" : "none",
            }}
            title={wallpaper.label}
          />
        ))}
        <button
          type="button"
          onClick={onChooseCustom}
          className="flex h-10 w-16 items-center justify-center rounded-lg transition-transform hover:scale-105"
          style={{
            background: customWallpaper ? `url(${customWallpaper})` : "rgba(255,255,255,0.1)",
            backgroundSize: "cover",
            backgroundPosition: "center",
            border: wallpaperId === "custom" ? "2px solid white" : "2px solid transparent",
          }}
          title="Custom"
        >
          {!customWallpaper ? <Image className="h-4 w-4" style={{ color: "rgba(255,255,255,0.4)" }} /> : null}
        </button>
      </div>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={onCustomUpload} />
    </div>
  );
}
