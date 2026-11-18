import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.ts";
import { UploadRefusedError } from "../errors.ts";
import type { FileStore } from "../fileStore.ts";
import {
  EICAR,
  SCANNER_UNAVAILABLE,
  UNSAFE_MESSAGE,
  acceptUpload,
  createClamdScanner,
  createFileScanner,
  listUploadRefusals,
  parseScannerAddress,
  passingScanner,
  recordUploadRefusal,
  scanStoredOnce,
  screenUpload,
  neutralizeSpreadsheet,
  type FileScanner,
  type NewUploadRefusal,
  type StoredUpload,
} from "../fileScan.ts";
import { REFUSAL_STATUS, uploadFile, type Upload } from "../files.ts";
import { parseCsv, xlsxTable } from "../spreadsheet.ts";
import { readZipEntry, zipEntries } from "../zip.ts";
import { PDF, xlsxOf, zipOf } from "./fileFixtures.ts";

const csv = (text: string): Buffer => Buffer.from(text, "utf8");
const eicarCsv = csv(`Name,Note\nAda,${EICAR}\n`);
const scriptPdf = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\nendobj\n%%EOF\n",
  "latin1"
);
const launchPdf = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Action /S /Launch /F (cmd.exe) >>\nendobj\n%%EOF\n",
  "latin1"
);
const attachedPdf = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /EmbeddedFile /Subtype /application#2Fpdf >>\nendobj\n%%EOF\n",
  "latin1"
);
const hexScriptPdf = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /S /#4A#53 /#4A#53 (app.alert(1)) >>\nendobj\n%%EOF\n",
  "latin1"
);

const compressedScriptPdf = (): Buffer => {
  const payload = Buffer.from("<< /S /JavaScript /JS (app.alert(1)) >>", "latin1");
  const compressed = deflateSync(payload);
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
      "latin1"
    ),
    compressed,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
  ]);
};

const workbook = (entries: readonly { readonly name: string; readonly data: Buffer }[]) =>
  zipOf([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
    ...entries,
  ]);

const sheetZip = (sheet: string) =>
  zipOf([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    {
      name: "xl/workbook.xml",
      data: Buffer.from('<workbook><sheets><sheet name="Data"/></sheets></workbook>'),
    },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet) },
  ]);

const uploadOf = (bytes: Buffer, purpose: Upload["purpose"] = "reference"): Upload => ({
  tenantId: 4,
  projectId: 9,
  uploadedBy: "person-1",
  name: "prices.csv",
  owner: "mine",
  purpose,
  declared: "any",
  bytes,
});

const storedFile = (
  patch: Partial<StoredUpload> & Pick<StoredUpload, "id" | "type">
): StoredUpload => ({
  tenantId: 4,
  projectId: 9,
  uploadedBy: "person-1",
  originalName: "file",
  owner: "mine",
  purpose: "reference",
  ...patch,
});

const servers: Server[] = [];
const sockets: Socket[] = [];

const listen = async (server: Server): Promise<number> => {
  servers.push(server);
  server.on("connection", (socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

// Reads one clamd INSTREAM body: command, length-prefixed chunks, then a zero length.
const instreamBody = (socket: Socket): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let stage: "command" | "chunk" = "command";
    let remaining = 0;
    const body: Buffer[] = [];
    const take = (count: number): Buffer | undefined => {
      if (buffer.length < count) return undefined;
      const out = Buffer.from(buffer.subarray(0, count));
      buffer = buffer.subarray(count);
      return out;
    };
    const onData = (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        if (stage === "command") {
          const end = buffer.indexOf(0);
          if (end < 0) return;
          const command = buffer.subarray(0, end).toString("latin1");
          buffer = buffer.subarray(end + 1);
          if (!command.includes("INSTREAM")) {
            reject(new Error(command));
            return;
          }
          stage = "chunk";
          continue;
        }
        if (remaining === 0) {
          const header = take(4);
          if (!header) return;
          remaining = header.readUInt32BE(0);
          if (remaining === 0) {
            resolve(Buffer.concat(body));
            return;
          }
          continue;
        }
        const part = take(remaining);
        if (!part) return;
        body.push(part);
        remaining = 0;
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });

const eicarServer = async (): Promise<number> => {
  const server = createServer((socket) => {
    void instreamBody(socket)
      .then((body) => {
        const found = body.includes(EICAR);
        socket.end(found ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
      })
      .catch(() => socket.destroy());
  });
  return listen(server);
};

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

const refused = async (run: () => Promise<unknown>): Promise<UploadRefusedError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof UploadRefusedError) return error;
    throw error;
  }
  throw new Error("expected the upload to be refused");
};

describe("screenUpload", () => {
  it("refuses the standard harmless test file and stores nothing", async () => {
    const port = await eicarServer();
    const scanner = createClamdScanner({ host: "127.0.0.1", port });
    let stored = false;
    const recorded: NewUploadRefusal[] = [];
    const error = await refused(() =>
      uploadFile(
        {
          db: {
            transaction: async () => {
              stored = true;
            },
          } as unknown as Db,
          files: {
            put: async () => {
              stored = true;
            },
          } as unknown as FileStore,
          scanner,
          recordUploadRefusal: async (refusal) => {
            recorded.push(refusal);
          },
        },
        uploadOf(eicarCsv)
      )
    );

    expect(error.code).toBe("unsafe");
    expect(error.message).toBe(UNSAFE_MESSAGE);
    expect(error.detail).toContain("FOUND");
    expect(stored).toBe(false);
    expect(recorded).toEqual([
      {
        tenantId: 4,
        projectId: 9,
        uploadedBy: "person-1",
        fileId: null,
        name: "prices.csv",
        type: "csv",
        detail: error.detail,
      },
    ]);
    expect(REFUSAL_STATUS.unsafe).toBe(422);
    expect(REFUSAL_STATUS.scan_unavailable).toBe(503);
  });

  it("refuses a PDF with a script action from the structure check alone", async () => {
    let called = false;
    const scanner: FileScanner = async () => {
      called = true;
      return { clean: true };
    };

    const error = await refused(() => screenUpload({ type: "pdf", bytes: scriptPdf, scanner }));

    expect(called).toBe(false);
    expect(error).toMatchObject({
      code: "unsafe",
      message: UNSAFE_MESSAGE,
      detail: "PDF has a JavaScript action",
    });
  });

  it("refuses a launch action, an attached file, and a script hidden in a compressed stream", async () => {
    const hidden = compressedScriptPdf();
    expect(hidden.includes("JavaScript")).toBe(false);
    const cases = [
      [launchPdf, "PDF has a launch action"],
      [attachedPdf, "PDF has an attached file"],
      [hexScriptPdf, "PDF has a JavaScript action"],
      [hidden, "PDF has a JavaScript action"],
    ] as const;
    for (const [bytes, detail] of cases) {
      const error = await refused(() =>
        screenUpload({ type: "pdf", bytes, scanner: passingScanner })
      );
      expect(error.detail).toBe(detail);
    }
  });

  it("allows a PDF that only mentions JavaScript as text", async () => {
    const prose = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n(JavaScript is a language)\n%%EOF\n",
      "latin1"
    );

    await expect(
      screenUpload({ type: "pdf", bytes: prose, scanner: passingScanner })
    ).resolves.toBeUndefined();
    await expect(
      screenUpload({ type: "pdf", bytes: PDF, scanner: passingScanner })
    ).resolves.toBeUndefined();
  });

  it("refuses the upload when the scanner times out or cannot be reached", async () => {
    const hanging = createServer((socket) => {
      socket.on("data", () => undefined);
    });
    const port = await listen(hanging);
    const closed = createServer();
    const closedPort = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    servers.pop();

    const timeout = await refused(() =>
      uploadFile(
        {
          db: { transaction: async () => undefined } as unknown as Db,
          files: { put: async () => undefined } as unknown as FileStore,
          scanner: createClamdScanner({ host: "127.0.0.1", port }, 50),
        },
        uploadOf(PDF)
      )
    );
    const down = await refused(() =>
      screenUpload({
        type: "pdf",
        bytes: PDF,
        scanner: createClamdScanner({ host: "127.0.0.1", port: closedPort }, 200),
      })
    );

    expect(timeout).toMatchObject({ code: "scan_unavailable", message: SCANNER_UNAVAILABLE });
    expect(down).toMatchObject({ code: "scan_unavailable", message: SCANNER_UNAVAILABLE });
  });

  it("refuses macro-enabled spreadsheet content", async () => {
    const files = [
      workbook([{ name: "xl/vbaProject.bin", data: Buffer.from("macro") }]),
      zipOf([
        {
          name: "[Content_Types].xml",
          data: Buffer.from(
            '<Types><Override ContentType="application/vnd.ms-office.vbaProject" PartName="/xl/vbaProject.bin"/></Types>'
          ),
        },
        { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
      ]),
      workbook([{ name: "xl/embeddings/oleObject1.bin", data: Buffer.from("ole") }]),
    ];
    for (const bytes of files) {
      const error = await refused(() =>
        screenUpload({ type: "xlsx", bytes, scanner: passingScanner })
      );
      expect(error.detail).toBe("spreadsheet has macros");
    }
  });

  it("passes every file when no scanner address is set", async () => {
    await expect(
      screenUpload({ type: "csv", bytes: eicarCsv, scanner: createFileScanner(undefined) })
    ).resolves.toBeUndefined();
    expect(() => parseScannerAddress("clamav")).toThrow(/SCHMEIDE_CLAMAV_ADDRESS/);
    expect(parseScannerAddress("clamav.clamav.svc.cluster.local:3310")).toEqual({
      host: "clamav.clamav.svc.cluster.local",
      port: 3310,
    });
  });

  it("accepts a clean file the scanner marks OK, including a null byte", async () => {
    const port = await eicarServer();
    const bytes = Buffer.from(
      "%PDF-1.4\n%\0hidden\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
      "latin1"
    );

    await expect(
      screenUpload({
        type: "pdf",
        bytes,
        scanner: createClamdScanner({ host: "127.0.0.1", port }),
      })
    ).resolves.toBeUndefined();
  });
});

describe("neutralizeSpreadsheet", () => {
  it("quotes spreadsheet cells that a spreadsheet program would run", async () => {
    const source = csv("Name,Amount\n=cmd,10\n+1,-2\n@x,ok\n");
    const safe = await neutralizeSpreadsheet("csv", source);
    const rows = parseCsv(safe.toString("utf8"), 10);

    expect(rows[1]).toEqual(["'=cmd", "10"]);
    expect(rows[2]).toEqual(["'+1", "'-2"]);
    expect(rows[3]).toEqual(["'@x", "ok"]);
    expect((await neutralizeSpreadsheet("csv", csv("Name,Amount\nAda,10\n"))).toString()).toBe(
      "Name,Amount\nAda,10\n"
    );
  });

  it("rewrites formula cells and shared strings in a workbook, and leaves numbers alone", async () => {
    const sheet = sheetZip(
      '<worksheet><sheetData><row r="1"><c r="A1"><f>SUM(A2)</f><v>1</v></c><c r="B1" t="inlineStr"><is><t>@user</t></is></c></row></sheetData></worksheet>'
    );
    const rewritten = await neutralizeSpreadsheet("xlsx", sheet);
    const sheetEntry = zipEntries(rewritten).find((entry) => entry.name.endsWith("sheet1.xml"));
    if (!sheetEntry) throw new Error("missing sheet");
    const xml = (await readZipEntry(rewritten, sheetEntry, 1_000_000)).toString("utf8");
    const table = await xlsxTable(rewritten);

    expect(xml).not.toContain("<f");
    expect(xml).toContain("'=SUM(A2)");
    expect(table.columns).toEqual(["'=SUM(A2)", "'@user"]);

    const book = xlsxOf([
      ["Name", "Amount"],
      ["=1+1", -5],
    ]);
    const safe = await neutralizeSpreadsheet("xlsx", book);
    expect((await xlsxTable(safe)).sampleRows[0]).toEqual(["'=1+1", "-5"]);
    const plain = xlsxOf([["Name"], ["Ada"]]);
    expect((await neutralizeSpreadsheet("xlsx", plain)).equals(plain)).toBe(true);
  });

  it("rewrites a spreadsheet that will be copied into the app, and leaves a reference file as sent", async () => {
    const bytes = csv("Name,Amount\n=1,2\n");

    const intoApp = await acceptUpload({
      type: "csv",
      bytes,
      owner: "mine",
      purpose: "in_app",
      scanner: passingScanner,
    });
    const reference = await acceptUpload({
      type: "csv",
      bytes,
      owner: "mine",
      purpose: "reference",
      scanner: passingScanner,
    });

    expect(intoApp.toString("utf8")).toContain("'=1");
    expect(reference.equals(bytes)).toBe(true);
  });
});

describe("review records and the one-time scan", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "schmeide-scan-"));

  it("writes a refused upload where the operator list can read it", async () => {
    const saved = await recordUploadRefusal(dataDir, {
      tenantId: 4,
      projectId: 9,
      uploadedBy: "person-1",
      fileId: null,
      name: "catalogue.pdf",
      type: "pdf",
      detail: "PDF has a JavaScript action",
    });

    const listed = await listUploadRefusals(dataDir);

    expect(listed).toEqual([saved]);
    expect(saved.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("scans files already stored once, removes one that fails, and quotes an in-app spreadsheet", async () => {
    const bad = storedFile({ id: 1, type: "pdf", originalName: "bad.pdf" });
    const intoApp = storedFile({
      id: 2,
      type: "csv",
      purpose: "in_app",
      originalName: "prices.csv",
    });
    const reference = storedFile({ id: 3, type: "csv", originalName: "notes.csv" });
    const missing = storedFile({ id: 4, type: "png", originalName: "gone.png" });
    const bodies = new Map<number, Buffer>([
      [1, scriptPdf],
      [2, csv("A,B\n=1,2\n")],
      [3, csv("A,B\n=1,2\n")],
    ]);
    const removed: number[] = [];
    const replaced: { id: number; bytes: Buffer }[] = [];
    const recorded: number[] = [];
    let loads = 0;
    const run = (stamp: string) =>
      scanStoredOnce({
        dataDir,
        stamp,
        load: async () => {
          loads += 1;
          return [bad, intoApp, reference, missing];
        },
        read: async (file) => {
          const bytes = bodies.get(file.id);
          if (!bytes) {
            const error = new Error("missing") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
          return bytes;
        },
        remove: async (file) => {
          removed.push(file.id);
        },
        replace: async (file, bytes) => {
          replaced.push({ id: file.id, bytes });
        },
        scanner: passingScanner,
        record: async (file) => {
          recorded.push(file.id);
        },
      });

    const first = await run("clamav:3310");
    expect(first).toEqual({ status: "scanned", removed: 2 });
    expect(removed).toEqual([1, 4]);
    expect(recorded).toEqual([1]);
    expect(replaced.map(({ id }) => id)).toEqual([2]);
    expect(replaced[0]?.bytes.toString("utf8")).toContain("'=1");

    const loadsAfter = loads;
    const second = await run("clamav:3310");
    expect(second).toEqual({ status: "already", removed: 0 });
    expect(loads).toBe(loadsAfter);

    const third = await run("clamav:3311");
    expect(third.status).toBe("scanned");
    expect(loads).toBe(loadsAfter + 1);
  });

  it("does not mark the scan done when the scanner is down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schmeide-scan-down-"));
    const scanner: FileScanner = async () => {
      throw new Error("down");
    };

    await expect(
      scanStoredOnce({
        dataDir: dir,
        stamp: "clamav:3310",
        load: async () => [storedFile({ id: 1, type: "pdf" })],
        read: async () => PDF,
        remove: async () => undefined,
        replace: async () => undefined,
        scanner,
        record: async () => undefined,
      })
    ).rejects.toMatchObject({ code: "scan_unavailable" });
    expect(
      await scanStoredOnce({
        dataDir: dir,
        stamp: "clamav:3310",
        load: async () => [],
        read: async () => PDF,
        remove: async () => undefined,
        replace: async () => undefined,
        scanner: passingScanner,
        record: async () => undefined,
      })
    ).toEqual({ status: "scanned", removed: 0 });
  });
});
