// The looks a built app can have. Each is exact: tokens a stylesheet can be written from, and a
// short guide to how the shared pieces look. They ship with the server and reach a build through
// its prompt (the design brief), so they apply to every workspace and are never copied into a
// customer's code as instructions. Token names match the mobile-first skill's base.css, plus
// `--control-border`, `--radius-s`, `--font-body` and `--font-heading`.
//
// Every style meets that skill's floor (16px text, 44px taps, 8px between them) and WCAG AA
// contrast in both themes; __tests__/designStyles.test.ts checks each one.
import { AA_TEXT, AA_UI } from "./contrast.ts";

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const COLOR_TOKENS = [
  "bg",
  "surface",
  "text",
  "textMuted",
  // Hairlines between rows and around cards; decoration only.
  "border",
  // The edge of an input, select or secondary button: what a person sees the control by.
  "controlBorder",
  "accent",
  "accentText",
  "danger",
  "focus",
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];
export type Colors = Readonly<Record<ColorToken, string>>;

export type Style = {
  readonly id: string;
  readonly name: string;
  // What the person is told about the look, in plain words.
  readonly summary: string;
  readonly useWhen: string;
  readonly avoidWhen: string;
  readonly colors: Readonly<Record<Theme, Colors>>;
  readonly type: {
    // Font stacks of fonts already on the device; no web fonts.
    readonly body: string;
    readonly headings: string;
    readonly headingWeight: number;
    readonly lineHeight: number;
    // rem, so 1 is 16px.
    readonly scale: {
      readonly s: number;
      readonly m: number;
      readonly l: number;
      readonly xl: number;
    };
    readonly numbers: "tabular-nums" | "normal";
  };
  // px.
  readonly space: {
    readonly 1: number;
    readonly 2: number;
    readonly 3: number;
    readonly 4: number;
    readonly 6: number;
    readonly 8: number;
    readonly tap: number;
    readonly pageWidth: number;
  };
  // px; 999 makes a pill.
  readonly radius: { readonly s: number; readonly m: number; readonly button: number };
  readonly pieces: {
    readonly frame: string;
    readonly menu: string;
    readonly table: string;
    readonly form: string;
    readonly button: string;
    readonly empty: string;
  };
};

const SYSTEM_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const ROUNDED_SANS =
  'ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", sans-serif';
const BOOK_SERIF =
  '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';

export const STYLES: readonly Style[] = [
  {
    id: "calm",
    name: "Calm",
    summary:
      "Calm and spacious: soft greens and grays, lots of room, rounded cards, one clear action per screen.",
    useWhen:
      "People book, sign up, or look after their own details: appointments, client portals, services, health and wellbeing.",
    avoidWhen:
      "The work is long lists and numbers compared across rows; the room it leaves makes those slow to scan.",
    colors: {
      light: {
        bg: "#f5f7f6",
        surface: "#ffffff",
        text: "#1d2724",
        textMuted: "#52605b",
        border: "#dfe5e2",
        controlBorder: "#84918c",
        accent: "#0f6b5c",
        accentText: "#ffffff",
        danger: "#b42318",
        focus: "#0f6b5c",
      },
      dark: {
        bg: "#111715",
        surface: "#1a2220",
        text: "#e8efec",
        textMuted: "#a3b1ab",
        border: "#2c3633",
        controlBorder: "#6f7d78",
        accent: "#5fd0b8",
        accentText: "#062a23",
        danger: "#ff9b8f",
        focus: "#5fd0b8",
      },
    },
    type: {
      body: SYSTEM_SANS,
      headings: SYSTEM_SANS,
      headingWeight: 600,
      lineHeight: 1.6,
      scale: { s: 0.875, m: 1, l: 1.375, xl: 2.125 },
      numbers: "normal",
    },
    space: { 1: 4, 2: 8, 3: 16, 4: 20, 6: 32, 8: 48, tap: 48, pageWidth: 680 },
    radius: { s: 8, m: 14, button: 10 },
    pieces: {
      frame:
        "One centered column capped at --page-width, --space-6 between sections. Content sits in white cards with no border and a soft shadow (0 1px 3px of --text at 8%) on --bg.",
      menu: "A bottom bar on a phone with an icon-free text label per place; a quiet top bar on wide screens. The current place is --accent text with a 3px --accent underline; the rest are --text-muted.",
      table:
        "Avoid tables; use a list of cards, one record per card, name first in --text-l, one or two facts below in --text-muted. Where a table is unavoidable: no fills, --space-3 cell padding, a hairline --border between rows.",
      form: "One column, label above the field in --text-s at weight 600, --space-4 between fields, fields 48px tall with --radius-s and --control-border. The primary button is full width on a phone and last.",
      button:
        "Primary: --accent fill, --accent-text, --radius button, 48px tall, weight 600. Secondary: transparent with a 1px --control-border. Danger: --danger text, transparent, set apart from the primary.",
      empty:
        "Centered in a card with --space-8 padding: one sentence that says what will be here in --text-muted, then the primary button that adds the first one.",
    },
  },
  {
    id: "ledger",
    name: "Ledger",
    summary:
      "Dense and orderly: cool grays, compact rows, aligned numbers, so a lot fits on one screen.",
    useWhen:
      "Staff work through many records every day: inventory, orders, invoices, stock, timesheets, bookings seen from the back office.",
    avoidWhen:
      "Members of the public use it once or twice; the density reads as busy to someone new.",
    colors: {
      light: {
        bg: "#f3f4f6",
        surface: "#ffffff",
        text: "#111827",
        textMuted: "#4b5563",
        border: "#e5e7eb",
        controlBorder: "#848b96",
        accent: "#1d4ed8",
        accentText: "#ffffff",
        danger: "#b91c1c",
        focus: "#1d4ed8",
      },
      dark: {
        bg: "#0d1117",
        surface: "#161b22",
        text: "#e6edf3",
        textMuted: "#9da7b3",
        border: "#30363d",
        controlBorder: "#6e7681",
        accent: "#58a6ff",
        accentText: "#0d1117",
        danger: "#ff7b72",
        focus: "#58a6ff",
      },
    },
    type: {
      body: SYSTEM_SANS,
      headings: SYSTEM_SANS,
      headingWeight: 600,
      lineHeight: 1.45,
      scale: { s: 0.875, m: 1, l: 1.125, xl: 1.5 },
      numbers: "tabular-nums",
    },
    space: { 1: 4, 2: 8, 3: 10, 4: 12, 6: 16, 8: 24, tap: 44, pageWidth: 1200 },
    radius: { s: 4, m: 6, button: 6 },
    pieces: {
      frame:
        "Full width up to --page-width with --space-4 page margins. Panels are --surface with a 1px --border and --radius m, no shadow. A header row holds the screen's h1 on the left and its primary action on the right.",
      menu: "A bottom bar on a phone; on wide screens a top bar with the app name left and the places beside it. The current place is --text at weight 600 with a 2px --accent bar under it.",
      table:
        "The main view of records on wide screens: --text-s header in --text-muted, rows at least 44px with --space-2 vertical padding, a hairline --border between rows, numbers right-aligned in tabular figures, the header sticky. On a phone it becomes a list of compact cards with two facts per line.",
      form: "Label above the field; on screens 768px and up, short fields (dates, amounts, codes) sit two per row. Fields 44px tall, --radius s, --control-border. Buttons sit together at the end, primary first.",
      button:
        "Primary: --accent fill, --accent-text, --radius button, 44px tall, compact --space-4 side padding. Secondary: --surface with a 1px --control-border. Danger: --danger text with a --danger border.",
      empty:
        "Left-aligned inside the panel where the table would be: one line in --text-muted and the primary button beside it.",
    },
  },
  {
    id: "friendly",
    name: "Friendly",
    summary:
      "Warm and friendly: cream and terracotta, round shapes, pill buttons, a little larger text.",
    useWhen:
      "Customers and members use it: clubs, classes, community groups, family businesses, sign-up sheets, small shops taking orders.",
    avoidWhen:
      "It handles money, records or anything people expect to look formal; the warmth reads as casual.",
    colors: {
      light: {
        bg: "#fdf8f3",
        surface: "#ffffff",
        text: "#2b211c",
        textMuted: "#6b5a50",
        border: "#efe3d8",
        controlBorder: "#9c8679",
        accent: "#9a3412",
        accentText: "#ffffff",
        danger: "#b91c4b",
        focus: "#9a3412",
      },
      dark: {
        bg: "#1c1613",
        surface: "#261e1a",
        text: "#f6ece4",
        textMuted: "#c4b2a6",
        border: "#3d322c",
        controlBorder: "#8b776b",
        accent: "#ffb38a",
        accentText: "#3a1606",
        danger: "#ff8fa8",
        focus: "#ffb38a",
      },
    },
    type: {
      body: ROUNDED_SANS,
      headings: ROUNDED_SANS,
      headingWeight: 700,
      lineHeight: 1.55,
      scale: { s: 0.9375, m: 1.0625, l: 1.375, xl: 2 },
      numbers: "normal",
    },
    space: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 40, tap: 48, pageWidth: 720 },
    radius: { s: 12, m: 20, button: 999 },
    pieces: {
      frame:
        "One centered column capped at --page-width. A greeting h1 at the top of the home screen. Cards are --surface with --radius m, a 1px --border, and --space-6 padding.",
      menu: "A bottom bar on a phone; a row of pills on wide screens. The current place is a filled pill: --accent with --accent-text.",
      table:
        "Use a list of cards, not a table: each card leads with the name in --text-l weight 700 and one fact below. Where a table is unavoidable, round its container with --radius m and give rows --space-3 padding.",
      form: "One column, label above the field at weight 600, hints in --text-muted below the label, fields 48px tall with --radius s. The primary button is a full-width pill on a phone.",
      button:
        "Primary: --accent pill (--radius button), --accent-text, 48px tall, weight 700. Secondary: a pill with a 1px --control-border. Danger: --danger text, never a filled pill.",
      empty:
        "Centered: one warm sentence that says what will appear here and invites the first one, then the primary pill.",
    },
  },
  {
    id: "bold",
    name: "Bold",
    summary:
      "Bold and high-contrast: black and white with a yellow highlight, big type, thick edges, square corners.",
    useWhen:
      "It is used quickly, outdoors, on the move or by people who need large, clear controls: field work, check-ins, warehouses, deliveries, sign-in desks.",
    avoidWhen:
      "People browse or read at length, or the business's brand is soft; the weight tires the eye over long pages.",
    colors: {
      light: {
        bg: "#ffffff",
        surface: "#ffffff",
        text: "#000000",
        textMuted: "#3d3d3d",
        border: "#000000",
        controlBorder: "#000000",
        accent: "#0a0a0a",
        accentText: "#ffe14d",
        danger: "#c00000",
        focus: "#0047ff",
      },
      dark: {
        bg: "#000000",
        surface: "#000000",
        text: "#ffffff",
        textMuted: "#d0d0d0",
        border: "#ffffff",
        controlBorder: "#ffffff",
        accent: "#ffe14d",
        accentText: "#000000",
        danger: "#ff6b6b",
        focus: "#6ea8ff",
      },
    },
    type: {
      body: SYSTEM_SANS,
      headings: SYSTEM_SANS,
      headingWeight: 800,
      lineHeight: 1.4,
      scale: { s: 1, m: 1.125, l: 1.5, xl: 2.5 },
      numbers: "tabular-nums",
    },
    space: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, tap: 56, pageWidth: 760 },
    radius: { s: 0, m: 0, button: 0 },
    pieces: {
      frame:
        "One column capped at --page-width with --space-4 margins. Sections are separated by a 2px --border rule, not cards. The h1 is --text-xl weight 800.",
      menu: "A bottom bar on a phone of at most four places, 56px tall; a top bar on wide screens. The current place has --accent fill with --accent-text.",
      table:
        "Use a list of rows with a 2px --border between them, each at least 56px, name in weight 700 and the key fact on the right. A real table has a 2px --border under the header and tabular figures.",
      form: "One column, label above the field in weight 700, fields 56px tall with a 2px --control-border and square corners. One primary button, full width.",
      button:
        "Primary: --accent fill, --accent-text, 56px tall, weight 800, square. Secondary: transparent with a 2px --control-border. Danger: --danger text with a 2px --danger border.",
      empty:
        "A bordered block (2px dashed --border) with one short sentence in --text-l and the primary button under it.",
    },
  },
  {
    id: "editorial",
    name: "Editorial",
    summary:
      "Quiet and editorial: paper tones, book-style headings, hairline rules instead of boxes, made for reading.",
    useWhen:
      "People mostly read and look things up: catalogs, menus, directories, portfolios, collections, notices and newsletters.",
    avoidWhen:
      "Most screens are forms or busy tables; the reading layout spends room that data entry needs.",
    colors: {
      light: {
        bg: "#fbfaf7",
        surface: "#fbfaf7",
        text: "#1f1d1a",
        textMuted: "#5f5a52",
        border: "#e4e0d8",
        controlBorder: "#8c867b",
        accent: "#1f3a68",
        accentText: "#ffffff",
        danger: "#a61b1b",
        focus: "#1f3a68",
      },
      dark: {
        bg: "#171614",
        surface: "#171614",
        text: "#ece8e1",
        textMuted: "#aaa398",
        border: "#34312c",
        controlBorder: "#77716a",
        accent: "#9ab8ec",
        accentText: "#101a2c",
        danger: "#f29b8f",
        focus: "#9ab8ec",
      },
    },
    type: {
      body: BOOK_SERIF,
      headings: BOOK_SERIF,
      headingWeight: 600,
      lineHeight: 1.65,
      scale: { s: 0.9375, m: 1.0625, l: 1.5, xl: 2.375 },
      numbers: "normal",
    },
    space: { 1: 4, 2: 8, 3: 12, 4: 20, 6: 32, 8: 56, tap: 44, pageWidth: 640 },
    radius: { s: 2, m: 2, button: 2 },
    pieces: {
      frame:
        "One narrow centered column capped at --page-width. No cards: sections are separated by --space-8 and a hairline --border rule. Links are --accent and underlined.",
      menu: "A bottom bar on a phone; on wide screens the app name in the heading font with the places in a row of plain text links beside it. The current place is --text, underlined.",
      table:
        "A list with a hairline --border between entries, the name in the heading font at --text-l and a line of detail in --text-muted. A real table has rules between rows only, no fills, figures aligned.",
      form: "One column, labels above fields in the body font, fields 44px tall with a 1px --control-border and nearly square corners. Forms use system-ui for the text typed in, so numbers read clearly.",
      button:
        "Primary: --accent fill, --accent-text, 44px tall, --radius button. Secondary: an underlined --accent text button. Danger: --danger underlined text, set apart.",
      empty:
        "A short line in italics in --text-muted where the list would be, with the primary button under it.",
    },
  },
];

export const DEFAULT_STYLE = "calm";

export const styleById = (id: string): Style | undefined => STYLES.find((style) => style.id === id);

// The CSS custom property a token is written to: textMuted is --text-muted.
export const cssName = (token: string): string =>
  `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

export type ContrastPair = {
  readonly name: string;
  readonly fg: string;
  readonly bg: string;
  readonly min: number;
};

const TEXT_PAIRS: readonly (readonly [ColorToken, ColorToken])[] = [
  ["text", "bg"],
  ["text", "surface"],
  ["textMuted", "bg"],
  ["textMuted", "surface"],
  ["accent", "bg"],
  ["accent", "surface"],
  ["accentText", "accent"],
  ["danger", "bg"],
  ["danger", "surface"],
];
const UI_PAIRS: readonly (readonly [ColorToken, ColorToken])[] = [
  ["controlBorder", "bg"],
  ["controlBorder", "surface"],
  ["focus", "bg"],
  ["focus", "surface"],
];

// Every pair of colors a person must be able to tell apart, with the ratio WCAG AA asks of it.
export const contrastPairs = (colors: Colors): readonly ContrastPair[] =>
  [
    ...TEXT_PAIRS.map((pair) => [...pair, AA_TEXT] as const),
    ...UI_PAIRS.map((pair) => [...pair, AA_UI] as const),
  ].map(([fg, bg, min]) => ({
    name: `${cssName(fg).slice(2)} on ${cssName(bg).slice(2)}`,
    fg: colors[fg],
    bg: colors[bg],
    min,
  }));
