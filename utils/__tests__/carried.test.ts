import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CARRIED_IDEA_MS,
  clearCarried,
  IDEA_MAX,
  ideaFrom,
  readCarried,
  writeCarried,
} from "../carried";

const schema = readFileSync(resolve(__dirname, "../../server/src/db/schema.ts"), "utf8");

describe("an idea carried from schmeide.com", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");

  it("matches the server's limit on what a new app can say", () => {
    expect(schema).toContain("export const NEED_MAX = 2000");
    expect(IDEA_MAX).toBe(2000);
  });

  it("reads a trimmed idea from the fragment and drops anything else", () => {
    expect(ideaFrom("#idea=track%20ovens")).toBe("track ovens");
    expect(ideaFrom("#idea=%20%20hello%20%20")).toBe("hello");
    expect(ideaFrom(`#idea=${encodeURIComponent("<b>hi</b>")}`)).toBe("<b>hi</b>");
    expect(ideaFrom("#idea=")).toBeNull();
    expect(ideaFrom("#idea=%20%20")).toBeNull();
    expect(ideaFrom("#other=hello")).toBeNull();
    expect(ideaFrom("")).toBeNull();
    expect(ideaFrom(`#idea=${"a".repeat(IDEA_MAX)}`)).toBe("a".repeat(IDEA_MAX));
    expect(ideaFrom(`#idea=${"a".repeat(IDEA_MAX + 1)}`)).toBeNull();
    expect(ideaFrom(`#idea=${encodeURIComponent(` ${"a".repeat(IDEA_MAX)} `)}`)).toBe(
      "a".repeat(IDEA_MAX)
    );
  });

  it("keeps the idea in this tab and forgets it after an hour", () => {
    writeCarried("  track ovens  ", now);
    expect(readCarried(now)).toBe("track ovens");
    expect(readCarried(now + CARRIED_IDEA_MS - 1)).toBe("track ovens");
    expect(readCarried(now + CARRIED_IDEA_MS)).toBeNull();
    expect(readCarried(now)).toBeNull();
  });

  it("drops a stored idea that is empty, too long, or not a record", () => {
    sessionStorage.setItem("schmeide:carried-idea", JSON.stringify({ text: "  ", at: now }));
    expect(readCarried(now)).toBeNull();
    sessionStorage.setItem(
      "schmeide:carried-idea",
      JSON.stringify({ text: "a".repeat(IDEA_MAX + 1), at: now })
    );
    expect(readCarried(now)).toBeNull();
    sessionStorage.setItem("schmeide:carried-idea", "not json");
    expect(readCarried(now)).toBeNull();
    expect(sessionStorage.getItem("schmeide:carried-idea")).toBeNull();
  });

  it("does not store a blank or over-long idea", () => {
    writeCarried("   ", now);
    writeCarried("a".repeat(IDEA_MAX + 1), now);
    expect(readCarried(now)).toBeNull();
  });

  it("forgets the idea once it is cleared", () => {
    writeCarried("track ovens", now);
    clearCarried();
    expect(readCarried(now)).toBeNull();
  });

  it("does nothing when storage is blocked", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeCarried("track ovens")).not.toThrow();
    expect(readCarried()).toBeNull();
    expect(() => clearCarried()).not.toThrow();
    setItem.mockRestore();
    getItem.mockRestore();
    removeItem.mockRestore();
  });
});
