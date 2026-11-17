import { describe, expect, it } from "vitest";
import { DamagedFileError } from "../errors.ts";
import { declaredType, sniffType } from "../fileTypes.ts";
import {
  CELL_MAX,
  MAX_COLUMNS,
  SAMPLE_ROWS,
  csvTable,
  decodeXml,
  parseCsv,
  xlsxTable,
} from "../spreadsheet.ts";
import { readZipEntry, zipEntries } from "../zip.ts";
import { JPEG, PDF, PNG, WEBP, xlsxOf, zipOf } from "./fileFixtures.ts";

const csv = (text: string) => Buffer.from(text, "utf8");

describe("parseCsv", () => {
  it("reads quoted cells, doubled quotes, and line breaks inside a cell", () => {
    expect(parseCsv('Name,Note\r\n"Example, Ada","said ""hi""\nthen left"\r\n', 10)).toEqual([
      ["Name", "Note"],
      ["Example, Ada", 'said "hi"\nthen left'],
    ]);
  });

  it("works out the separator from the first line: comma, semicolon, or tab", () => {
    expect(parseCsv("Name;Amount owed\nAda;1,50\n", 10)).toEqual([
      ["Name", "Amount owed"],
      ["Ada", "1,50"],
    ]);
    expect(parseCsv("Name\tCity\nAda\tBerlin", 10)).toEqual([
      ["Name", "City"],
      ["Ada", "Berlin"],
    ]);
  });

  it("stops after the rows it was asked for", () => {
    expect(parseCsv("a,b\n1,2\n3,4\n5,6\n", 2)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("csvTable", () => {
  it("takes the first row as the column names and the next few as samples", () => {
    const rows = Array.from({ length: 9 }, (_, index) => `Client ${index},${index * 10}`);

    const table = csvTable(csv(`\uFEFFClient name, Amount owed ,\n\n${rows.join("\n")}\n`));

    expect(table.columns).toEqual(["Client name", "Amount owed"]);
    expect(table.sampleRows).toHaveLength(SAMPLE_ROWS);
    expect(table.sampleRows[0]).toEqual(["Client 0", "0"]);
    expect(table.sheet).toBeNull();
  });

  it("reads a file saved by a spreadsheet program in the Western European encoding", () => {
    const table = csvTable(
      Buffer.from("Stra\xdfe;Gr\xf6\xdfe\nHauptstra\xdfe;gro\xdf\n", "latin1")
    );

    expect(table.columns).toEqual(["Straße", "Größe"]);
    expect(table.sampleRows).toEqual([["Hauptstraße", "groß"]]);
  });

  it("skips unnamed and repeated columns, and keeps long files and long cells in bounds", () => {
    const names = Array.from({ length: MAX_COLUMNS + 10 }, (_, index) => `Column ${index}`);
    const wide = csvTable(csv(`${names.join(",")}\n${"x".repeat(CELL_MAX + 50)}\n`));
    expect(wide.columns).toHaveLength(MAX_COLUMNS);
    expect(wide.sampleRows[0][0]).toHaveLength(CELL_MAX);

    const table = csvTable(csv("Name,,Name,City\nAda,skipped,again,Berlin\n"));
    expect(table.columns).toEqual(["Name", "City"]);
    expect(table.sampleRows).toEqual([["Ada", "Berlin"]]);
  });

  it("finds no columns in a file with nothing in it", () => {
    expect(csvTable(csv("\n\n , \n")).columns).toEqual([]);
  });
});

describe("xlsxTable", () => {
  it("reads the first sheet's column names and sample rows, text and numbers alike", async () => {
    const table = await xlsxTable(
      xlsxOf([
        ["Client name", "Amount owed", "", "R&D <notes>"],
        ["Ada Example", 120.5, "", "ok"],
        ["Bob Example", 80, "", ""],
      ])
    );

    expect(table).toEqual({
      sheet: "Clients",
      columns: ["Client name", "Amount owed", "R&D <notes>"],
      sampleRows: [
        ["Ada Example", "120.5", "ok"],
        ["Bob Example", "80", ""],
      ],
    });
  });

  it("returns only a few sample rows from a long sheet", async () => {
    const rows = Array.from({ length: 500 }, (_, index) => [`Client ${index}`, index]);

    const table = await xlsxTable(xlsxOf([["Client name", "Visits"], ...rows]));

    expect(table.sampleRows).toHaveLength(SAMPLE_ROWS);
    expect(table.sampleRows[4]).toEqual(["Client 4", "4"]);
  });

  it("reads text written inside the cell, and cells that give no position", async () => {
    const sheet =
      '<worksheet><sheetData><row><c t="inlineStr"><is><r><t>Client </t></r><r><t>name</t></r></is></c><c t="str"><v>Total</v></c><c t="b"><v>1</v></c></row></sheetData></worksheet>';
    const bytes = zipOf([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      {
        name: "xl/workbook.xml",
        data: Buffer.from('<workbook><sheets><sheet name="A"/></sheets></workbook>'),
      },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet) },
    ]);

    expect((await xlsxTable(bytes)).columns).toEqual(["Client name", "Total", "Yes"]);
  });

  it("says the file is damaged when the sheet is missing or the zip is broken", async () => {
    const noSheet = zipOf([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
    ]);
    await expect(xlsxTable(noSheet)).rejects.toBeInstanceOf(DamagedFileError);

    const whole = xlsxOf([["Client name", "Amount owed"]]);
    await expect(xlsxTable(whole.subarray(0, whole.length - 30))).rejects.toBeInstanceOf(
      DamagedFileError
    );
  });
});

describe("zip", () => {
  it("lists the parts and reads stored and deflated ones", async () => {
    const bytes = zipOf([
      { name: "a.txt", data: Buffer.from("stored text"), stored: true },
      { name: "dir/b.txt", data: Buffer.from("deflated text ".repeat(50)) },
    ]);

    const entries = zipEntries(bytes);

    expect(entries.map(({ name }) => name)).toEqual(["a.txt", "dir/b.txt"]);
    expect((await readZipEntry(bytes, entries[0], 100)).toString()).toBe("stored text");
    expect((await readZipEntry(bytes, entries[1], 10_000)).toString()).toBe(
      "deflated text ".repeat(50)
    );
  });

  it("stops unpacking at the limit, so a small file cannot unpack into a huge one", async () => {
    const bytes = zipOf([{ name: "bomb.xml", data: Buffer.alloc(20 * 1024 * 1024, "a") }]);
    expect(bytes.length).toBeLessThan(100 * 1024);

    const prefix = await readZipEntry(bytes, zipEntries(bytes)[0], 1000);

    expect(prefix).toHaveLength(1000);
  });

  it("refuses a file that is not a whole zip", () => {
    expect(() => zipEntries(Buffer.from("PK\x03\x04 not really"))).toThrow(DamagedFileError);
    expect(() => zipEntries(Buffer.alloc(100))).toThrow(DamagedFileError);
  });
});

describe("decodeXml", () => {
  it("turns escapes back into characters and leaves unknown ones alone", () => {
    expect(decodeXml("R&amp;D &lt;b&gt; &#233; &#x20AC; &quot;x&quot; &nbsp;")).toBe(
      'R&D <b> é € "x" &nbsp;'
    );
  });
});

describe("sniffType", () => {
  it("names a file by what it holds", () => {
    expect(sniffType(PNG)).toBe("png");
    expect(sniffType(JPEG)).toBe("jpeg");
    expect(sniffType(WEBP)).toBe("webp");
    expect(sniffType(PDF)).toBe("pdf");
    expect(sniffType(xlsxOf([["Client name", "Amount owed"]]))).toBe("xlsx");
    expect(sniffType(csv("Client name,Amount owed\nAda,10\n"))).toBe("csv");
    expect(sniffType(csv("Client name;Amount owed\n"))).toBe("csv");
  });

  it.each([
    ["a phone's HEIC picture", Buffer.from("\0\0\0\x18ftypheic\0\0\0\0mif1heic", "latin1")],
    ["a GIF", Buffer.from("GIF89a\x01\0\x01\0", "latin1")],
    ["an SVG", csv('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1, 2)</script></svg>')],
    ["a web page", csv("<!doctype html>\n<p>one, two, three</p>")],
    ["a zip that is not a spreadsheet", zipOf([{ name: "notes.txt", data: Buffer.from("hi") }])],
    [
      "a Word document",
      zipOf([
        { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
        { name: "word/document.xml", data: Buffer.from("<w/>") },
      ]),
    ],
    ["an old Excel file", Buffer.from("\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1\0\0\0\0", "latin1")],
    ["a program", Buffer.from("\x7fELF\x02\x01\x01\0\0\0\0\0", "latin1")],
    ["one line of plain words", csv("hello there")],
    ["nothing", Buffer.alloc(0)],
  ])("does not accept %s", (_, bytes) => {
    expect(sniffType(bytes)).toBeUndefined();
  });
});

describe("declaredType", () => {
  it("reads the type a browser sends, and treats a vague one as undeclared", () => {
    expect(declaredType("image/png")).toBe("png");
    expect(declaredType("IMAGE/JPEG; charset=binary")).toBe("jpeg");
    expect(declaredType("text/csv;charset=utf-8")).toBe("csv");
    expect(declaredType("application/octet-stream")).toBe("any");
    expect(declaredType("application/vnd.ms-excel")).toBe("any");
  });

  it.each([undefined, "", "image/heic", "text/plain", "multipart/form-data", "image/svg+xml"])(
    "does not know %s",
    (type) => {
      expect(declaredType(type)).toBeUndefined();
    }
  );
});
