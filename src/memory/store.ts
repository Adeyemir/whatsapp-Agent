import { config } from "../config.js";
import fs from "fs";
import path from "path";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string }; // URL string

export interface Message {
  role: "user" | "assistant";
  content: string | ContentPart[];
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

// Sanitize messages before writing to disk.
// base64 data URLs can be 100KB+ each — strip them to a compact placeholder
// so conversations.json stays small. The in-memory store keeps the full data
// for the current session; after a restart the image is gone but context survives.
function sanitizeForDisk(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return m;
    return {
      ...m,
      content: m.content.map((part): ContentPart => {
        if (part.type === "image" && part.image.startsWith("data:")) {
          return { type: "text", text: "[image sent by user — not stored]" };
        }
        return part;
      }),
    };
  });
}

// Persist the whole store. Called after each mutation; volume is low enough
// that a full rewrite is fine.
function persist(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const obj: Record<string, Message[]> = {};
    for (const [key, msgs] of store.entries()) {
      obj[key] = sanitizeForDisk(msgs);
    }
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
