import { z } from "zod";

// The page title and icon a project's app is deployed with. Written into the app by the server on
// every deploy, so no agent tokens are spent and a later agent change cannot drop them.

export const TITLE_MAX = 100;
export const ICON_MAX_BYTES = 256 * 1024;
// Fixed name in the app's frontend/public; the extension follows the content.
export const ICON_FILE = "site-icon";
const ICON_MIME = { png: "image/png", ico: "image/x-icon" } as const;
export type IconType = keyof typeof ICON_MIME;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00]);

// By content, never by the claimed type or file name. SVG (scriptable) is not accepted.
export const iconType = (bytes: Buffer): IconType | undefined =>
  bytes.subarray(0, PNG.length).equals(PNG)
    ? "png"
    : bytes.length > ICO.length && bytes.subarray(0, ICO.length).equals(ICO)
      ? "ico"
      : undefined;

const ICON_REJECTED = `The icon must be a PNG or ICO file of at most ${ICON_MAX_BYTES / 1024} KB`;

export const siteSchema = z.object({
  id: z.number().int().positive(),
  // Empty means the project name.
  title: z.string().trim().max(TITLE_MAX),
  // Base64 file content; null removes the icon, undefined keeps it.
  icon: z
    .base64()
    .max(Math.ceil(ICON_MAX_BYTES / 3) * 4, ICON_REJECTED)
    .refine((data) => {
      const bytes = Buffer.from(data, "base64");
      return bytes.length <= ICON_MAX_BYTES && iconType(bytes) !== undefined;
    }, ICON_REJECTED)
    .nullable()
    .optional(),
});

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char
  );

const ANY_ICON_LINK = /[ \t]*<link\b[^>]*\brel=["']?(?:shortcut )?icon\b[^>]*>[ \t]*\n?/gi;
const OUR_ICON_LINK = new RegExp(`[ \\t]*<link\\b[^>]*/${ICON_FILE}\\.[^>]*>[ \\t]*\\n?`, "gi");

// Sets <title> and the icon link in an index.html. With an icon, it replaces any other icon link;
// without one, it removes only the link it added before, so the app is back to its own default.
export const withSite = (html: string, title: string, icon: IconType | undefined): string => {
  const titleTag = `<title>${escapeHtml(title)}</title>`;
  const titled = /<title\b[^>]*>[\s\S]*?<\/title>/i.test(html)
    ? html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, () => titleTag)
    : html.replace(/<\/head>/i, () => `  ${titleTag}\n  </head>`);
  const unlinked = titled.replace(icon ? ANY_ICON_LINK : OUR_ICON_LINK, "");
  if (!icon) return unlinked;
  const link = `<link rel="icon" type="${ICON_MIME[icon]}" href="/${ICON_FILE}.${icon}" />`;
  return unlinked.replace(/<\/head>/i, () => `  ${link}\n  </head>`);
};
