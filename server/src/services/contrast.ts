// WCAG 2.2 contrast between two colors. Pure: the design styles' tests and the brand-color check
// both use it. https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio

// Body text (1.4.3) and the parts of a control a person needs to see it by (1.4.11).
export const AA_TEXT = 4.5;
export const AA_UI = 3;

// Only #rrggbb: it is all the style tokens use, and nothing else can reach a stylesheet or prompt
// through it (no `;`, `}` or words).
export const isHexColor = (value: string): boolean => /^#[0-9a-f]{6}$/i.test(value);

const channel = (hex: string, at: number): number => {
  const value = parseInt(hex.slice(at, at + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string): number => {
  if (!isHexColor(hex)) throw new Error(`${JSON.stringify(hex)} is not a color`);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
};

export const contrastRatio = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};
