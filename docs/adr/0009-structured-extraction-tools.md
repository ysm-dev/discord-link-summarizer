# Extraction uses structured tools instead of shell globs

The operator approved replacing the proposed shell allowlist after source-level
probes showed that OpenCode v2.0.15's shell scanner omits some redirection and zsh
execution syntax. Permission globs over scanner output cannot provide the
required arbitrary-command restriction.

The translate agent denies generic shell access. Narrow structured tools accept
a validated HTTP(S) URL and invoke one of the two existing extraction scripts
using a fixed executable, fixed script path, and a single URL argument, without
shell interpolation. Execution time and output are bounded. The agent and tool
artifacts are delivered here for human installation in translate; its existing
command and extraction scripts remain the source of summary behavior.
