import { readStored, writeStored } from "../stored";

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

describe("stored", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads back what was written", () => {
    writeStored("test.flag", true);
    expect(readStored("test.flag", isBoolean, false)).toBe(true);
  });

  it("falls back when nothing, something invalid, or something unparseable is stored", () => {
    expect(readStored("test.missing", isBoolean, false)).toBe(false);
    localStorage.setItem("test.flag", JSON.stringify("yes"));
    expect(readStored("test.flag", isBoolean, false)).toBe(false);
    localStorage.setItem("test.flag", "{not json");
    expect(readStored("test.flag", isBoolean, false)).toBe(false);
  });

  it("falls back, and does not throw, when the store is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeStored("test.flag", true)).not.toThrow();
    expect(readStored("test.flag", isBoolean, false)).toBe(false);
  });
});
