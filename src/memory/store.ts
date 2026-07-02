import { config } from "../config.js";
import fs from "fs";
import path from "path";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

// Conversation history persisted to disk so context survives restarts.
// WhatsApp phone number → message history.
// For higher volume, swap this file for Redis or a database.
const DATA_DIR = path.resolve(process.cwd(), ".data");
const STORE_FILE = path.join(DATA_DIR, "conversations.json");

const store = new Map<string, Message[]>();

// Load any existing history on startup.
function load(): void {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, "utf8");
      const obj = JSON.parse(raw) as Record<string, Message[]>;
      for (const [key, msgs] of Object.entries(obj)) {
        store.set(key, msgs);
      }
      console.log(`💾  Loaded ${store.size} conversation(s) from disk`);
    }
  } catch (err) {
    console.error(`⚠️  Could not load conversation store: ${(err as Error).message}`);
  }
}

// Persist the whole store. Called after each mutation; volume is low enough
// that a full rewrite is fine.
function persist(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const obj = Object.fromEntries(store.entries());
    fs.writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.error(`⚠️  Could not persist conversation store: ${(err as Error).message}`);
  }
}

load();

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
  persist();
}

export function clearHistory(phoneNumber: string): void {
  store.delete(phoneNumber);
  persist();
  console.log(`🗑️  Cleared conversation history for ${phoneNumber}`);
}

export function getConversationCount(): number {
  return store.size;
}
