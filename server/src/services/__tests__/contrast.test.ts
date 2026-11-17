import { describe, expect, it } from "vitest";
import { AA_TEXT, AA_UI, contrastRatio, isHexColor } from "../contrast.ts";

describe("contrastRatio", () => {
  it("gives the WCAG ratio of two colors, whichever order they come in", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#1c1c1a", "#1c1c1a")).toBe(1);
  });

  it("puts the grays either side of the AA line where WCAG does", () => {
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(AA_TEXT);
    expect(contrastRatio("#949494", "#ffffff")).toBeGreaterThanOrEqual(AA_UI);
    expect(contrastRatio("#959595", "#ffffff")).toBeLessThan(AA_UI);
  });

  it("reads upper-case hex the same as lower-case", () => {
    expect(contrastRatio("#1F5FD1", "#FFFFFF")).toBe(contrastRatio("#1f5fd1", "#ffffff"));
  });

  it("refuses anything that is not a six-digit hex color", () => {
    expect(() => contrastRatio("red", "#ffffff")).toThrow("not a color");
  });
});

describe("isHexColor", () => {
  it.each(["#000000", "#1f5fd1", "#ABCDEF"])("accepts %s", (value) => {
    expect(isHexColor(value)).toBe(true);
  });

  it.each(["#fff", "1f5fd1", "#1f5fd1;", "#1f5fd1 }", "rgb(0,0,0)", "#gggggg", ""])(
    "refuses %s",
    (value) => {
      expect(isHexColor(value)).toBe(false);
    }
  );
});
