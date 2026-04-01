import { Store as TauriStore } from "@tauri-apps/plugin-store";

export const CHAT_HISTORY_STORE_FILE = "entropic-chat-history.json";
export const CHAT_HISTORY_CLEARED_EVENT = "entropic-chats-cleared";

let chatStore: TauriStore | null = null;

export async function getChatHistoryStore(): Promise<TauriStore> {
  if (!chatStore) {
    chatStore = await TauriStore.load(CHAT_HISTORY_STORE_FILE);
  }
  return chatStore;
}

export async function clearPersistedChatHistory(): Promise<void> {
  const store = await getChatHistoryStore();
  await store.clear();
  await store.save();
}
