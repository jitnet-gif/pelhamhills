# Pulls saved Claude Code sessions and the current code branch from GitHub.
#
# One-time setup, from the project root on each computer:
#   git fetch origin claude-sessions
#   New-Item -ItemType Directory -Force .claude | Out-Null
#   git show origin/claude-sessions:session-sync.ps1 | Out-File -Encoding utf8 .claude\session-sync.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .claude\session-sync.ps1 -Install
#
# -Install adds a SessionStart hook to .claude/settings.local.json (not tracked by
# git), so this script then runs each time Claude Code starts in the project.
param([switch]$Install)

$branch = 'claude-sessions'
$hookCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File .claude/session-sync.ps1'

$root = git rev-parse --show-toplevel 2>$null
if (-not $root) { exit 0 }
Set-Location $root

if ($Install) {
    $path = Join-Path $root '.claude\settings.local.json'
    $settings = New-Object PSObject
    if (Test-Path $path) {
        $text = [IO.File]::ReadAllText($path)
        if ($text.Trim()) { $settings = $text | ConvertFrom-Json }
    }
    if (-not $settings.hooks) { $settings | Add-Member -NotePropertyName hooks -NotePropertyValue (New-Object PSObject) -Force }
    $entries = @($settings.hooks.SessionStart | Where-Object { $_ })
    $installed = $entries | Where-Object { $_.hooks.command -contains $hookCommand }
    if (-not $installed) {
        $entries += [PSCustomObject]@{
            matcher = 'startup'
            hooks   = @([PSCustomObject]@{ type = 'command'; command = $hookCommand })
        }
        $settings.hooks | Add-Member -NotePropertyName SessionStart -NotePropertyValue $entries -Force
        $json = ConvertTo-Json -InputObject $settings -Depth 20
        [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding($false)))
    }
    Write-Output 'Session sync hook installed.'
}

# Code: fast-forward only, so local work is never merged or overwritten.
$upstream = git rev-parse --abbrev-ref '@{u}' 2>$null
if ($upstream) {
    git pull --ff-only --quiet 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Output "Session sync: code was not updated. The current branch cannot fast-forward to $upstream; resolve it manually."
    }
}

# Sessions: transcripts only grow, so a local copy that is the same size or larger wins.
git fetch --quiet origin $branch 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Output "Session sync: could not fetch $branch."
    exit 0
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("session-sync-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Force $temp | Out-Null
try {
    $archive = Join-Path $temp 'sessions.tar'
    git archive -o $archive "origin/$branch" sessions
    tar -xf $archive -C $temp
    if ($LASTEXITCODE -ne 0) {
        Write-Output 'Session sync: could not unpack the saved sessions.'
        exit 0
    }

    $key = $root -replace '[^A-Za-z0-9]', '-'
    $target = Join-Path $env:USERPROFILE ".claude\projects\$key"
    New-Item -ItemType Directory -Force $target | Out-Null

    Get-ChildItem (Join-Path $temp 'sessions') -Filter *.jsonl | ForEach-Object {
        $local = Join-Path $target $_.Name
        if (-not (Test-Path $local) -or (Get-Item $local).Length -lt $_.Length) {
            Copy-Item $_.FullName $local -Force
            Write-Output "Session sync: added $($_.BaseName). Open it with /resume."
        }
    }
}
finally {
    Remove-Item -Recurse -Force $temp
}
exit 0
