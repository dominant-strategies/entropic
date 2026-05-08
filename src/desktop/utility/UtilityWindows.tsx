import {
  lazy,
  Suspense,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  CalendarClock,
  CreditCard,
  ListTodo,
  Puzzle,
  Radio,
  ScrollText,
  Settings as SettingsIcon,
  Sparkles,
} from "lucide-react";
import { AppWindow } from "../AppWindow";
import { getWindowZ, type WindowKey, type WindowPoint, type WindowResizeDirection, type WindowSize } from "../windowManager";
import type { VoiceSpeechVoice } from "../voice/voicePreferences";

const PluginStore = lazy(() => import("../../pages/Store").then((m) => ({ default: m.Store })));
const SkillsStore = lazy(() => import("../../pages/Store").then((m) => ({ default: m.Store })));
const Channels = lazy(() => import("../../pages/Channels").then((m) => ({ default: m.Channels })));
const Logs = lazy(() => import("../../pages/Logs").then((m) => ({ default: m.Logs })));
const Settings = lazy(() => import("../../pages/Settings").then((m) => ({ default: m.Settings })));
const Tasks = lazy(() => import("../../pages/Tasks").then((m) => ({ default: m.Tasks })));
const Jobs = lazy(() => import("../../pages/Jobs").then((m) => ({ default: m.Jobs })));
const BillingPage = lazy(() => import("../../pages/BillingPage").then((m) => ({ default: m.BillingPage })));

const PANEL_FALLBACK = (
  <div className="p-4 text-xs text-[var(--text-tertiary)]">Loading...</div>
);

type UtilityWindowKey =
  | "plugins"
  | "skills"
  | "channels"
  | "tasks"
  | "jobs"
  | "logs"
  | "billing"
  | "settings";

type UtilityWindowFrame = {
  open: boolean;
  position: WindowPoint;
  size: WindowSize;
};

type DesktopUtilityWindowsProps = {
  windowZ: Record<string, number>;
  windows: Record<UtilityWindowKey, UtilityWindowFrame>;
  active?: Partial<Record<UtilityWindowKey, boolean>>;
  billingEnabled: boolean;
  gatewayRunning: boolean;
  integrationsSyncing?: boolean;
  integrationsMissing?: boolean;
  onGatewayToggle: () => void;
  onApplyRuntimeResources?: () => void | Promise<void>;
  isTogglingGateway: boolean;
  selectedModel: string;
  onModelChange: (model: string) => void;
  useLocalKeys: boolean;
  onUseLocalKeysChange: (value: boolean) => void;
  codeModel: string;
  imageModel: string;
  imageGenerationModel: string;
  textToSpeechModel: string;
  audioUnderstandingModel: string;
  voiceShortcut: string;
  voiceSpeechRate: number;
  voiceSpeechVoice: VoiceSpeechVoice;
  onCodeModelChange: (model: string) => void;
  onImageGenerationModelChange: (model: string) => void;
  onTextToSpeechModelChange: (model: string) => void;
  onAudioUnderstandingModelChange: (model: string) => void;
  onVoiceShortcutChange: (shortcut: string) => void | Promise<void>;
  onVoiceSpeechRateChange: (rate: number) => void | Promise<void>;
  onVoiceSpeechVoiceChange: (voice: VoiceSpeechVoice) => void | Promise<void>;
  onImageModelChange: (model: string) => void;
  onClose: Record<UtilityWindowKey, () => void>;
  onFocus: (window: WindowKey) => void;
  onDragStart: Record<UtilityWindowKey, (event: ReactMouseEvent<HTMLElement>) => void>;
  onSkillsResizeStart: (
    direction: WindowResizeDirection,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
};

export function DesktopUtilityWindows({
  windowZ,
  windows,
  active = {},
  billingEnabled,
  gatewayRunning,
  integrationsSyncing,
  integrationsMissing,
  onGatewayToggle,
  onApplyRuntimeResources,
  isTogglingGateway,
  selectedModel,
  onModelChange,
  useLocalKeys,
  onUseLocalKeysChange,
  codeModel,
  imageModel,
  imageGenerationModel,
  textToSpeechModel,
  audioUnderstandingModel,
  voiceShortcut,
  voiceSpeechRate,
  voiceSpeechVoice,
  onCodeModelChange,
  onImageGenerationModelChange,
  onTextToSpeechModelChange,
  onAudioUnderstandingModelChange,
  onVoiceShortcutChange,
  onVoiceSpeechRateChange,
  onVoiceSpeechVoiceChange,
  onImageModelChange,
  onClose,
  onFocus,
  onDragStart,
  onSkillsResizeStart,
}: DesktopUtilityWindowsProps) {
  return (
    <>
      {windows.plugins.open && (
        <AppWindow
          title="Integrations"
          icon={Puzzle}
          position={windows.plugins.position}
          size={windows.plugins.size}
          zIndex={getWindowZ(windowZ, "plugins")}
          active={active.plugins ?? true}
          onClose={onClose.plugins}
          onFocus={() => onFocus("plugins")}
          onDragStart={onDragStart.plugins}
        >
          <Suspense fallback={PANEL_FALLBACK}>
            <PluginStore
              view="integrations"
              integrationsSyncing={integrationsSyncing}
              integrationsMissing={integrationsMissing}
            />
          </Suspense>
        </AppWindow>
      )}

      {windows.skills.open && (
        <AppWindow
          title="Skills"
          icon={Sparkles}
          position={windows.skills.position}
          size={windows.skills.size}
          zIndex={getWindowZ(windowZ, "skills")}
          active={active.skills ?? true}
          onClose={onClose.skills}
          onFocus={() => onFocus("skills")}
          onDragStart={onDragStart.skills}
          onResizeStart={onSkillsResizeStart}
        >
          <Suspense fallback={PANEL_FALLBACK}>
            <SkillsStore
              view="skills"
              integrationsSyncing={integrationsSyncing}
              integrationsMissing={integrationsMissing}
            />
          </Suspense>
        </AppWindow>
      )}

      {windows.channels.open && (
        <AppWindow
          title="Messaging"
          icon={Radio}
          position={windows.channels.position}
          size={windows.channels.size}
          zIndex={getWindowZ(windowZ, "channels")}
          active={active.channels ?? true}
          onClose={onClose.channels}
          onFocus={() => onFocus("channels")}
          onDragStart={onDragStart.channels}
        >
          <Suspense fallback={PANEL_FALLBACK}>
            <Channels />
          </Suspense>
        </AppWindow>
      )}

      {windows.tasks.open && (
        <AppWindow
          title="Tasks"
          icon={ListTodo}
          position={windows.tasks.position}
          size={windows.tasks.size}
          zIndex={getWindowZ(windowZ, "tasks")}
          active={active.tasks ?? true}
          onClose={onClose.tasks}
          onFocus={() => onFocus("tasks")}
          onDragStart={onDragStart.tasks}
        >
          <Suspense fallback={PANEL_FALLBACK}>
            <Tasks gatewayRunning={gatewayRunning} />
          </Suspense>
        </AppWindow>
      )}

      {windows.jobs.open && (
        <AppWindow
          title="Jobs"
          icon={CalendarClock}
          position={windows.jobs.position}
          size={windows.jobs.size}
          zIndex={getWindowZ(windowZ, "jobs")}
          active={active.jobs ?? true}
          onClose={onClose.jobs}
          onFocus={() => onFocus("jobs")}
          onDragStart={onDragStart.jobs}
        >
          <Suspense fallback={PANEL_FALLBACK}>
            <Jobs gatewayRunning={gatewayRunning} />
          </Suspense>
        </AppWindow>
      )}

      {windows.logs.open && (
        <AppWindow
          title="Logs"
          icon={ScrollText}
          position={windows.logs.position}
          size={windows.logs.size}
          zIndex={getWindowZ(windowZ, "logs")}
          active={active.logs ?? true}
          onClose={onClose.logs}
          onFocus={() => onFocus("logs")}
          onDragStart={onDragStart.logs}
        >
          <Suspense fallback={PANEL_FALLBACK}>
            <Logs />
          </Suspense>
        </AppWindow>
      )}

      {billingEnabled && windows.billing.open && (
        <AppWindow
          title="Billing"
          icon={CreditCard}
          position={windows.billing.position}
          size={windows.billing.size}
          zIndex={getWindowZ(windowZ, "billing")}
          active={active.billing ?? true}
          onClose={onClose.billing}
          onFocus={() => onFocus("billing")}
          onDragStart={onDragStart.billing}
        >
          <Suspense fallback={PANEL_FALLBACK}>
            <BillingPage />
          </Suspense>
        </AppWindow>
      )}

      {windows.settings.open && (
        <AppWindow
          title="Settings"
          icon={SettingsIcon}
          position={windows.settings.position}
          size={windows.settings.size}
          zIndex={getWindowZ(windowZ, "settings")}
          active={active.settings ?? true}
          onClose={onClose.settings}
          onFocus={() => onFocus("settings")}
          onDragStart={onDragStart.settings}
        >
          <Suspense fallback={PANEL_FALLBACK}>
            <Settings
              gatewayRunning={gatewayRunning}
              onGatewayToggle={onGatewayToggle}
              onApplyRuntimeResources={onApplyRuntimeResources}
              isTogglingGateway={isTogglingGateway}
              selectedModel={selectedModel}
              onModelChange={onModelChange}
              useLocalKeys={useLocalKeys}
              onUseLocalKeysChange={onUseLocalKeysChange}
              codeModel={codeModel}
              imageModel={imageModel}
              imageGenerationModel={imageGenerationModel}
              textToSpeechModel={textToSpeechModel}
              audioUnderstandingModel={audioUnderstandingModel}
              voiceShortcut={voiceShortcut}
              voiceSpeechRate={voiceSpeechRate}
              voiceSpeechVoice={voiceSpeechVoice}
              onCodeModelChange={onCodeModelChange}
              onImageGenerationModelChange={onImageGenerationModelChange}
              onTextToSpeechModelChange={onTextToSpeechModelChange}
              onAudioUnderstandingModelChange={onAudioUnderstandingModelChange}
              onVoiceShortcutChange={onVoiceShortcutChange}
              onVoiceSpeechRateChange={onVoiceSpeechRateChange}
              onVoiceSpeechVoiceChange={onVoiceSpeechVoiceChange}
              onImageModelChange={onImageModelChange}
            />
          </Suspense>
        </AppWindow>
      )}
    </>
  );
}
