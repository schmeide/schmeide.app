// The sentence someone typed on schmeide.com, held in this tab only. It arrives in the fragment
// (`/go#idea=…`), which the browser never sends to a server, and moves here at once. It is cleared
// once /new has used it, or after an hour. It reaches the server only when the person creates the app.

// The same limit as NEED_MAX on newProjectSchema (server/src/db/schema.ts). A longer idea is dropped.
export const IDEA_MAX = 2000;

const KEY = "schmeide:carried-idea";
export const CARRIED_IDEA_MS = 60 * 60 * 1000;

type Recorded = { readonly text: string; readonly at: number };

const isRecorded = (value: unknown): value is Recorded =>
  typeof value === "object" &&
  value !== null &&
  "text" in value &&
  typeof value.text === "string" &&
  "at" in value &&
  typeof value.at === "number";

// The idea in a fragment (`#idea=…`), trimmed. Empty, or longer than `max`, is dropped.
export const ideaFrom = (hash: string, max = IDEA_MAX): string | null => {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!body) return null;
  const idea = new URLSearchParams(body).get("idea");
  if (idea === null) return null;
  const text = idea.trim();
  if (!text || text.length > max) return null;
  return text;
};

const drop = (): void => {
  sessionStorage.removeItem(KEY);
};

// The idea this tab is carrying, or null when there is none, it is too old, or storage is blocked.
export const readCarried = (now = Date.now()): string | null => {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      drop();
      return null;
    }
    if (
      !isRecorded(value) ||
      !value.text.trim() ||
      value.text.length > IDEA_MAX ||
      now - value.at >= CARRIED_IDEA_MS
    ) {
      drop();
      return null;
    }
    return value.text;
  } catch {
    return null;
  }
};

// Keeps `text` for this tab. A blank or over-long value is not stored. Storage being unavailable
// (a private window) is ignored: the idea still holds on the page that has it.
export const writeCarried = (text: string, now = Date.now()): void => {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > IDEA_MAX) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ text: trimmed, at: now } satisfies Recorded));
  } catch {
    // Not kept. The page that already read it still has it.
  }
};

export const clearCarried = (): void => {
  try {
    drop();
  } catch {
    // Already gone, or storage is blocked.
  }
};
