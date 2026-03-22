[CmdletBinding()]
param(
    [string]$BaseUrl = "http://127.0.0.1:3001",
    [string]$Email = "theo@yt-asr.local",
    [string]$Password = "admin1234",
    [switch]$StartServer
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$tempAudio = Join-Path $env:TEMP "yt-asr-smoke.wav"
$cookieJar = Join-Path $env:TEMP "yt-asr-smoke-cookie.txt"
$serverProcess = $null

try {
    if ($StartServer) {
        $serverProcess = Start-Process node -ArgumentList "server/index.js" -WorkingDirectory $root -PassThru
        Start-Sleep -Seconds 4
    }

    cmd /c "ffmpeg -y -f lavfi -i sine=frequency=440:duration=2 -ac 1 -ar 16000 `"$tempAudio`" 1>nul 2>nul"
    if ($LASTEXITCODE -ne 0) {
        throw "ffmpeg smoke input generation failed."
    }

    Remove-Item $cookieJar -Force -ErrorAction SilentlyContinue
    $loginPayload = @{ email = $Email; password = $Password } | ConvertTo-Json -Compress
    curl.exe -s -c $cookieJar -H "Content-Type: application/json" -d $loginPayload "$BaseUrl/api/auth/login" *> $null

    $queuedRaw = curl.exe -s -b $cookieJar -c $cookieJar `
        -F "title=Smoke Test Audio" `
        -F "source=Local Smoke Test" `
        -F "language=en" `
        -F "media=@$tempAudio" `
        "$BaseUrl/api/import/media"

    $queued = $queuedRaw | ConvertFrom-Json
    $jobId = $queued.job.id
    $completed = $null

    for ($index = 0; $index -lt 25; $index += 1) {
        Start-Sleep -Seconds 1
        $jobs = (curl.exe -s -b $cookieJar "$BaseUrl/api/jobs" | ConvertFrom-Json).jobs
        $current = $jobs | Where-Object { $_.id -eq $jobId }
        if ($current.status -eq "completed" -or $current.status -eq "failed") {
            $completed = $current
            break
        }
    }

    $state = curl.exe -s -b $cookieJar "$BaseUrl/api/state" | ConvertFrom-Json

    [pscustomobject]@{
        jobStatus    = $completed.status
        jobMessage   = $completed.message
        jobError     = $completed.error
        titleCount   = $state.state.titles.Count
        firstTitle   = if ($state.state.titles.Count -gt 0) { $state.state.titles[0].title } else { $null }
        firstAudio   = if ($state.state.titles.Count -gt 0) { $state.state.titles[0].audioUrl } else { $null }
        firstWaveform = if ($state.state.titles.Count -gt 0) { $state.state.titles[0].waveformUrl } else { $null }
    } | ConvertTo-Json -Compress
}
finally {
    Remove-Item $tempAudio -Force -ErrorAction SilentlyContinue
    Remove-Item $cookieJar -Force -ErrorAction SilentlyContinue
    if ($serverProcess) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
