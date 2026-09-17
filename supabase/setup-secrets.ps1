# Scag Scapes Command - one-shot secret setup and first eval run.
#
# Claude wrote this script but deliberately did not run it: it handles an API key, and a key an assistant has
# read is a key that has been somewhere it did not need to go. Everything here happens on your machine, in your
# shell, with values that never leave it.
#
#   Run from the repo root:   powershell -ExecutionPolicy Bypass -File .\supabase\setup-secrets.ps1
#
# It will: mint SS_ADMIN_KEY, prompt for one provider key, set both as Supabase secrets, redeploy the function,
# and run the eval suite so you can see the model's score next to the regex baseline of 0.75.

$ErrorActionPreference = "Stop"
$REF  = "cscowglyrgxqxwcnftzt"
$BASE = "https://$REF.supabase.co/functions/v1/ss-api"

# Windows PowerShell 5.1 defaults to TLS 1.0 and has no -SkipHttpErrorCheck; both are handled below so this
# script runs the same on 5.1 and on PowerShell 7.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Get-Status([string]$Url, [hashtable]$Headers) {
  try { (Invoke-WebRequest -Uri $Url -Headers $Headers -UseBasicParsing -Method Get).StatusCode }
  catch {
    if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { "request failed: $($_.Exception.Message)" }
  }
}

Write-Host ""
Write-Host "Scag Scapes Command - secret setup" -ForegroundColor Cyan
Write-Host "-----------------------------------"

# --- 1. SS_ADMIN_KEY: gates /export, POST /ai/models and POST /ai/evals/run on every tenant --------------------
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$ADMIN = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""

Write-Host ""
Write-Host "Your SS_ADMIN_KEY (copy this into your password manager now - it is shown once):" -ForegroundColor Yellow
Write-Host "  $ADMIN"
Write-Host ""
Read-Host "Saved it? Press Enter to continue" | Out-Null

# --- 2. the provider key ---------------------------------------------------------------------------------------
Write-Host ""
Write-Host "Which provider key are you setting?" -ForegroundColor Cyan
Write-Host "  1) Anthropic   (console.anthropic.com -> API keys)"
Write-Host "  2) OpenAI      (platform.openai.com/api-keys)"
Write-Host "  3) Gemini      (aistudio.google.com/apikey)"
Write-Host "  4) Skip - only set SS_ADMIN_KEY for now"
$choice = Read-Host "Choice [1-4]"
$providerVar = switch ($choice) { "1" { "ANTHROPIC_API_KEY" } "2" { "OPENAI_API_KEY" } "3" { "GEMINI_API_KEY" } default { $null } }

$providerVal = $null
if ($providerVar) {
  $secure = Read-Host "Paste your $providerVar (input hidden)" -AsSecureString
  $providerVal = [System.Net.NetworkCredential]::new("", $secure).Password
  if (-not $providerVal) { Write-Host "Nothing pasted - skipping the provider key." -ForegroundColor Yellow; $providerVar = $null }
}

# --- 3. set them ------------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "Setting secrets..." -ForegroundColor Cyan
supabase secrets set "SS_ADMIN_KEY=$ADMIN" --project-ref $REF
if ($providerVar) { supabase secrets set "$providerVar=$providerVal" --project-ref $REF }
$providerVal = $null    # out of memory as soon as it is no longer needed

# --- 4. redeploy so the running function picks the new env up ---------------------------------------------------
Write-Host ""
Write-Host "Redeploying ss-api..." -ForegroundColor Cyan
supabase functions deploy ss-api --no-verify-jwt --project-ref $REF

# --- 5. prove the gate works ------------------------------------------------------------------------------------
Write-Host ""
Write-Host "Checking the gate..." -ForegroundColor Cyan
$noKey   = Get-Status "$BASE/export" @{}
$withKey = Get-Status "$BASE/export" @{ "x-ss-key" = $ADMIN }
Write-Host ("  /export without the key : {0}  (expect 401)" -f $noKey)
Write-Host ("  /export with the key    : {0}  (expect 200)" -f $withKey)

# --- 6. first real eval run --------------------------------------------------------------------------------------
if ($providerVar) {
  Write-Host ""
  Write-Host "Running the eval suite. Every enabled model is scored on the same seven fixtures as the" -ForegroundColor Cyan
  Write-Host "deterministic baseline. The baseline scores 0.75 on reply-01 - that is the number to beat." -ForegroundColor Cyan
  $r = Invoke-RestMethod -Method Post -Uri "$BASE/ai/evals/run" -Headers @{ "x-ss-key" = $ADMIN; "content-type" = "application/json" } -Body "{}"
  Write-Host ""
  Write-Host "Summary (mean score across fixtures):" -ForegroundColor Yellow
  $r.summary.PSObject.Properties | ForEach-Object { "  {0,-34} {1}" -f $_.Name, $_.Value.mean_score } | Write-Host
  Write-Host ""
  Write-Host "reply-01 head to head - this is the one that decides whether SMS gets routed through a model:" -ForegroundColor Yellow
  $r.results | Where-Object { $_.fixture_id -eq "reply-01" } | ForEach-Object { "  {0,-34} {1}" -f ($_.provider + "/" + $_.model_id), $_.score } | Write-Host
  Write-Host ""
  Write-Host "If a model beats 0.75 there, turning on shadow mode is the next step (see below)." -ForegroundColor Gray
  Write-Host "Full history any time:  Invoke-RestMethod $BASE/ai/evals" -ForegroundColor Gray
} else {
  Write-Host ""
  Write-Host "No provider key set, so there is nothing to evaluate yet. Re-run this script when you have one." -ForegroundColor Gray
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Shadow mode (model drafts, the regex reply still sends, drafts logged for accept/reject):" -ForegroundColor Gray
Write-Host '  update ss_tenants set settings = settings || ''{"ai_sms":"shadow"}''::jsonb where id = ''demo'';' -ForegroundColor Gray
Write-Host ""
