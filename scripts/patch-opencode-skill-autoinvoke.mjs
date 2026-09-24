#!/usr/bin/env node
// Patches vendored SKILL.md files so OpenCode v2 respects the same
// "user-invoked only" boundary that mattpocock/skills expresses via the
// Claude Code frontmatter key `disable-model-invocation: true`.
//
// OpenCode v2 doesn't read that key. Its equivalent is the frontmatter field
// `metadata.opencode/autoinvoke: false`, which hides a skill from the list
// the model can call on its own while leaving it loadable by explicit ID or
// slash command. See: https://opencode.ai/v2/docs/skills#frontmatter
//
// Safe to re-run (idempotent) after `npx skills update` re-copies files.
//
// Usage: node scripts/patch-opencode-skill-autoinvoke.mjs [skillsDir]

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const skillsDir = process.argv[2] ?? ".agents/skills";

const DISABLE_RE = /^disable-model-invocation:\s*true\s*$/;
const METADATA_RE = /^metadata:\s*$/;
const AUTOINVOKE_RE = /opencode\/autoinvoke:\s*false/;

function findSkillFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSkillFiles(full));
    } else if (entry.name === "SKILL.md") {
      results.push(full);
    }
  }
  return results;
}

function patchFile(path) {
  const original = readFileSync(path, "utf8");
  const lines = original.split("\n");

  if (lines[0] !== "---") return "not-frontmatter";

  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) return "not-frontmatter";

  const frontmatter = lines.slice(1, closingIndex);

  if (frontmatter.some((l) => AUTOINVOKE_RE.test(l))) return "already-patched";

  const disableIndex = frontmatter.findIndex((l) => DISABLE_RE.test(l));
  if (disableIndex === -1) return "not-user-invoked";

  const metadataIndex = frontmatter.findIndex((l) => METADATA_RE.test(l));

  if (metadataIndex !== -1) {
    frontmatter.splice(metadataIndex + 1, 0, "  opencode/autoinvoke: false");
  } else {
    frontmatter.splice(
      disableIndex + 1,
      0,
      "metadata:",
      "  opencode/autoinvoke: false"
    );
  }

  const patched = ["---", ...frontmatter, ...lines.slice(closingIndex)].join(
    "\n"
  );
  writeFileSync(path, patched, "utf8");
  return "patched";
}

const files = findSkillFiles(skillsDir).filter((p) => statSync(p).isFile());
const counts = { patched: 0, "already-patched": 0, "not-user-invoked": 0, "not-frontmatter": 0 };

for (const file of files) {
  const result = patchFile(file);
  counts[result]++;
  if (result === "patched") console.log(`patched   ${file}`);
}

console.log(
  `\nDone. ${counts.patched} patched, ${counts["already-patched"]} already patched, ` +
    `${counts["not-user-invoked"]} left untouched (model-invoked), out of ${files.length} SKILL.md files scanned in ${skillsDir}.`
);
