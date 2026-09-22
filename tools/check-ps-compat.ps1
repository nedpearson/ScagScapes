# PowerShell 5.1 compatibility gate.
#
# This exists because a script whose own header promised "runs the same on 5.1 and on PowerShell 7" shipped with
# a `??` in it and died on line 109 in the operator's hands. `pwsh` cannot catch that - it happily parses PS7
# syntax. So this parses for real errors AND greps for the constructs 7 accepts and 5.1 rejects.
#
# Comments and here-strings are stripped before the grep, because half the "hits" otherwise are the comments
# explaining why the construct was avoided.
#
#   pwsh -NoProfile -File tools/check-ps-compat.ps1
param([string[]]$Path = @("supabase/*.ps1","tools/*.ps1"))

$files = $Path | ForEach-Object { Get-ChildItem -Path $_ -ErrorAction SilentlyContinue } | Select-Object -ExpandProperty FullName -Unique
if (-not $files) { Write-Host "no .ps1 files matched"; exit 0 }

$bad = 0
# PS7-only constructs. Key = human name, value = regex.
$ps7 = [ordered]@{
  'null-coalescing ?? / ??='      = '\?\?=?'
  'null-conditional ?. or ?['     = '\?[\.\[]'
  'pipeline chain && or ||'       = '(\|\||&&)'
  'ForEach-Object -Parallel'      = '-Parallel\b'
  '-SkipHttpErrorCheck'           = '-SkipHttpErrorCheck\b'
  'ConvertFrom-Json -AsHashtable' = '-AsHashtable\b'
  'Get-Error cmdlet'              = '\bGet-Error\b'
  '$PSStyle'                      = '\$PSStyle\b'
}

foreach ($f in $files) {
  $rel = Resolve-Path -Relative $f
  $errs = $null; $toks = $null
  [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$toks, [ref]$errs) | Out-Null
  if ($errs -and $errs.Count) {
    $bad++
    Write-Host "PARSE ERROR  $rel" -ForegroundColor Red
    $errs | ForEach-Object { Write-Host ("   line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message) -ForegroundColor Red }
    continue
  }

  # Rebuild the source from tokens, dropping comments and strings - what is left is actual code.
  $code = ($toks | Where-Object { $_.Kind -ne 'Comment' -and $_.Kind -ne 'StringLiteral' -and $_.Kind -ne 'StringExpandable' } |
           ForEach-Object { $_.Text }) -join ' '

  $hits = @()
  foreach ($k in $ps7.Keys) {
    $m = [regex]::Matches($code, $ps7[$k])
    if ($m.Count) { $hits += ("{0} x{1}" -f $k, $m.Count) }
  }
  # ternary needs the AST, not a regex - a regex cannot tell it from a hashtable or a switch
  $ternary = $toks | Where-Object { $_.Kind -eq 'QuestionMark' }
  if ($ternary) { $hits += ("ternary ? : x{0}" -f $ternary.Count) }
  # $args is automatic; assigning it at script scope then splatting it back is a trap
  if ($code -match '\$args\s*=') { $hits += 'assigns to automatic variable $args' }

  if ($hits.Count) {
    $bad++
    Write-Host "NOT 5.1-SAFE $rel" -ForegroundColor Yellow
    $hits | ForEach-Object { Write-Host "   $_" -ForegroundColor Yellow }
  } else {
    Write-Host "ok           $rel" -ForegroundColor Green
  }
}

Write-Host ""
if ($bad) { Write-Host "$bad file(s) need attention" -ForegroundColor Red; exit 1 }
Write-Host "All scripts parse and use no PowerShell 7-only syntax." -ForegroundColor Green
