import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Shield, Loader2, CheckCircle2, XCircle } from "lucide-react";

type SetupProgress = {
  stage: string;
  message: string;
  percent: number;
  complete: boolean;
  error: string | null;
};

type Props = {
  onComplete: () => void;
};

export function SetupScreen({ onComplete }: Props) {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<SetupProgress | null>(null);

  useEffect(() => {
    if (isRunning) {
      const interval = setInterval(async () => {
        const p = await invoke<SetupProgress>("get_setup_progress");
        setProgress(p);
        if (p.complete) {
          clearInterval(interval);
          setTimeout(onComplete, 1500);
        }
      }, 500);
      return () => clearInterval(interval);
    }
  }, [isRunning, onComplete]);

  async function startSetup() {
    setIsRunning(true);
    try {
      await invoke("run_first_time_setup");
    } catch (error) {
      console.error("Setup failed:", error);
    }
  }

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-gradient-to-b from-gray-50 to-gray-100 p-8">
      {/* Logo and Title */}
      <div className="mb-12 text-center">
        <div className="w-20 h-20 bg-gradient-to-br from-violet-500 to-purple-600 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg">
          <Shield className="w-10 h-10 text-white" />
        </div>
        <h1 className="text-3xl font-semibold text-gray-900 mb-2">
          Welcome to Zara
        </h1>
        <p className="text-gray-500 max-w-md">
          Your AI assistant with secure sandboxing. Commands run in an isolated
          container, keeping your system safe.
        </p>
      </div>

      {/* Setup Card */}
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
        {!isRunning && !progress?.complete && (
          <>
            <h2 className="text-lg font-medium text-gray-900 mb-4">
              First-Time Setup
            </h2>
            <p className="text-gray-500 text-sm mb-6">
              Zara needs to set up a secure sandbox environment. This downloads
              a small Linux VM (~300MB) and only needs to happen once.
            </p>
            <button
              onClick={startSetup}
              className="w-full py-3 px-4 bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-xl transition-colors"
            >
              Set Up Secure Sandbox
            </button>
          </>
        )}

        {isRunning && progress && !progress.complete && !progress.error && (
          <div className="text-center">
            <Loader2 className="w-12 h-12 text-violet-600 animate-spin mx-auto mb-4" />
            <p className="text-gray-900 font-medium mb-2">{progress.message}</p>
            <div className="w-full bg-gray-100 rounded-full h-2 mb-2">
              <div
                className="bg-violet-600 h-2 rounded-full transition-all duration-500"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <p className="text-gray-400 text-sm">{progress.percent}%</p>
          </div>
        )}

        {progress?.complete && (
          <div className="text-center">
            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-4" />
            <p className="text-gray-900 font-medium">Setup Complete!</p>
            <p className="text-gray-500 text-sm mt-1">
              Launching Zara...
            </p>
          </div>
        )}

        {progress?.error && (
          <div className="text-center">
            <XCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <p className="text-gray-900 font-medium mb-2">Setup Failed</p>
            <p className="text-red-500 text-sm mb-4">{progress.error}</p>
            <button
              onClick={() => {
                setIsRunning(false);
                setProgress(null);
              }}
              className="px-4 py-2 text-violet-600 hover:text-violet-700 font-medium"
            >
              Try Again
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <p className="mt-8 text-gray-400 text-sm">
        Powered by OpenClaw
      </p>
    </div>
  );
}
