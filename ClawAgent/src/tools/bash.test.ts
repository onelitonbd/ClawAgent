// bash. Tested with real child processes, because the parts that matter — PATH
// resolution, the process-group kill, per-stream caps — cannot be observed
// through a mock of themselves.
//
// `sleep` and `sh -c` are available on Termux's coreutils and on CI's Linux; no
// test here depends on a shell *invoked by the tool*.

import { describe, expect, it, afterEach } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBashTool, resolveExecutable } from "./bash.ts";
import { withWorkspace, runTool, type ToolFixture } from "../../test/tool-support.ts";

let fixture: ToolFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function bash(options: { env?: NodeJS.ProcessEnv; defaultTimeoutMs?: number; maxOutputBytes?: number } = {}) {
  const fix = (fixture = withWorkspace());
  return {
    fix,
    tool: createBashTool({
      workspace: fix.workspace(),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      ...options,
    }),
  };
}

describe("bash", () => {
  it("runs a program and reports the exit code", async () => {
    const { tool } = bash();
    const out = await runTool(tool, { command: "node -e \"process.stdout.write('hi')\"" });
    expect(out).toContain("stdout:\nhi");
    expect(out).toContain("exit code 0");
  });

  it("keeps stdout and stderr apart", async () => {
    const { tool } = bash();
    const out = await runTool(tool, {
      command: 'node -e "console.log(\'to stdout\'); console.error(\'to stderr\')"',
    });
    expect(out).toContain("stdout:\nto stdout");
    expect(out).toContain("stderr:\nto stderr");
  });

  it("returns a failing command's output instead of throwing", async () => {
    // A non-zero exit is information. Throwing here would discard the stack trace
    // the model needs in order to fix the code.
    const { tool } = bash();
    const out = await runTool(tool, { command: "node -e \"console.log('diagnosis'); process.exit(3)\"" });
    expect(out).toContain("diagnosis");
    expect(out).toContain("exit code 3");
  });

  it("refuses a shell operator and says what to do instead", async () => {
    const { tool } = bash();
    await expect(runTool(tool, { command: "node -v | cat" })).rejects.toThrow(
      /unsupported shell operator "\|".*run the two commands separately/uis,
    );
  });

  it("refuses a missing command, naming the Termux package when it knows one", async () => {
    const fix = (fixture = withWorkspace());
    const tool = createBashTool({
      workspace: fix.workspace(),
      env: { PATH: fix.root, PREFIX: "/data/data/com.termux/files/usr" },
    });
    await expect(runTool(tool, { command: "rg pattern" })).rejects.toThrow(
      /command not found: rg; install it on Termux with: pkg install ripgrep/u,
    );
  });

  it("runs a program from the workspace by relative path", async () => {
    const fix = (fixture = withWorkspace());
    const script = fix.write("tools/hello.sh", "#!/bin/sh\necho from-workspace\n");
    chmodSync(script, 0o755);
    const tool = createBashTool({ workspace: fix.workspace(), env: { PATH: "" } });
    const out = await runTool(tool, { command: "./tools/hello.sh" });
    expect(out).toContain("from-workspace");
  });

  it("refuses a program path outside the workspace under strict policy", async () => {
    const fix = (fixture = withWorkspace());
    const tool = createBashTool({ workspace: fix.workspace(), env: { PATH: "" } });
    await expect(runTool(tool, { command: "/bin/echo hi" })).rejects.toThrow(/outside the workspace/u);
  });

  it("caps output per stream while reading, not after buffering it", async () => {
    const { tool } = bash({ maxOutputBytes: 64 });
    const out = await runTool(tool, {
      command: 'node -e "for (let i = 0; i < 500; i++) process.stdout.write(\'x\'.repeat(80) + String.fromCharCode(10))"',
    });
    expect(out).toContain("stdout truncated: ");
    expect(out.length).toBeLessThan(4000);
  });

  it("kills the whole process group on timeout", async () => {
    // `sh -c 'sleep 30 & ...'` style children are the reason: killing only the
    // direct child leaves grandchildren holding the phone's CPU. The spawned
    // child writes a marker, sleeps, and the tool must take both down.
    const fix = (fixture = withWorkspace());
    const marker = path.join(fix.root, "grandchild.pid");
    const script = fix.write(
      "spawn.sh",
      `#!/bin/sh\nsleep 30 & echo $! > ${marker}\nwait\n`,
    );
    chmodSync(script, 0o755);
    const tool = createBashTool({ workspace: fix.workspace(), env: { PATH: process.env.PATH ?? "" } });
    const started = Date.now();
    const out = await runTool(tool, { command: `sh ${script}`, timeoutMs: 300 });
    const elapsed = Date.now() - started;
    expect(out).toContain("killed by timeout");
    expect(elapsed).toBeLessThan(5_000);
    // Give the group a moment, then assert the grandchild is gone.
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (fixture.exists("grandchild.pid")) {
      const pid = Number.parseInt(fixture.read("grandchild.pid").trim(), 10);
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive, `grandchild ${pid} survived the group kill`).toBe(false);
    }
  });

  it("stops a process when the turn is aborted", async () => {
    const { tool } = bash();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 120);
    const out = await runTool(
      { execute: (id, params, signal) => tool.execute(id, params as never, signal) },
      { command: "node -e \"setTimeout(() => process.exit(0), 20000)\"" },
      controller.signal,
    );
    expect(out).toContain("killed by abort");
  });

  it("never waits on stdin", async () => {
    // A command that reads stdin would hang until the timeout with no prompt
    // visible on a phone, which reads as a ClawAgent bug.
    const { tool } = bash({ defaultTimeoutMs: 2_000 });
    const out = await runTool(tool, { command: "node -e \"process.stdin.on('data', () => {})\"" });
    expect(out).toContain("no output");
  });
});

describe("resolveExecutable", () => {
  it("searches PATH in order and returns the first executable", () => {
    const fix = (fixture = withWorkspace());
    const first = fix.write("binA/prog", "#!/bin/sh\n");
    fix.write("binB/prog", "#!/bin/sh\n");
    chmodSync(first, 0o755);
    chmodSync(path.join(fix.root, "binB/prog"), 0o755);
    const resolved = resolveExecutable("prog", {
      cwd: fix.root,
      env: { PATH: [path.join(fix.root, "binA"), path.join(fix.root, "binB")].join(path.delimiter) },
      workspace: fix.workspace(),
    });
    expect(resolved.ok && resolved.file).toBe(first);
  });

  it("skips a non-executable file with the same name", () => {
    const fix = (fixture = withWorkspace());
    const notExecutable = fix.write("bin/prog", "data");
    expect(
      resolveExecutable("prog", { cwd: fix.root, env: { PATH: path.join(fix.root, "bin") }, workspace: fix.workspace() })
        .ok,
    ).toBe(false);
    expect(notExecutable).toContain("bin");
  });

  it("ignores a directory that happens to match the name", () => {
    const fix = (fixture = withWorkspace());
    fix.mkdir("bin/cat");
    const resolved = resolveExecutable("cat", { cwd: fix.root, env: { PATH: path.join(fix.root, "bin") }, workspace: fix.workspace() });
    expect(resolved.ok).toBe(false);
  });
});
