[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GitHubOwner,

    [string]$RepositoryName = (Split-Path -Leaf (Get-Location)),
    [ValidateSet("public", "private")]
    [string]$Visibility = "private"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
    throw "GitHub CLI is not installed. Install it with 'winget install GitHub.cli' and run 'gh auth login' first."
}

$gitRoot = git rev-parse --show-toplevel 2>$null
if (-not $gitRoot) {
    git init -b main | Out-Null
} else {
    git branch -M main | Out-Null
}

$hasCommit = git rev-parse --verify HEAD 2>$null
git add .
if (-not $hasCommit) {
    git commit -m "Initial commit" | Out-Null
}

gh auth status
gh repo create "$GitHubOwner/$RepositoryName" "--$Visibility" --source . --remote origin --push
