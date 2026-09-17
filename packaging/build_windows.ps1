# Builds the Windows desktop app and zips it twice into packaging\dist:
#
#   chess-review-windows.zip            the whole app: what a new user downloads
#   chess-review-update-<runtime>.zip   the exe + _internal\chess_review (+ assets): what the in-app updater
#                                       fetches when the install's runtime fingerprint matches (a few MB
#                                       instead of ~100). pack.py explains <runtime>; both zips carry it in
#                                       _internal\build.json next to the version (the git tag; -Version overrides).
#
# Run from a Windows terminal (PowerShell), from anywhere:
#
#   powershell -ExecutionPolicy Bypass -File packaging\build_windows.ps1
#
# Needs Python 3.12+ on PATH. The first run downloads the latest Stockfish (~100 MB) and creates a build
# venv; later runs reuse both. -Clean discards the previous build output first.
#
# The build deps are pinned in requirements-build.txt so the runtime fingerprint only moves when someone bumps
# them (each bump makes the next release a full download for everyone). Refresh the pins deliberately:
#   & "$env:LOCALAPPDATA\chess-review-build\venv\Scripts\pip" install -U -r requirements.txt pywebview pyinstaller
#   & "$env:LOCALAPPDATA\chess-review-build\venv\Scripts\pip" freeze > packaging\requirements-build.txt
#
# The venv and the build output live under %LOCALAPPDATA%\chess-review-build, NOT in the repo: when the
# repo is on the WSL filesystem (\\wsl.localhost\...) .NET refuses to load pywebview's assemblies from
# there, and building over the network share is slow anyway.

param(
    [switch]$Clean,
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Packaging = Join-Path $Root "packaging"
$BuildHome = Join-Path $env:LOCALAPPDATA "chess-review-build"
$Venv = Join-Path $BuildHome "venv"
$Dist = Join-Path $BuildHome "dist"
$Work = Join-Path $BuildHome "build"

if ($Clean) {
    Remove-Item -Recurse -Force $Dist, $Work -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $BuildHome, "$Packaging\dist" | Out-Null

# 1. Build venv: the project's runtime deps + pywebview (native window) + PyInstaller, at pinned versions
if (-not (Test-Path "$Venv\Scripts\python.exe")) {
    Write-Host "Creating build venv in $Venv ..."
    python -m venv $Venv
}
$Py = Join-Path $Venv "Scripts\python.exe"
& $Py -m pip install --quiet --upgrade pip
& $Py -m pip install --quiet -r "$Packaging\requirements-build.txt"

# 2. Stockfish: fetch the latest Windows release if not already staged
$StockfishExe = Join-Path $Packaging "bin\stockfish.exe"
if (-not (Test-Path $StockfishExe)) {
    Write-Host "Downloading latest Stockfish (Windows x86-64)..."
    New-Item -ItemType Directory -Force -Path "$Packaging\bin" | Out-Null
    $tmp = Join-Path $env:TEMP "chess-review-sf"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $headers = @{ "User-Agent" = "chess-review-build" }
    if ($env:GH_TOKEN) { $headers["Authorization"] = "Bearer $env:GH_TOKEN" }   # CI: shared runner IPs exhaust the anonymous rate limit
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/official-stockfish/Stockfish/releases/latest" -Headers $headers
    $asset = $rel.assets | Where-Object { $_.name -eq "stockfish-windows-x86-64-universal.zip" }
    $zipPath = Join-Path $tmp "stockfish.zip"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
    $exe = Get-ChildItem -Recurse $tmp -Filter "*.exe" | Select-Object -First 1
    Copy-Item $exe.FullName $StockfishExe -Force
    Remove-Item -Recurse -Force $tmp
}

# 3. Opening book TSVs (lichess chess-openings, CC0): from data/book if scripts/fetch_book.sh has run, else downloaded
$BookDir = Join-Path $Packaging "assets\book"
if (-not (Get-ChildItem $BookDir -Filter "*.tsv" -ErrorAction SilentlyContinue)) {
    New-Item -ItemType Directory -Force -Path $BookDir | Out-Null
    $srcBook = Join-Path $Root "data\book"
    if (Get-ChildItem $srcBook -Filter "*.tsv" -ErrorAction SilentlyContinue) {
        Copy-Item "$srcBook\*.tsv" $BookDir -Force
    } else {
        Write-Host "Downloading the opening book..."
        foreach ($f in "a", "b", "c", "d", "e") {
            Invoke-WebRequest -Uri "https://raw.githubusercontent.com/lichess-org/chess-openings/master/$f.tsv" -OutFile "$BookDir\$f.tsv"
        }
    }
}

# 4. Build
& "$Venv\Scripts\pyinstaller.exe" "$Packaging\chess-review.spec" --distpath $Dist --workpath $Work --noconfirm
$App = Join-Path $Dist "chess-review"

# 5. Stamp (version + runtime fingerprint) and zip: packaging\pack.py, which also defines the update zip's layout
if (-not $Version) {
    try { $Version = (git -C $Root describe --tags --always 2>$null) } catch { }
    if (-not $Version) { $Version = "dev" }
}
& $Py "$Packaging\pack.py" $App --version $Version --out "$Packaging\dist"
$Zip = Join-Path $Packaging "dist\chess-review-windows.zip"

Write-Host ""
Write-Host "App folder: $App\chess-review.exe"
Write-Host "Share this: $Zip (new users); the chess-review-update-*.zip next to it is what the in-app updater takes"
