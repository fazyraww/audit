$indexContent = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "..\index.html"), [System.Text.Encoding]::UTF8)

# Find XBET
$marker = "const XBET = ["
$pos = $indexContent.IndexOf($marker)
if ($pos -ge 0) {
    $endPos = $indexContent.IndexOf("];", $pos)
    $rawXbet = $indexContent.Substring($pos + 13, $endPos - ($pos + 13) + 1)
    Write-Host "XBET JSON snippet found, length:" $rawXbet.Length
}

# Verify kuliah.txt
$kuliahLines = [System.IO.File]::ReadAllLines((Join-Path $PSScriptRoot "..\data\notes\kuliah.txt"), [System.Text.Encoding]::UTF8)
Write-Host "Kuliah lines:" $kuliahLines.Length

# Verify pinjol.txt
$pinjolLines = [System.IO.File]::ReadAllLines((Join-Path $PSScriptRoot "..\data\notes\pinjol.txt"), [System.Text.Encoding]::UTF8)
Write-Host "Pinjol lines:" $pinjolLines.Length

Write-Host "Verification complete."
