import { expect, it } from "@effect/vitest";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, vi } from "vitest";
import { machineLockPath, withMachineLock } from "../src/machine-lock.ts";

const lockPath = () => join(mkdtempSync(join(tmpdir(), "dls-lock-")), "private", "run.lock");
const spawnCode = (
  command: string,
  args: string[],
  stdio: ["ignore", "ignore", "ignore", number] | ["ignore", "ignore", "ignore"],
) => {
  const child = spawn(command, args, { stdio });
  return {
    exited: new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    }),
  };
};
vi.stubGlobal("Bun", {
  spawn: (args: string[], options: { stdio: ["ignore", "ignore", "ignore", number] }) =>
    spawnCode(args[0]!, args.slice(1), options.stdio),
});
afterAll(() => vi.unstubAllGlobals());
const contender = async (path: string) =>
  await spawnCode(
    "/usr/bin/lockf",
    ["-k", "-t", "0", path, "/usr/bin/true"],
    ["ignore", "ignore", "ignore"],
  ).exited;

it.effect("Bun owns the FD after helper exit; contender skips until scope closes", () =>
  Effect.gen(function* () {
    const path = lockPath();
    const result = yield* withMachineLock(
      Effect.gen(function* () {
        expect(yield* Effect.promise(() => contender(path))).toBe(75);
        expect(yield* withMachineLock(Effect.succeed("entered"), path)).toBe("already-running");
        return "held";
      }),
      path,
    );
    expect(result).toBe("held");
    expect(yield* Effect.promise(() => contender(path))).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(path)).toBe(true);
  }),
);

it.effect("process death releases the kernel lock without deleting the stable inode", () =>
  Effect.gen(function* () {
    const path = lockPath();
    const source = new URL("./lock-child.ts", import.meta.url).pathname;
    const child = spawn("bun", [source, path], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const line = yield* Effect.promise(
        () =>
          new Promise<string>((resolve, reject) => {
            child.stdout.once("data", (data: Buffer) => resolve(data.toString()));
            child.once("error", reject);
            child.once("exit", () => reject(new Error("Bun exited before acquiring lock")));
          }),
      );
      expect(line).toContain("HELD");
      expect(yield* Effect.promise(() => contender(path))).toBe(75);
    } finally {
      child.kill("SIGKILL");
      yield* Effect.promise(
        () => new Promise<void>((resolve) => child.once("exit", () => resolve())),
      );
    }
    expect(yield* Effect.promise(() => contender(path))).toBe(0);
  }),
);

it.effect("open failures and helper errors are reported without entering the Run", () =>
  Effect.gen(function* () {
    const path = lockPath();
    expect(
      (yield* Effect.flip(withMachineLock(Effect.succeed("entered"), "/dev/null/private/run.lock")))
        .message,
    ).toContain("Cannot open");
    expect(
      yield* Effect.flip(withMachineLock(Effect.succeed("entered"), "/dev/null/private/run.lock")),
    ).toMatchObject({ _tag: "MachineLockError" });
    expect(machineLockPath()).toContain("discord-link-summarizer/run.lock");
    expect(yield* withMachineLock(Effect.succeed("entered"), path)).toBe("entered");
    vi.stubGlobal("Bun", { spawn: () => ({ exited: Promise.resolve(2) }) });
    expect(
      (yield* Effect.flip(withMachineLock(Effect.succeed("entered"), path))).message,
    ).toContain("exited 2");
    vi.stubGlobal("Bun", {
      spawn: () => {
        throw new Error("spawn failed");
      },
    });
    expect(
      (yield* Effect.flip(withMachineLock(Effect.succeed("entered"), path))).message,
    ).toContain("Cannot acquire");
    expect(yield* Effect.promise(() => contender(path))).toBe(0);
  }),
);
