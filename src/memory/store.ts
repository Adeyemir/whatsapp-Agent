import { config } from "../config.js";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

// In-memory store: WhatsApp phone number → conversation history
// In production, swap this Map for a Redis client
const store = new Map<string, Message[]>();

export function getHistory(phoneNumber: string): Message[] {
  return store.get(phoneNumber) ?? [];
}

export function addMessage(phoneNumber: string, message: Message): void {
  const history = store.get(phoneNumber) ?? [];
  history.push(message);

  // Keep only the last N messages to avoid token bloat
  if (history.length > config.MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - config.MAX_HISTORY_MESSAGES);
  }

  store.set(phoneNumber, history);
}

export function clearHistory(phoneNumber: string): void {
  store.delete(phoneNumber);
  console.log(`🗑️  Cleared conversation history for ${phoneNumber}`);
}

export function getConversationCount(): number {
  return store.size;
}
