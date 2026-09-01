$pdfDir = Join-Path $PSScriptRoot "..\data\pdf_mutasi"
$files = Get-ChildItem -Path $pdfDir -Filter "*.pdf"
$outPath = Join-Path $PSScriptRoot "..\assets\js\pdf_bundle.js"
$writer = [System.IO.StreamWriter]::new($outPath, $false, [System.Text.Encoding]::UTF8)

$writer.WriteLine("window.PDF_BASE64_FILES = {")

for ($i = 0; $i -lt $files.Count; $i++) {
    $f = $files[$i]
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    $b64 = [Convert]::ToBase64String($bytes)
    $comma = if ($i -lt ($files.Count - 1)) { "," } else { "" }
    $escapedName = $f.Name.Replace('"', '\"')
    $writer.WriteLine("  `"$escapedName`": `"$b64`"$comma")
}

$writer.WriteLine("};")
$writer.Flush()
$writer.Close()

Write-Host "Created pdf_bundle.js successfully with" $files.Count "files!"
