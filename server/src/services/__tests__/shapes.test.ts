import { describe, expect, it } from "vitest";
import { FALLBACK_SHAPE, chooseShapes, parseShapeList, shapesPrompt } from "../shapes.ts";

const ALL = [
  "assets",
  "bookings",
  "customers",
  "dashboard",
  "deals",
  "handbook",
  "invoices",
  "notes",
  "orders",
  "requests",
  "stock",
] as const;

describe("chooseShapes", () => {
  it("picks the shapes the spec describes, in the order it first names them", () => {
    const spec = `## Features
- Clients book appointments online
- Send an invoice after each visit
- A sales pipeline for new leads`;
    expect(chooseShapes(spec, ALL)).toEqual(["bookings", "invoices", "deals"]);
  });

  it("matches a shape by its own name, singular or plural, whole words only", () => {
    expect(chooseShapes("Track stock levels and each asset", ALL)).toEqual(["stock", "assets"]);
    expect(chooseShapes("A stockroom for the dashboarding team", ALL)).toEqual(["notes"]);
  });

  it("matches a shape the table does not know by its name", () => {
    expect(chooseShapes("Keep a recipe book", ["notes", "recipes"])).toEqual(["recipes"]);
  });

  it("ignores shapes the template does not have", () => {
    expect(chooseShapes("Send invoices", ["notes"])).toEqual(["notes"]);
  });

  it("falls back to notes when no shape fits", () => {
    expect(chooseShapes("## Features\n- Write down ideas", ALL)).toEqual([FALLBACK_SHAPE]);
    expect(chooseShapes("", [])).toEqual(["notes"]);
  });
});

describe("parseShapeList", () => {
  it("keeps the shape names and drops what npm printed around them", () => {
    expect(parseShapeList("\nadded 412 packages in 3s\nassets\nfield-service\nnotes\n")).toEqual([
      "assets",
      "field-service",
      "notes",
    ]);
  });
});

describe("shapesPrompt", () => {
  it("says nothing new for notes alone, which the build replaces", () => {
    expect(shapesPrompt(["notes"])).toBe("");
    expect(shapesPrompt([])).toBe("");
  });

  it("names the kept shapes and points at their docs", () => {
    const prompt = shapesPrompt(["invoices", "customers"]);
    expect(prompt).toContain("invoices (docs/shapes/invoices.md)");
    expect(prompt).toContain("customers (docs/shapes/customers.md)");
    expect(prompt).toMatch(/adapt/i);
  });
});
