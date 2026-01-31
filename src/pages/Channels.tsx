import { MessageCircle, Plus } from "lucide-react";

type Channel = {
  id: string;
  name: string;
  type: "discord" | "telegram" | "whatsapp" | "slack";
  status: "connected" | "disconnected";
};

export function Channels() {
  const channels: Channel[] = [];

  return (
    <div className="p-6">
      <div className="max-w-2xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Channels</h1>
            <p className="text-sm text-gray-500">
              Connect messaging platforms to chat with AI
            </p>
          </div>
          <button className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors">
            <Plus className="w-4 h-4" />
            Add Channel
          </button>
        </div>

        {channels.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
            <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center mx-auto mb-4">
              <MessageCircle className="w-6 h-6 text-gray-400" />
            </div>
            <h3 className="font-medium text-gray-900 mb-1">No channels connected</h3>
            <p className="text-sm text-gray-500 mb-4">
              Connect Discord, Telegram, or WhatsApp to chat with AI from anywhere
            </p>
            <button className="text-sm text-violet-600 hover:text-violet-700 font-medium">
              Add your first channel
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {channels.map((channel) => (
              <div
                key={channel.id}
                className="bg-white border border-gray-200 rounded-xl p-4 flex items-center gap-4"
              >
                <div className="w-10 h-10 bg-gray-100 rounded-lg" />
                <div className="flex-1">
                  <p className="font-medium text-gray-900">{channel.name}</p>
                  <p className="text-sm text-gray-500 capitalize">{channel.type}</p>
                </div>
                <div
                  className={`px-2 py-1 rounded text-xs font-medium ${
                    channel.status === "connected"
                      ? "bg-green-100 text-green-700"
                      : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {channel.status}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
