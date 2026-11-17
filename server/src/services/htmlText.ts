export type Brand = {
  readonly siteName: string;
  readonly colors: readonly string[];
  readonly logos: readonly string[];
};

export type PageDigest = {
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly headings: readonly string[];
  readonly linkTexts: readonly string[];
  readonly text: string;
  readonly brand?: Brand;
};

export type PageLink = { readonly href: string; readonly text: string };

export type ReducedPage = {
  readonly digest: PageDigest;
  readonly links: readonly PageLink[];
  readonly asksForPassword: boolean;
};

type Attributes = Readonly<Record<string, string>>;

type Token =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "open"; readonly name: string; readonly attributes: Attributes }
  | { readonly type: "close"; readonly name: string };

const MAX_TAG = 4096;
const MAX_TEXT = 6000;
const MAX_LINE = 200;
const MAX_HEADINGS = 40;
const MAX_LINKS = 80;
const MAX_COLORS = 8;
const MAX_LOGOS = 5;

const RAW_TEXT = new Set(["script", "style", "textarea", "title", "noscript", "template", "svg"]);
const HEADINGS = new Set(["h1", "h2", "h3"]);
const BREAKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dt",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "p",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
  "ol",
]);

const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  copy: "(c)",
};

const codePoint = (code: number): string =>
  code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    ? String.fromCodePoint(code)
    : " ";

export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] !== "#") return NAMED[body.toLowerCase()] ?? whole;
    return codePoint(
      body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1))
    );
  });

const squash = (text: string): string =>
  text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const clean = (text: string, max = MAX_LINE): string => squash(decodeEntities(text)).slice(0, max);

const parseAttributes = (source: string): Attributes =>
  Object.fromEntries(
    [
      ...source
        .slice(0, MAX_TAG)
        .matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g),
    ]
      .reverse()
      .map((match) => [
        match[1].toLowerCase(),
        decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""),
      ])
  );

const tagEnd = (html: string, from: number): number => {
  let quote = "";
  for (let at = from; at < html.length; at += 1) {
    const char = html[at];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return at;
  }
  return -1;
};

export function* tokens(html: string): Generator<Token> {
  const lower = html.toLowerCase();
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open < 0) {
      yield { type: "text", text: html.slice(at) };
      return;
    }
    if (open > at) yield { type: "text", text: html.slice(at, open) };
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    const named = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(open, open + 64));
    if (!named) {
      const skip = /^<[!?]/.test(html.slice(open, open + 2));
      const end = skip ? html.indexOf(">", open) : -1;
      if (!skip) yield { type: "text", text: "<" };
      at = skip ? (end < 0 ? html.length : end + 1) : open + 1;
      continue;
    }
    const end = tagEnd(html, open + named[0].length);
    if (end < 0) return;
    const name = named[2].toLowerCase();
    at = end + 1;
    if (named[1]) {
      yield { type: "close", name };
      continue;
    }
    yield {
      type: "open",
      name,
      attributes: parseAttributes(html.slice(open + named[0].length, end)),
    };
    if (!RAW_TEXT.has(name)) continue;
    if (html[end - 1] === "/") {
      yield { type: "close", name };
      continue;
    }
    const close = lower.indexOf(`</${name}`, at);
    const stop = close < 0 ? html.length : close;
    yield { type: "text", text: html.slice(at, stop) };
    at = stop;
  }
}

const HEX = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi;

export const hexColor = (value: string): string | null => {
  const hex = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(value.trim())?.[1].toLowerCase();
  if (!hex) return null;
  return `#${hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex}`;
};

const absolute = (href: string, base: string): string | null => {
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

const unique = <Item>(items: readonly Item[]): readonly Item[] => [...new Set(items)];

const byCount = (items: readonly string[]): readonly string[] => {
  const counts = items.reduce(
    (map, item) => map.set(item, (map.get(item) ?? 0) + 1),
    new Map<string, number>()
  );
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([item]) => item);
};

const DULL = new Set(["#ffffff", "#000000"]);

export const reducePage = (html: string, url: string, withBrand: boolean): ReducedPage => {
  const headings: string[] = [];
  const links: PageLink[] = [];
  const text: string[] = [];
  const metaColors: string[] = [];
  const styleColors: string[] = [];
  const logos: string[] = [];
  const meta = new Map<string, string>();
  let title = "";
  let asksForPassword = false;
  let base = url;
  let raw = "";
  let heading: string[] | null = null;
  let link: { href: string; parts: string[] } | null = null;

  for (const token of tokens(html)) {
    if (token.type === "text") {
      if (raw === "title") title ||= clean(token.text);
      else if (raw === "style") styleColors.push(...(token.text.match(HEX) ?? []));
      else if (!raw) {
        text.push(token.text);
        heading?.push(token.text);
        link?.parts.push(token.text);
      }
      continue;
    }
    const { name } = token;
    if (token.type === "close") {
      if (raw === name) raw = "";
      if (HEADINGS.has(name) && heading) {
        headings.push(clean(heading.join(" ")));
        heading = null;
      }
      if (name === "a" && link) {
        links.push({ href: link.href, text: clean(link.parts.join(" ")) });
        link = null;
      }
      if (BREAKS.has(name)) text.push("\n");
      continue;
    }
    const { attributes } = token;
    if (RAW_TEXT.has(name)) raw = name;
    if (BREAKS.has(name)) text.push("\n");
    if (attributes.style) styleColors.push(...(attributes.style.match(HEX) ?? []));
    if (name === "base" && attributes.href) base = absolute(attributes.href, url) ?? base;
    if (name === "meta") {
      const key = (attributes.name ?? attributes.property ?? "").toLowerCase();
      if (key && attributes.content && !meta.has(key)) meta.set(key, attributes.content);
      if (key === "theme-color" || key === "msapplication-tilecolor")
        metaColors.push(attributes.content ?? "");
    }
    if (name === "link" && /\b(apple-touch-icon|icon)\b/i.test(attributes.rel ?? ""))
      logos.push(attributes.href ?? "");
    if (name === "img") {
      const hint = `${attributes.class ?? ""} ${attributes.id ?? ""} ${attributes.alt ?? ""} ${attributes.src ?? ""}`;
      if (/logo|brand/i.test(hint)) logos.unshift(attributes.src ?? "");
      if (attributes.alt) text.push(` ${attributes.alt} `);
    }
    if (name === "input" && (attributes.type ?? "").toLowerCase() === "password")
      asksForPassword = true;
    if (HEADINGS.has(name)) heading = [];
    if (name === "a" && attributes.href) link = { href: attributes.href, parts: [] };
  }

  const resolved = links.flatMap(({ href, text: label }) => {
    const target = absolute(href, base);
    return target && label ? [{ href: target, text: label }] : [];
  });
  const image = meta.get("og:image");
  const brand: Brand = {
    siteName: clean(meta.get("og:site_name") ?? meta.get("application-name") ?? ""),
    colors: unique(
      [...metaColors, ...byCount(styleColors.map((color) => hexColor(color) ?? ""))]
        .map((color) => hexColor(color))
        .filter((color): color is string => color !== null && !DULL.has(color))
    ).slice(0, MAX_COLORS),
    logos: unique(
      [...logos, ...(image ? [image] : [])]
        .map((href) => (href ? absolute(href, base) : null))
        .filter((href): href is string => href !== null && href.length <= 500)
    ).slice(0, MAX_LOGOS),
  };

  return {
    digest: {
      url,
      title: title || clean(meta.get("og:title") ?? ""),
      description: clean(meta.get("description") ?? meta.get("og:description") ?? "", 500),
      headings: unique(headings.filter(Boolean)).slice(0, MAX_HEADINGS),
      linkTexts: unique(resolved.map((item) => item.text)).slice(0, MAX_LINKS),
      text: decodeEntities(text.join(""))
        .split("\n")
        .map(squash)
        .filter(Boolean)
        .join("\n")
        .slice(0, MAX_TEXT),
      ...(withBrand ? { brand } : {}),
    },
    links: resolved,
    asksForPassword,
  };
};
