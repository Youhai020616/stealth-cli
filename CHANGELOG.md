# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the project remains pre-1.0, minor releases may include compatibility changes.

## [Unreleased]

## [0.7.0] - 2026-07-23

### Added

- Added `stealth open` for human-assisted login, CAPTCHA, 2FA, and OAuth flows. It always launches a headed direct browser, ignores stdin, waits until all windows close, and persists authentication state.
- Added durable browser lifecycle coordination with periodic checkpoints, final live capture, disconnect fallback, and graceful `SIGHUP`, `SIGINT`, and `SIGTERM` handling.
- Added `--profile` and `--session` support to `stealth interactive`, including explicit-URL precedence over a restored session URL.
- Added accessibility-tree `@ref` targeting for click, type, hover, and select workflows across CLI, daemon, SDK, and MCP integrations.
- Added public SDK lifecycle, cleanup-recovery, specialized error, profile, session, and accessibility exports.
- Added GitHub Actions coverage for supported Node.js 20 and 22 runtimes.

### Changed

- Node.js 20 or newer is now required.
- Profile and session launches now use stricter identity linking, restoration, checkpointing, and cleanup semantics.
- Daemon search and extraction now use server-side extractors with accessibility-tree support and safer fallbacks.
- Project documentation now covers headed authentication, persistence recovery, SDK cleanup behavior, and security constraints.

### Fixed

- Pinned `playwright-core` to `1.59.1` to prevent a Firefox viewport-protocol mismatch with current Camoufox binaries.
- Preserved `#HttpOnly_` Netscape cookies during import.
- Percent-decoded proxy credentials before passing them to Playwright and rejected malformed encodings.
- Preserved safe proxy and configuration diagnostics without exposing raw credential-bearing causes.
- Rendered opaque URLs such as `about:blank` as the current page instead of `null`.
- Isolated HOME-backed configuration and proxy tests from the real user environment.
- Added canonical npm repository, homepage, and issue-tracker metadata.

### Security

- Added descriptor-bound private reads and owner-only atomic JSON writes with durable claim, temporary, and rollback artifacts.
- Added single-writer profile/session leases held for browser lifetimes and standalone state mutations.
- Added strict, portable state-name validation, including path-like input and Windows reserved device names.
- Added fail-closed handling for stale locks, cross-process JSON artifacts, unsafe ancestors, and symlink replacement.
- Hardened CLI and SDK errors so raw causes, credential-bearing URLs, and cleanup internals remain non-enumerable and redacted.
- Added explicit recovery APIs and exact-path guidance for incomplete browser, lock, and persistence cleanup.
- Known upstream limitation: the current `camoufox-js@0.9.3` dependency tree resolves `adm-zip@0.5.18`, which is affected by [GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85). npm reports five high-severity dependency-chain findings rooted in this single availability advisory. Camoufox uses `adm-zip` while extracting its GitHub Release browser archive; stealth-cli does not expose an arbitrary ZIP-ingestion API. No compatible upstream fix was available when this release was prepared.

### Compatibility and migration notes

- Node.js 18 is no longer supported; upgrade to Node.js 20 or newer before installing this release.
- Invalid or non-portable profile/session names are rejected. Legacy sanitized metadata is rewritten on the next successful save.
- A session linked to a different profile is rejected instead of merging browser identities.
- State locks and sensitive JSON artifacts fail closed after crashes. Verify that no live process owns a reported artifact before removing only the exact path shown by the CLI.
- `STEALTH_HOME` controls profile, session, and lock storage; configuration, proxy-pool, and daemon paths remain under `~/.stealth`.

### Validation

- 432 tests pass across 29 test files, including real-browser lifecycle, signal, persistence, locking, redaction, and cross-process coverage.

[Unreleased]: https://github.com/Youhai020616/stealth-cli/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/Youhai020616/stealth-cli/compare/v0.6.1...v0.7.0
