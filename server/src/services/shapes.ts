// App shapes: working starting points the template ships for common kinds of app (schmeide/template
// docs/shapes/). A first build keeps the shapes its spec needs (`make shape/keep`) and the template
// deletes the rest. Pure: the activity runs make and stores the choice (temporal/activities.ts).

// Kept when no shape fits: the template's sample, which a build replaces. Today's behavior.
export const FALLBACK_SHAPE = "notes";

// Words in a spec that call for a shape besides its own name, from each shape's doc in the
// template. A shape missing here still matches by name.
// ponytail: keyword match, so a passing word ("orders of magnitude") can keep a shape the build
// then has to drop. Ask a model to choose from the shape docs if wrong picks show up.
const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  assets: ["asset register", "registry", "vendor list", "directory", "expiry", "licenses?"],
  bookings: [
    "booking",
    "appointments?",
    "reservations?",
    "schedul\\w*",
    "shifts?",
    "dispatch",
    "classes",
    "rentals?",
  ],
  customers: ["client list", "contact list"],
  dashboard: ["kpis?", "reports?", "metrics"],
  deals: ["pipeline", "crm", "leads?", "applicants?", "tickets?", "task board"],
  handbook: ["sops?", "wiki", "policies", "policy", "training"],
  invoices: [
    "invoic\\w*",
    "quotes?",
    "estimates?",
    "purchase orders?",
    "work orders?",
    "receipts?",
  ],
  orders: ["storefront", "order form", "cart", "catalog", "menu ordering"],
  requests: [
    "approvals?",
    "leave requests?",
    "time off",
    "expense claims?",
    "inspections?",
    "intake",
  ],
  stock: ["inventory", "ledger", "time tracking", "mileage", "loyalty points"],
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The name, or the name without its plural s, as a whole word.
const nameWord = (name: string) => {
  const singular = name.endsWith("s") ? name.slice(0, -1) : name;
  return `${escape(singular)}s?`;
};

// Where `spec` first calls for `shape`, or -1.
const firstMention = (spec: string, shape: string): number => {
  const words = [nameWord(shape), ...(KEYWORDS[shape] ?? [])];
  const found = new RegExp(`\\b(?:${words.join("|")})\\b`, "i").exec(spec);
  return found ? found.index : -1;
};

// The shapes of `available` that `spec` calls for, in the order it first names them: the first is
// the home page and the order is the menu's. Notes alone when none fits.
export const chooseShapes = (spec: string, available: readonly string[]): readonly string[] => {
  const chosen = available
    .filter((shape) => shape !== FALLBACK_SHAPE)
    .map((shape) => ({ shape, at: firstMention(spec, shape) }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(({ shape }) => shape);
  return chosen.length > 0 ? chosen : [FALLBACK_SHAPE];
};

// The names `make shape/list` printed, one per line, without what installing dependencies printed.
export const parseShapeList = (output: string): readonly string[] =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-z][a-z0-9-]*$/.test(line));

// The build prompt's part about the kept shapes. Empty for notes alone: the build replaces it.
export const shapesPrompt = (shapes: readonly string[]): string => {
  const kept = shapes.filter((shape) => shape !== FALLBACK_SHAPE);
  if (kept.length === 0) return "";
  return `This repository keeps the template's app shapes the spec needs, working code to start from: ${kept
    .map((shape) => `${shape} (docs/shapes/${shape}.md)`)
    .join(
      ", "
    )}. Read each shape's doc, then adapt the shape to the spec (rename it, change its fields and statuses) instead of rebuilding it. Delete what the spec does not need.`;
};
