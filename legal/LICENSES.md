# Distribution and third-party terms

Project-owned CCodex source is distributed under the MIT License in `LICENSE`.

- OpenAI Codex `0.144.6` is used and linked under Apache-2.0. The exact upstream revision is recorded in `compatibility.json`.
- Claude Agent SDK `0.3.215` is installed from Anthropic's npm package as an exact runtime dependency; CCodex does not copy or rehost its platform binaries. Use remains subject to Anthropic's applicable legal agreements.
- Each user authenticates locally with their own Codex and Claude Code sessions. CCodex does not collect, proxy, share, or bundle provider credentials.
- Provider authentication and subscription policies can change independently of CCodex. Compatibility with a current login flow is not a guarantee of future provider support.
- `THIRD_PARTY_NOTICES.md`, the npm/Cargo SBOMs, and release checksums are generated from the exact lockfiles for every release.

CCodex is independent and unofficial. It is not affiliated with or endorsed by OpenAI or Anthropic. Codex, Claude, and related marks belong to their respective owners.
