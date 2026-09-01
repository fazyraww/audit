$indexContent = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "..\index.html"), [System.Text.Encoding]::UTF8)
$marker = "const XBET = ["
$pos = $indexContent.IndexOf($marker)
if ($pos -ge 0) {
    $endPos = $indexContent.IndexOf("];", $pos)
    $rawXbet = $indexContent.Substring($pos, $endPos - $pos + 2)
    $jsContent = "window.XBET_DATA = " + $rawXbet.Substring(13) + ";"
    [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "..\assets\js\xbet_data.js"), $jsContent, [System.Text.Encoding]::UTF8)
    Write-Host "Created xbet_data.js successfully! Length: " $jsContent.Length
}
