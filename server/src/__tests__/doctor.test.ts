import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const doctor = new URL("../../scripts/doctor.sh", import.meta.url).pathname;

// Stand-ins for the tools doctor.sh asks, first on PATH: a machine with a deployed app whose
// project is gone, a foreign container on an app port, and Vite already on :5173.
const STUBS: Readonly<Record<string, string>> = {
  docker: `case "$*" in
  info) exit 0 ;;
  "compose ps"*) ;;
  "ps --format"*) echo "other-web-1 0.0.0.0:8101->80/tcp" ; echo "schmeide-kept-web-1 0.0.0.0:8100->80/tcp" ;;
  "ps -a"*) printf 'schmeide-gone\\nschmeide-kept\\nschmeideapp\\n' ;;
  "volume ls"*) echo schmeide-gone ;;
esac`,
  lsof: `case "$*" in *:5173*) printf 'COMMAND PID\\nvite 123\\n' ;; *) exit 1 ;; esac`,
  claude: `[ "$1" = --version ] && echo "2.0.0 (Claude Code)" || echo OK`,
  gmake: `echo "GNU Make 4.4.1"`,
  git: `[ "$1" = --version ] && echo "git version 2.50.0"; exit 0`,
};

describe("make doctor", () => {
  it("names leftover app resources, busy app ports, and busy server ports with a fix", () => {
    const root = mkdtempSync(join(tmpdir(), "schmeide-doctor-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    mkdirSync(join(root, "data", "projects", "kept"), { recursive: true });

    const result = spawnSync("bash", [doctor], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        SCHMEIDE_DATA_DIR: join(root, "data"),
        SCHMEIDE_CLAUDE_BIN: join(bin, "claude"),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "FAIL  containers or volumes left over from a deleted project: schmeide-gone\n" +
        "        fix: docker compose -p schmeide-gone down --volumes --remove-orphans"
    );
    expect(result.stdout).toContain("ok    app kept has containers or volumes");
    expect(result.stdout).toContain(
      "app ports in use by something else: 8101 by container other-web-1"
    );
    expect(result.stdout).toContain("FAIL  port 5173 is in use by vite (pid 123)");
    expect(result.stdout).toContain("ok    port 3100 is free");
  });
});
