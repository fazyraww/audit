param([int]$Port = 8080)
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "Server running at http://127.0.0.1:$Port/"

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    
    $localPath = $request.Url.LocalPath.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($localPath)) { $localPath = "index.html" }
    $localPath = [System.Uri]::UnescapeDataString($localPath).Replace('/', '\')
    $filePath = [System.IO.Path]::Combine($root, $localPath)
    
    if ($request.HttpMethod -eq "POST" -and $localPath -eq "save_mutasi.json") {
        $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
        $body = $reader.ReadToEnd()
        $reader.Close()
        [System.IO.File]::WriteAllText([System.IO.Path]::Combine($root, "mutasi_bca_data.json"), $body, [System.Text.Encoding]::UTF8)
        $buffer = [System.Text.Encoding]::UTF8.GetBytes('{"status":"ok"}')
        $response.ContentType = "application/json"
        $response.ContentLength64 = $buffer.Length
        $response.OutputStream.Write($buffer, 0, $buffer.Length)
        $response.Close()
        Write-Host "Saved mutasi_bca_data.json successfully!"
        continue
    }

    if ([System.IO.File]::Exists($filePath)) {
        $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
        $contentType = switch ($ext) {
            ".html" { "text/html; charset=utf-8" }
            ".js"   { "application/javascript; charset=utf-8" }
            ".css"  { "text/css; charset=utf-8" }
            ".json" { "application/json; charset=utf-8" }
            ".png"  { "image/png" }
            ".pdf"  { "application/pdf" }
            ".txt"  { "text/plain; charset=utf-8" }
            default { "application/octet-stream" }
        }
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $response.ContentType = $contentType
        $response.ContentLength64 = $bytes.Length
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $response.StatusCode = 404
        $buffer = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $localPath")
        $response.ContentLength64 = $buffer.Length
        $response.OutputStream.Write($buffer, 0, $buffer.Length)
    }
    $response.Close()
}
