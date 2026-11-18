import { formatDate } from "../formatDate";

describe("formatDate", () => {
  it("writes a date with its day, month, and year, and no time", () => {
    const written = formatDate(new Date(2026, 10, 16, 15, 30));
    expect(written).toContain("16");
    expect(written).toContain("2026");
    expect(written).not.toContain("30");
  });
});
