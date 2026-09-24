import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

/**
 * Proves each gate actually rejects the thing it claims to reject.
 *
 * A misconfigured gate does not fail loudly — it exits 0 while enforcing
 * nothing. Every check plants deliberately bad code, runs the real gate, and
 * asserts it is rejected *and named the expected rule*: an exit code alone
 * would pass if the gate had failed for an unrelated reason.
 *
 * Planted files are always removed, including on failure.
 */

const SCRATCH = ".gates-check";

type Check = {
  readonly gate: string;
  readonly files: Readonly<Record<string, string>>;
  readonly command: readonly string[];
  readonly expect: string;
  /** Re-run on a clean tree to catch a gate that rejects everything. */
  readonly checkInverse: boolean;
};

const repeat = (count: number, make: (index: number) => string): string =>
  `${Array.from({ length: count }, (_, index) => make(index)).join("\n")}\n`;

const oxlintOn = (path: string): readonly string[] => ["oxlint", "-c", ".oxlintrc.json", path];

/** Long enough to exceed jscpd's 50-token minimum. */
const DUPLICATED_BLOCK = repeat(
  30,
  (index) => `  const value${index} = compute(${index}) + compute(${index + 1});`,
);

const duplicatedModule = (name: string): string =>
  `const compute = (n: number): number => n * 2;\nexport const ${name} = (): void => {\n${DUPLICATED_BLOCK}};\n`;

const CHECKS: readonly Check[] = [
  {
    gate: "cyclomatic/cognitive complexity",
    files: {
      [join(SCRATCH, "complexity.ts")]: `export const tangled = (n: number): number => {\n${repeat(
        25,
        (i) => `  if (n === ${i}) { return ${i}; }`,
      )}  return -1;\n};\n`,
    },
    command: oxlintOn(join(SCRATCH, "complexity.ts")),
    expect: "complexity",
    checkInverse: true,
  },
  {
    gate: "lines per file",
    files: { [join(SCRATCH, "long.ts")]: repeat(520, (i) => `export const v${i} = ${i};`) },
    command: oxlintOn(join(SCRATCH, "long.ts")),
    expect: "max-lines",
    checkInverse: true,
  },
  {
    gate: "no `any`",
    files: { [join(SCRATCH, "any.ts")]: "export const loose = (v: any): any => v;\n" },
    command: oxlintOn(join(SCRATCH, "any.ts")),
    expect: "no-explicit-any",
    checkInverse: true,
  },
  {
    gate: "no undeclared `unknown`",
    files: {
      [join(SCRATCH, "unknown.ts")]: "export const wide = (v: unknown): number => Number(v);\n",
    },
    command: oxlintOn(join(SCRATCH, "unknown.ts")),
    expect: "no-restricted-types",
    checkInverse: true,
  },
  {
    gate: "100% coverage",
    files: {
      "packages/duration/src/gate-check.ts":
        "export const untested = (n: number): number => (n > 0 ? n : 0);\n",
    },
    command: ["vitest", "run", "--coverage", "--silent"],
    expect: "does not meet",
    checkInverse: false,
  },
  {
    gate: "dead code",
    files: {
      "packages/duration/src/gate-check.ts": "export const orphan = 1;\n",
    },
    command: ["knip"],
    expect: "Unused files",
    checkInverse: false,
  },
  {
    gate: "duplicated code",
    files: {
      "packages/duration/src/gate-check-a.ts": duplicatedModule("a"),
      "packages/duration/src/gate-check-b.ts": duplicatedModule("b"),
    },
    command: ["jscpd"],
    expect: "Clone found",
    checkInverse: false,
  },
];

const run = (command: readonly string[]): { readonly code: number; readonly output: string } => {
  const [binary, ...args] = command;
  const result = spawnSync(binary ?? "", args, { encoding: "utf8", shell: false });
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const plant = (files: Readonly<Record<string, string>>): void => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
};

const uproot = (files: Readonly<Record<string, string>>): void => {
  for (const path of Object.keys(files)) {
    rmSync(path, { force: true });
  }
};

const verify = (check: Check): readonly string[] => {
  const problems: string[] = [];
  try {
    plant(check.files);
    const rejected = run(check.command);
    if (rejected.code === 0) {
      problems.push(`${check.gate}: accepted code it should have rejected`);
    } else if (!rejected.output.includes(check.expect)) {
      problems.push(
        `${check.gate}: rejected, but never mentioned "${check.expect}" — it may be failing for an unrelated reason`,
      );
    }
  } finally {
    uproot(check.files);
  }

  if (check.checkInverse) {
    const clean = Object.fromEntries(
      Object.keys(check.files).map((path) => [path, "export const fine = 1;\n"]),
    );
    try {
      plant(clean);
      const accepted = run(check.command);
      if (accepted.code !== 0) {
        problems.push(`${check.gate}: rejected clean code\n${accepted.output}`);
      }
    } finally {
      uproot(clean);
    }
  }

  return problems;
};

/**
 * The mutation gate's real failure mode is the bun patch silently not applying
 * after a version bump, so assert the patch rather than run a full mutation
 * pass. See README "Known patch".
 */
const verifyStrykerPatch = (): readonly string[] => {
  const patched = [
    "node_modules/@stryker-mutator/vitest-runner/dist/src/test-helpers.js",
    "node_modules/@stryker-mutator/vitest-runner/dist/src/stryker-setup.js",
  ];
  return patched
    .filter((path) => !existsSync(path) || !readFileSync(path, "utf8").includes("join(' > ')"))
    .map(
      (path) =>
        `mutation runner patch: ${path} is missing the " > " test-name separator; mutation results cannot be trusted`,
    );
};

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });

const failures = [...CHECKS.flatMap(verify), ...verifyStrykerPatch()];

for (const check of CHECKS) {
  process.stdout.write(`  ${check.gate}\n`);
}
process.stdout.write("  mutation runner patch\n");

rmSync(SCRATCH, { recursive: true, force: true });

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`ERROR ${failure}\n`);
  }
  process.exitCode = 1;
}
