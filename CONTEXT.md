# ts-template

A TypeScript monorepo template whose purpose is to make agent-generated code safe to merge. Its subject matter is the enforcement machinery itself, so the vocabulary below is about gates and exceptions rather than any business domain. A project created from this template should replace this file with its own.

## Language

### Enforcement

**Gate**:
A single automated check that blocks a merge when it fails. There are eight, listed in `README.md`.
_Avoid_: rule, check, lint (a lint rule is one implementation of a gate, not a synonym)

**Silent false pass**:
A gate that exits 0 while enforcing nothing, usually because its inputs failed to resolve. The failure mode this template is designed around, and the reason `verify-gates` exists.
_Avoid_: false negative, silent failure

**Exception**:
A named, reasoned, human-approved waiver of one gate for one path. Lives in `quality-exceptions.json` when it covers a whole file, or as an inline suppression carrying `-- <reason>` when it covers a single line.
_Avoid_: ignore, suppression, disable, override, waiver

**Tier**:
Where a gate runs: pre-commit, pre-push, or CI. Tiers exist because gates differ by orders of magnitude in cost, not because they differ in importance.
_Avoid_: stage, level, phase

### Structure

**Archetype**:
One of the two shapes a workspace package may take. A **library** lives in `packages/` and is consumed by other workspace packages; an **application** lives in `apps/` and is the thing that runs.
_Avoid_: kind, category, template (overloaded here), project

**Just-in-Time package**:
A workspace package whose `exports` points at TypeScript source, with no build step and no emitted `dist/`. The only package shape this template supports.
_Avoid_: source package, unbuilt package, internal package

**Trust boundary**:
A function that accepts untrusted input as `unknown` and narrows it before anything downstream sees it. The only place `unknown` may be declared, and the only accepted justification for suppressing the `unknown` ban.
_Avoid_: validator, parser, guard (a type guard is a tool used at a trust boundary, not the boundary itself)
