# ARRC development on Windows (native)

The primary host is native Windows PowerShell, without mandatory WSL or Docker. The toolchain is pinned (see below). M0-02 will provide the read-only doctor command.

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
