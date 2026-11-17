// What can be told about a built app on a phone from its files alone, without a browser.
// ponytail: static only; opening the app in a browser at phone width needs a browser where checks run.

export type BuiltApp = {
  // frontend/dist/index.html
  readonly html: string;
  // The text of every stylesheet in the build.
  readonly css: readonly string[];
};

// The narrowest phone a screen has to fit.
export const NARROWEST_PHONE_PX = 320;
const ROOT_FONT_PX = 16;
const MAX_FIXED_WIDTHS = 10;

const attribute = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
    .exec(tag)
    ?.slice(1)
    .find((value) => value !== undefined);

const viewportOf = (html: string): string | undefined => {
  const tag = (html.match(/<meta\b[^>]*>/gi) ?? []).find(
    (meta) => attribute(meta, "name")?.toLowerCase() === "viewport"
  );
  return tag === undefined ? undefined : (attribute(tag, "content") ?? "");
};

const viewportProblems = (html: string): readonly string[] => {
  const content = viewportOf(html)?.toLowerCase().replace(/\s+/g, "");
  if (!content?.includes("width=device-width")) {
    return [
      'frontend/index.html needs `<meta name="viewport" content="width=device-width, initial-scale=1.0" />` in its head. Without it a phone shows the page zoomed out.',
    ];
  }
  const maximum = /maximum-scale=([\d.]+)/.exec(content)?.[1];
  const blocksZoom =
    /user-scalable=(?:no|0)/.test(content) || (maximum !== undefined && Number(maximum) < 2);
  return blocksZoom
    ? [
        "The viewport tag in frontend/index.html blocks zoom. Remove `user-scalable` and `maximum-scale` so people can pinch to zoom.",
      ]
    : [];
};

const withoutComments = (css: string): string => css.replace(/\/\*[^]*?\*\//g, "");

const inlineStyles = (html: string): readonly string[] =>
  Array.from(html.matchAll(/<style\b[^>]*>([^]*?)<\/style>/gi), (match) => match[1]);

type Declaration = { readonly property: string; readonly value: string };
type Block = { readonly prelude: string; readonly declarations: Declaration[] };

const isAtRule = (prelude: string) => prelude.startsWith("@");
// A media or container query that only applies from some width up.
const isWiderScreen = (prelude: string) =>
  /^@(?:media|container)\b/i.test(prelude) && /min-width|width\s*>/i.test(prelude);

const fixedWidthPx = (value: string): number | undefined => {
  const match = /^(\d*\.?\d+)(px|rem|em)(?:\s*!important)?$/i.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * (match[2].toLowerCase() === "px" ? 1 : ROOT_FONT_PX);
};

// Rules that force an element wider than the narrowest phone: a fixed `min-width`, or a fixed
// `width` with no `max-width` beside it, outside a query for wider screens.
const fixedWidths = (css: string): readonly string[] => {
  const found: string[] = [];
  const stack: Block[] = [];
  let buffer = "";
  let quote: string | undefined;

  const declare = () => {
    const text = buffer.trim();
    buffer = "";
    const colon = text.indexOf(":");
    const block = stack.at(-1);
    if (!block || colon < 1) return;
    block.declarations.push({
      property: text.slice(0, colon).trim().toLowerCase(),
      value: text.slice(colon + 1).trim(),
    });
  };

  const close = () => {
    declare();
    const block = stack.pop();
    if (!block || isAtRule(block.prelude) || stack.some((outer) => isWiderScreen(outer.prelude))) {
      return;
    }
    const capped = block.declarations.some(({ property }) => property === "max-width");
    for (const { property, value } of block.declarations) {
      if (property !== "min-width" && !(property === "width" && !capped)) continue;
      if ((fixedWidthPx(value) ?? 0) > NARROWEST_PHONE_PX) {
        found.push(`\`${block.prelude}\` sets \`${property}: ${value}\``);
      }
    }
  };

  for (const char of withoutComments(css)) {
    if (quote) {
      buffer += char;
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
    } else if (char === "{") {
      stack.push({ prelude: buffer.trim().replace(/\s+/g, " "), declarations: [] });
      buffer = "";
    } else if (char === "}") {
      close();
    } else if (char === ";") {
      declare();
    } else {
      buffer += char;
    }
  }
  return found;
};

const fixedWidthProblems = (sheets: readonly string[]): readonly string[] => {
  const found = sheets.flatMap(fixedWidths);
  const shown = found
    .slice(0, MAX_FIXED_WIDTHS)
    .map(
      (rule) =>
        `${rule}, which is wider than a ${NARROWEST_PHONE_PX}px phone and makes the page scroll sideways. Use \`max-width\`, \`min(<width>, 100%)\`, or move it into a \`min-width\` media query.`
    );
  return found.length > MAX_FIXED_WIDTHS
    ? [...shown, `And ${found.length - MAX_FIXED_WIDTHS} more fixed widths like these.`]
    : shown;
};

export const mobileProblems = ({ html, css }: BuiltApp): readonly string[] => {
  const sheets = [...css, ...inlineStyles(html)].filter((sheet) => withoutComments(sheet).trim());
  return [
    ...viewportProblems(html),
    ...(sheets.length === 0
      ? [
          "The build has no stylesheet, so every screen shows in the browser's default look. Add one shared stylesheet, import it in frontend/src/main.tsx, and style every screen for a phone first.",
        ]
      : fixedWidthProblems(sheets)),
  ];
};
