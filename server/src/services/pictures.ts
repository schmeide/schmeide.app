// A picture of each version's home page (#229), taken at the end of deploy once staging answers,
// so the version list can show what each version looked like. Apps behind platform sign-in (#84)
// show their sign-in page; that is accepted for now.
import { and, eq } from "drizzle-orm";
import { chromium } from "playwright";
import type { z } from "zod";
import type { Db } from "../db/client.ts";
import { versionPictures, type PictureWidth, type pictureSchema } from "../db/schema.ts";

export type Picture = { readonly width: PictureWidth; readonly data: Buffer };
export type Photograph = (url: string) => Promise<readonly Picture[]>;

export const PICTURE_TIMEOUT_MS = 20_000;
const MAX_WIDTH = 640;
const VIEWPORTS: Readonly<Record<PictureWidth, { width: number; height: number }>> = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
};

// Scales a PNG data URL to at most `max` px wide and answers it as a WebP data URL. Runs in the
// browser, so it is a string: the server is typechecked without the DOM.
const TO_WEBP = `async ({ src, max }) => {
  const image = new Image();
  image.src = src;
  await image.decode();
  const scale = Math.min(1, max / image.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.8);
}`;

// `url`'s home page in headless Chromium, from Playwright, at each width. Throws when the page
// does not answer 200, Chromium is missing or crashes, or a step outlasts PICTURE_TIMEOUT_MS.
export const photograph: Photograph = async (url) => {
  const browser = await chromium.launch({ timeout: PICTURE_TIMEOUT_MS });
  try {
    // A blank page of its own, so the app's Content-Security-Policy cannot refuse the data URL.
    const encoder = await browser.newPage();
    const pictures: Picture[] = [];
    for (const [width, viewport] of Object.entries(VIEWPORTS) as [
      PictureWidth,
      typeof VIEWPORTS.phone,
    ][]) {
      const page = await browser.newPage({ viewport });
      const response = await page.goto(url, { timeout: PICTURE_TIMEOUT_MS, waitUntil: "load" });
      if (!response?.ok()) throw new Error(`${url} answered ${response?.status() ?? "nothing"}`);
      const png = await page.screenshot({ timeout: PICTURE_TIMEOUT_MS });
      await page.close();
      const webp = await encoder.evaluate(
        `(${TO_WEBP})(${JSON.stringify({ src: `data:image/png;base64,${png.toString("base64")}`, max: MAX_WIDTH })})`
      );
      if (typeof webp !== "string" || !webp.startsWith("data:image/webp;base64,"))
        throw new Error("Chromium did not encode the picture as WebP");
      pictures.push({ width, data: Buffer.from(webp.slice(webp.indexOf(",") + 1), "base64") });
    }
    return pictures;
  } finally {
    await browser.close();
  }
};

// A later attempt of the same deploy replaces the build's pictures.
export const savePictures = (db: Db, buildId: number, pictures: readonly Picture[]) =>
  db.transaction(async (tx) => {
    await tx.delete(versionPictures).where(eq(versionPictures.buildId, buildId));
    if (pictures.length > 0)
      await tx
        .insert(versionPictures)
        .values(
          pictures.map(({ width, data }) => ({ buildId, width, data: data.toString("base64") }))
        );
  });

// The picture as a data URL for an <img>, or null when the version has none at that width.
export const getPicture = async (
  db: Db,
  { buildId, width }: z.infer<typeof pictureSchema>
): Promise<string | null> => {
  const [picture] = await db
    .select({ data: versionPictures.data })
    .from(versionPictures)
    .where(and(eq(versionPictures.buildId, buildId), eq(versionPictures.width, width)));
  return picture ? `data:image/webp;base64,${picture.data}` : null;
};
