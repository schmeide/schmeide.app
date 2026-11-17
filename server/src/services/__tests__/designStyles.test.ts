import { describe, expect, it } from "vitest";
import { AA_TEXT, AA_UI, contrastRatio, isHexColor } from "../contrast.ts";
import {
  COLOR_TOKENS,
  DEFAULT_STYLE,
  STYLES,
  THEMES,
  contrastPairs,
  styleById,
} from "../designStyles.ts";
import { NARROWEST_PHONE_PX } from "../mobileCheck.ts";

const ROOT_FONT_PX = 16;

describe("the style library", () => {
  it("has four to six styles with distinct ids and names, and the default is one of them", () => {
    expect(STYLES.length).toBeGreaterThanOrEqual(4);
    expect(STYLES.length).toBeLessThanOrEqual(6);
    expect(new Set(STYLES.map((style) => style.id)).size).toBe(STYLES.length);
    expect(new Set(STYLES.map((style) => style.name)).size).toBe(STYLES.length);
    expect(styleById(DEFAULT_STYLE)?.id).toBe(DEFAULT_STYLE);
    expect(styleById("nope")).toBeUndefined();
  });

  it("differs in more than color: no two styles share their radius, type and spacing", () => {
    const shapes = STYLES.map((style) =>
      JSON.stringify([style.radius, style.type.scale, style.type.body, style.space])
    );
    expect(new Set(shapes).size).toBe(STYLES.length);
  });

  describe.each(STYLES.map((style) => [style.id, style] as const))("%s", (_id, style) => {
    it.each(THEMES)("passes WCAG AA contrast for text and controls in %s", (theme) => {
      const failing = contrastPairs(style.colors[theme])
        .map((pair) => ({ ...pair, ratio: contrastRatio(pair.fg, pair.bg) }))
        .filter(({ ratio, min }) => ratio < min)
        .map(({ name, ratio, min }) => `${name} is ${ratio.toFixed(2)}, needs ${min}`);

      expect(failing).toEqual([]);
    });

    it("gives every color token a #rrggbb value in both themes", () => {
      for (const theme of THEMES) {
        expect(Object.keys(style.colors[theme]).sort()).toEqual([...COLOR_TOKENS].sort());
        expect(Object.values(style.colors[theme]).every(isHexColor)).toBe(true);
      }
    });

    it("meets the phone floor of the mobile-first skill", () => {
      // Body and form text at 16px or more, nothing under 14px.
      expect(style.type.scale.m).toBeGreaterThanOrEqual(1);
      expect(style.type.scale.s * ROOT_FONT_PX).toBeGreaterThanOrEqual(14);
      // Tap targets at least 44px, at least 8px between them.
      expect(style.space.tap).toBeGreaterThanOrEqual(44);
      expect(style.space[2]).toBeGreaterThanOrEqual(8);
      // A reading width, not a fixed one: wider than the narrowest phone, so it is a cap.
      expect(style.space.pageWidth).toBeGreaterThan(NARROWEST_PHONE_PX);
    });

    it("uses only fonts already on the device", () => {
      for (const stack of [style.type.body, style.type.headings]) {
        expect(stack).toMatch(/(?:sans-serif|serif|monospace|system-ui)$/);
        expect(stack).not.toMatch(/url\(|@import|https?:/i);
      }
    });

    it("says when to use it, when not to, and how each shared piece looks", () => {
      for (const text of [style.summary, style.useWhen, style.avoidWhen]) {
        expect(text.length).toBeGreaterThan(20);
      }
      expect(Object.keys(style.pieces).sort()).toEqual(
        ["button", "empty", "form", "frame", "menu", "table"].sort()
      );
      for (const text of Object.values(style.pieces)) expect(text.length).toBeGreaterThan(40);
    });
  });
});

describe("contrastPairs", () => {
  it("checks text at 4.5 and control edges and focus rings at 3", () => {
    const [style] = STYLES;
    const pairs = contrastPairs(style.colors.light);

    expect(pairs).toContainEqual({
      name: "text-muted on surface",
      fg: style.colors.light.textMuted,
      bg: style.colors.light.surface,
      min: AA_TEXT,
    });
    expect(pairs).toContainEqual({
      name: "accent-text on accent",
      fg: style.colors.light.accentText,
      bg: style.colors.light.accent,
      min: AA_TEXT,
    });
    expect(pairs).toContainEqual({
      name: "control-border on surface",
      fg: style.colors.light.controlBorder,
      bg: style.colors.light.surface,
      min: AA_UI,
    });
  });
});
