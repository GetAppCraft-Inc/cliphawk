$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot 'manifest.json') | ConvertFrom-Json
$files = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'package-files.json') | ConvertFrom-Json
$outputDir = Join-Path $projectRoot 'dist'
[IO.Directory]::CreateDirectory($outputDir) | Out-Null
$archiveName = "cliphawk-$($manifest.version).zip"
$archivePath = Join-Path $outputDir $archiveName
$stream = [IO.File]::Open($archivePath, [IO.FileMode]::Create)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in $files) {
        $source = [IO.Path]::GetFullPath((Join-Path $projectRoot $file))
        if (-not $source.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Package entry escapes project: $file"
        }
        $entry = $archive.CreateEntry($file, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [DateTimeOffset]::new(2020, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $entryStream = $entry.Open()
        try {
            $bytes = [IO.File]::ReadAllBytes($source)
            $entryStream.Write($bytes, 0, $bytes.Length)
        } finally { $entryStream.Dispose() }
    }
} finally { $archive.Dispose(); $stream.Dispose() }

# Verify every packaged byte and the root manifest before publishing an artifact.
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    if ($archive.Entries.Count -ne $files.Count) { throw 'Incorrect ZIP entry count' }
    if ($null -eq $archive.GetEntry('manifest.json')) { throw 'ZIP must have manifest.json at its root' }
    foreach ($file in $files) {
        $entry = $archive.GetEntry($file)
        if ($null -eq $entry) { throw "ZIP entry missing: $file" }
        $entryStream = $entry.Open()
        $memory = [IO.MemoryStream]::new()
        try {
            $entryStream.CopyTo($memory)
            $actual = [Convert]::ToBase64String($memory.ToArray())
            $expected = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $projectRoot $file)))
            if ($actual -ne $expected) { throw "ZIP entry differs from source: $file" }
        } finally { $entryStream.Dispose(); $memory.Dispose() }
    }
} finally { $archive.Dispose() }
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $outputDir "$archiveName.sha256"), "$hash  $archiveName`n", [Text.UTF8Encoding]::new($false))
Write-Host "Built and verified $archivePath"
