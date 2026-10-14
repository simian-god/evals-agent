# Install the evals skill into Claude Code and Codex by junction, so this repo
# stays the single source of truth and the installed copies can never drift.
#
#   pwsh -File install\sync.ps1            # install / repair junctions
#   pwsh -File install\sync.ps1 -Status    # report what is installed
#   pwsh -File install\sync.ps1 -Copy      # copy instead of junction (not recommended)
#   pwsh -File install\sync.ps1 -Remove    # uninstall
#
# Directory junctions need no administrator rights on Windows, which is why they
# are the default here rather than symlinks.
param(
    [switch]$Status,
    [switch]$Copy,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo "skill"
$targets = @(
    (Join-Path $env:USERPROFILE ".claude\skills\evals"),
    (Join-Path $env:USERPROFILE ".codex\skills\evals")
)

if (-not (Test-Path (Join-Path $source "SKILL.md"))) {
    throw "No SKILL.md at $source - run this from the Evals repo."
}

function Get-LinkInfo([string]$path) {
    if (-not (Test-Path $path)) { return "absent" }
    $item = Get-Item $path -Force
    if ($item.LinkType) { return "$($item.LinkType) -> $($item.Target)" }
    return "real directory"
}

if ($Status) {
    Write-Host "source: $source"
    foreach ($t in $targets) { Write-Host ("  {0,-55} {1}" -f $t, (Get-LinkInfo $t)) }
    return
}

foreach ($target in $targets) {
    $parent = Split-Path -Parent $target
    if (-not (Test-Path $parent)) {
        Write-Host "skip (no client dir): $parent"
        continue
    }

    if (Test-Path $target) {
        $item = Get-Item $target -Force
        if ($item.LinkType) {
            # Ours to replace: a link we can recreate losslessly.
            (Get-Item $target -Force).Delete()
        } elseif ($Remove) {
            Write-Warning "$target is a real directory, not a link - leaving it alone."
            continue
        } else {
            throw "$target is a real directory. Move or delete it first; refusing to overwrite files that are not ours."
        }
    }

    if ($Remove) {
        Write-Host "removed: $target"
        continue
    }

    if ($Copy) {
        Copy-Item -Recurse -Force $source $target
        Write-Host "copied:  $target  (will drift from the repo - re-run after every change)"
    } else {
        New-Item -ItemType Junction -Path $target -Target $source | Out-Null
        Write-Host "linked:  $target  ->  $source"
    }
}

if (-not $Remove) {
    Write-Host ""
    Write-Host "Installed. In Claude Code the skill is /evals; in Codex it is picked up from ~/.codex/skills."
    Write-Host "Verify with: pwsh -File install\sync.ps1 -Status"
}
