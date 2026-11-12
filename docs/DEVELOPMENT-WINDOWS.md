# ARRC development on Windows (native)

The primary host is native Windows PowerShell, without mandatory WSL or Docker. The toolchain is pinned (see below). The environment doctor always exits 0; read the statuses.

- Bootstrap-safe: `node packages/core/src/doctor.ts` (or `node packages/core/src/doctor.ts --json`). It runs without npm, so it works even when your npm fails `devEngines` (`EBADDEVENGINES`) and then reports the npm mismatch. No `npm ci` or build needed.
- Already-compliant environments: `npm run doctor`, or `npm run doctor --silent -- --json` (`--silent` keeps npm notices out of stdout).
- Node 24 (`.nvmrc`) is the supported version. Node 22.18+/23.6+ can still run the doctor (type stripping is on by default) and it will report `node.runtime: mismatch`. Older Node fails with `ERR_UNKNOWN_FILE_EXTENSION`: install the `.nvmrc` version from https://nodejs.org (or your version manager) and re-run.
- Side effects: the doctor never installs, writes files or uses the network itself. It runs bounded version queries (`git --version`, `docker --version`, `claude --version`, a PowerShell `$PSVersionTable` query with `-NoProfile -NonInteractive`) and, on Windows, npm's `npm-prefix.js` under node; no shell, 5 s timeout (direct child only), update/telemetry opt-out env vars where supported (Claude Code, PowerShell). Third-party executables' internal behaviour can't be guaranteed.

## Pinned toolchain and commands

- Node.js `^24.15.0` (`.nvmrc`: 24.19.0) and npm `12.0.2`, enforced by `devEngines` in `package.json` (`onFail: error`).
- TypeScript 6.0.3; dependencies are locked by `package-lock.json`.

Node 24.19.0 bundles npm 11.17.0, but the repo's `devEngines` requires exactly npm 12.0.2; any other npm version fails every npm command in the repo with `EBADDEVENGINES`. Bump `devEngines`, CI and these docs together when upgrading.

One-time setup (global installs skip the devEngines check), then from the repository root in PowerShell:

    npm install -g npm@12.0.2
    npm ci
    npm run build
    npm run typecheck
    npm test

## Read-only prerequisite inspection

Run the following commands in PowerShell (do not assume they are all installed):

    Get-Command node,npm,git,gh,claude,pwsh,bash -ErrorAction SilentlyContinue |
      Select-Object Name,Source

    node --version
    npm --version
    git --version

The version commands require those tools to be installed.

## Required Windows acceptance coverage

- Paths with spaces, Unicode, long paths, case-insensitivity, symlinks and reparse points.
- .exe/.cmd/.ps1 launch distinctions, explicit shell choice, descendant termination, large output and exit codes.
- Dirty/untracked user files, Git worktree ownership, Windows handle locking and checkpoint reconciliation.
- Installed Claude Code session, permission enforcement and subscription versus API billing identity.
- Windows CI as the release gate and Linux/macOS verification only where compatible runners are actually available.
- Security containment must be capability-verified; worktrees do not provide hostile-code isolation.

For the project's initial issue order, see [ROADMAP.md](ROADMAP.md).
