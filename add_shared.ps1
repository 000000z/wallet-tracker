$files = @('index.html', 'discover.html', 'overlap.html', 'token-scanner.html')

foreach ($f in $files) {
    $path = Join-Path $PSScriptRoot $f
    if (-not (Test-Path $path)) { Write-Host "Skip $f - not found"; continue }
    
    $html = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    
    # Add shared.css before </head> if not already there
    if ($html -notmatch 'shared\.css') {
        $html = $html -replace '</head>', '<link rel="stylesheet" href="shared.css">\n</head>'
    }
    
    # Add shared.js before </body> if not already there
    if ($html -notmatch 'shared\.js') {
        $html = $html -replace '</body>', '<script src="shared.js"></script>\n</body>'
    }
    
    [System.IO.File]::WriteAllText($path, $html, [System.Text.Encoding]::UTF8)
    Write-Host "Updated $f"
}
