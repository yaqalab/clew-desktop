<#
.SYNOPSIS
  Builds yaqatw.dotm, the Word template that talks to Clew Desktop, from src\*.bas and
  customUI\customUI14.xml. Windows, with Word installed.

.DESCRIPTION
  A hidden Word of its own imports the VBA modules into a new document and saves it as a
  macro-enabled template; the ribbon is then added to the file (Word cannot add it itself).

  Importing VBA needs Word's "Trust access to the VBA project object model" (HKCU AccessVBOM).
  The script turns it on for the build only and puts back what was there, even when the build
  fails. Documents open in your own Word are not touched.

.PARAMETER Install
  Also copies the template to Word's Startup folder, where Word loads it at its next start.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File word-plugin\build.ps1 -Install
#>
param([switch]$Install)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
$out = Join-Path $dist 'yaqatw.dotm'
$work = Join-Path $dist 'work'

New-Item -ItemType Directory -Force $work | Out-Null
Remove-Item (Join-Path $work '*') -Force -ErrorAction SilentlyContinue

# VBA imports text in the system's ANSI code page with CRLF line ends: the sources are ASCII,
# and their line ends are made CRLF here whatever Git checked out.
foreach ($bas in Get-ChildItem (Join-Path $root 'src\*.bas')) {
  $text = [IO.File]::ReadAllText($bas.FullName)
  if ($text -match '[^\x00-\x7F]') { throw "$($bas.Name): only ASCII in VBA sources" }
  [IO.File]::WriteAllText((Join-Path $work $bas.Name), ($text -replace "`r?`n", "`r`n"), [Text.Encoding]::ASCII)
}

# --- VBA into a new template, through a hidden Word ---------------------------------------
# In a job with a time limit: a Word that hangs (it can, on a cold first start) is stopped, and
# AccessVBOM is put back either way.
$key = 'HKCU:\Software\Microsoft\Office\16.0\Word\Security'
$before = (Get-ItemProperty $key -Name AccessVBOM -ErrorAction SilentlyContinue).AccessVBOM
$wordsBefore = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object Id)
$plain = Join-Path $work 'yaqatw.dotm'
$job = $null
$done = $false
try {
  if (-not (Test-Path $key)) { New-Item $key -Force | Out-Null }
  Set-ItemProperty $key -Name AccessVBOM -Value 1 -Type DWord
  $job = Start-Job -ArgumentList $work, $plain -ScriptBlock {
    param($work, $plain)
    $ErrorActionPreference = 'Stop'
    $word = New-Object -ComObject Word.Application
    try {
      $word.Visible = $false
      $word.DisplayAlerts = 0
      $doc = $word.Documents.Add()
      # Its own project name: macros can be called as Yaqatw.Module.Macro, apart from any other
      # template's (all are "Project" otherwise).
      $doc.VBProject.Name = 'Yaqatw'
      foreach ($m in Get-ChildItem (Join-Path $work '*.bas')) { [void]$doc.VBProject.VBComponents.Import($m.FullName) }
      $doc.SaveAs2($plain, 15) # wdFormatXMLTemplateMacroEnabled
      $doc.Close(0)
    }
    finally {
      # Only a Word this build started is quit: one with documents open is someone's.
      if ($word.Documents.Count -eq 0) { $word.Quit() }
    }
  }
  if (-not (Wait-Job $job -Timeout 120)) { throw 'Word did not finish within two minutes' }
  Receive-Job $job -ErrorAction Stop
  $done = $true
}
finally {
  if ($job) { Remove-Job $job -Force }
  # Word writes its security settings back as it exits, so AccessVBOM is restored only once the
  # Word this build started is gone: given 30 s after a good build, stopped at once otherwise.
  $ours = { Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $wordsBefore -notcontains $_.Id -and -not $_.MainWindowTitle } }
  if ($done) {
    for ($i = 0; $i -lt 60 -and (& $ours); $i++) { Start-Sleep -Milliseconds 500 }
  }
  & $ours | Stop-Process -Force
  Start-Sleep -Milliseconds 500
  if ($null -eq $before) { Remove-ItemProperty $key -Name AccessVBOM -ErrorAction SilentlyContinue }
  else { Set-ItemProperty $key -Name AccessVBOM -Value $before -Type DWord }
}

# --- The ribbon: customUI/customUI14.xml and its relationship -----------------------------
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
Copy-Item $plain $out -Force
$zip = [IO.Compression.ZipFile]::Open($out, 'Update')
try {
  $entry = $zip.CreateEntry('customUI/customUI14.xml')
  $w = New-Object IO.StreamWriter($entry.Open(), (New-Object Text.UTF8Encoding($false)))
  $w.Write([IO.File]::ReadAllText((Join-Path $root 'customUI\customUI14.xml')))
  $w.Close()

  $rels = $zip.GetEntry('_rels/.rels')
  $r = New-Object IO.StreamReader($rels.Open())
  [xml]$xml = $r.ReadToEnd()
  $r.Close()
  $ns = 'http://schemas.openxmlformats.org/package/2006/relationships'
  $rel = $xml.CreateElement('Relationship', $ns)
  $rel.SetAttribute('Id', 'yaqatwRibbon')
  $rel.SetAttribute('Type', 'http://schemas.microsoft.com/office/2007/relationships/ui/extensibility')
  $rel.SetAttribute('Target', 'customUI/customUI14.xml')
  [void]$xml.DocumentElement.AppendChild($rel)
  $rels.Delete()
  $entry = $zip.CreateEntry('_rels/.rels')
  $w = New-Object IO.StreamWriter($entry.Open(), (New-Object Text.UTF8Encoding($false)))
  $xml.Save($w)
  $w.Close()
}
finally {
  $zip.Dispose()
}
Remove-Item $work -Recurse -Force
Write-Output "built $out"

if ($Install) {
  $startup = Join-Path $env:APPDATA 'Microsoft\Word\STARTUP'
  New-Item -ItemType Directory -Force $startup | Out-Null
  Copy-Item $out (Join-Path $startup 'yaqatw.dotm') -Force
  Write-Output "installed in $startup (Word loads it at its next start)"
}
