## What Problem This Solves

PR #160227 failed maintainer review because it modified 7,715 files, exceeding GitHub's 3,000-file Security Review limit. This caused repeated CI failures with "GitHub did not return a consistent, complete changed-file list (expected 7715, received 3000)".

This PR ports the consult correlation behavior to current main APIs using only 7 files (2,174 insertions), eliminating the oversized diff problem.

## Evidence

- 23/23 consult.test.ts pass
- 7 files changed, 2,174 insertions, 12 deletions
- Lint clean on all changed files
- Security Review limit: 7 files << 3,000 file threshold
