import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../../..");
const server = join(repo, "server");

// Every file outside server/ that shipped server code imports by relative path. Tests are left out:
// .dockerignore drops __tests__, so their imports never reach the image.
const importsOutsideServer = (): readonly string[] => {
  const found = new Set<string>();
  const sources = readdirSync(server, { recursive: true, encoding: "utf8" }).filter(
    (path) => /\.[cm]?[jt]sx?$/.test(path) && !/(^|\/)(node_modules|__tests__)\//.test(path)
  );
  const queue = sources.map((path) => join(server, path));
  for (const file of queue) {
    const specifiers = readFileSync(file, "utf8").matchAll(
      /(?:from|import\(?)\s*["'](\.{1,2}\/[^"']+)["']/g
    );
    for (const [, specifier] of specifiers) {
      const target = resolve(dirname(file), specifier);
      if (!target.startsWith(server + "/") && !found.has(target)) {
        found.add(target);
        queue.push(target);
      }
    }
  }
  return [...found].map((path) => relative(repo, path)).sort();
};

describe("the server image", () => {
  it("copies in every directory outside server/ that the server imports from", () => {
    const dockerfile = readFileSync(join(repo, "Dockerfile"), "utf8");
    const dockerignore = readFileSync(join(repo, ".dockerignore"), "utf8").split("\n");
    const imported = importsOutsideServer();
    expect(imported).not.toHaveLength(0);
    for (const directory of new Set(imported.map((path) => path.split("/")[0]))) {
      expect(dockerignore, `.dockerignore must allow ${directory}`).toContain(`!${directory}`);
      expect(dockerfile, `Dockerfile must COPY ${directory}`).toContain(
        `COPY ${directory} ${directory}\n`
      );
    }
  });
});
