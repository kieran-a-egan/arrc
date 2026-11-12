# ARRC development on Windows (native)

The primary host is native Windows PowerShell, without mandatory WSL or Docker. M0-01 will define and pin the supported Node.js/npm toolchain and scripts. M0-02 will provide the read-only doctor command.

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
