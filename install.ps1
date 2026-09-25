# GhostChat – Installation fuer andere (Remote)

$repo = "foxlana089-png/ghostchat"
$zip  = "https://github.com/$repo/releases/latest/download/ghostchat.zip"
$dest = Join-Path $env:LOCALAPPDATA "GhostChat"

Write-Host ""
Write-Host "  GhostChat wird installiert ..." -ForegroundColor Green
Write-Host ""

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "  [!] Python fehlt - bitte installieren:" -ForegroundColor Red
    Write-Host "      https://www.python.org/downloads/"
    exit 1
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
$tmp = Join-Path $env:TEMP ("ghostchat-" + [guid]::NewGuid().ToString() + ".zip")

try {
    Invoke-WebRequest -Uri $zip -OutFile $tmp -UseBasicParsing
    Expand-Archive -Path $tmp -DestinationPath $dest -Force
} catch {
    Write-Host "  [!] Download fehlgeschlagen: $_" -ForegroundColor Red
    exit 1
} finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
}

Push-Location $dest
python -m pip install --disable-pip-version-check -q -r requirements.txt
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [!] pip fehlgeschlagen" -ForegroundColor Red
    Pop-Location
    exit 1
}

# Desktop-Verknuepfung
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $desktop "GhostChat.lnk"))
$lnk.TargetPath = (Join-Path $dest "start.bat")
$lnk.WorkingDirectory = $dest
$lnk.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,27"
$lnk.Save()
Pop-Location

Write-Host ""
Write-Host "  Installation abgeschlossen." -ForegroundColor Green
Write-Host "  Doppelklick auf 'GhostChat' (Desktop) und dann oeffnen:"
Write-Host "     http://127.0.0.1:8080" -ForegroundColor Yellow
Write-Host ""
