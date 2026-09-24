import exceptions from "./quality-exceptions.json" with { type: "json" };

const excluded = [...exceptions.coverage, ...exceptions.mutation].map((entry) => `!${entry.path}`);

export default {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",

  testRunner: "vitest",

  // NOTE: the vitest runner is patched — see `patches/@stryker-mutator%2Fvitest-runner@10.0.0.patch`.
  // Vitest 5 matches `testNamePattern` against `fullTestName`, which joins the describe chain with
  // `" > "`. The runner still builds its per-mutant filter by joining with a single space, so every
  // test nested in a `describe` is skipped, zero tests run per mutant and everything is reported
  // Survived (score 3.33% here). The patch changes both copies of `collectTestName` to join with
  // `" > "`. Upstream: https://github.com/stryker-mutator/stryker-js/issues/6210 — drop the patch
  // once that ships. If a version bump makes the patch stop applying, this gate fails closed: the
  // score collapses and `thresholds.break` fails the build rather than passing vacuously.

  // Stryker discovers plugins by globbing `node_modules/@stryker-mutator/*`. Bun's isolated
  // linker leaves only symlinks behind, so the glob finds nothing and the runner fails with
  // `Cannot find TestRunner plugin "vitest"`.
  //
  // This must be a **path**, not the package name `@stryker-mutator/vitest-runner`. With
  // `globalStore = true` the real packages live in ~/.bun/install/cache/links, which is not a
  // parent of this project, so Stryker cannot resolve the plugin by name from its own location.
  // The path goes through the project's own symlink, which resolves under either store layout.
  plugins: ["./node_modules/@stryker-mutator/vitest-runner/dist/src/index.js"],

  // Points at a file that deliberately does not exist. Stryker's TSConfigPreprocessor rewrites
  // relative `extends`/`references` paths so they still resolve from inside the sandbox, and it
  // does that with `import('typescript')` + `ts.parseConfigFileTextToJson`. TypeScript 7.0.2
  // ships no compiler API (its entry point exports only `version` and `versionMajorMinor`), so
  // the preprocessor throws `TypeError: ts.parseConfigFileTextToJson is not a function`. When
  // the configured file is absent the preprocessor no-ops, which is what we want anyway: the
  // sandbox is a copy of the whole repo, so every relative `extends` already resolves, and
  // nothing typechecks inside the sandbox. Revisit once TypeScript 7.1 restores the API.
  tsconfigFile: "tsconfig.stryker-disabled.json",

  coverageAnalysis: "perTest",
  mutate: ["{apps,packages}/*/src/**/*.ts", "!**/*.test.ts", ...excluded],
  thresholds: { high: 100, low: 100, break: 100 },
  reporters: ["progress", "clear-text"],
};
