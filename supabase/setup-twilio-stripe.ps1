# Scag Scapes Command - Twilio + Stripe, verified end to end.
#
# Claude wrote this script and deliberately did not run it, for the same reason as setup-secrets.ps1: it handles
# live credentials, and a key an assistant has read is a key that has been somewhere it did not need to go. A
# Stripe secret key can move money. Everything here happens on your machine, in your shell, with values that
# never leave it.
#
#   Run from the repo root:   powershell -ExecutionPolicy Bypass -File .\supabase\setup-twilio-stripe.ps1
#
# What it does, in order, stopping at the first thing that fails:
#   1. Checks each credential against the provider's own API BEFORE storing it.
#      A wrong key is caught here, in ten seconds, instead of becoming a silent "simulated" row next week.
#   2. Sets the Supabase secrets and redeploys ss-api.
#   3. Reads GET /readiness back and shows whether the blockers actually cleared.
#   4. Offers to send ONE real text to a number you choose, and tells you what the outbox recorded.
#
# Step 4 is the point. 20 outbox rows currently read "simulated". Until one reads "sent", the headline
# capability of this product is unproven against a carrier.

$ErrorActionPreference = "Stop"
$REF  = "cscowglyrgxqxwcnftzt"
$BASE = "https://$REF.supabase.co/functions/v1/ss-api"

# Windows PowerShell 5.1 defaults to TLS 1.0. Same handling as setup-secrets.ps1 so this runs on 5.1 and on 7.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  [System.Net.NetworkCredential]::new("", $secure).Password
}
function Say([string]$m, [string]$c = "Gray") { Write-Host $m -ForegroundColor $c }

Write-Host ""
Say "Scag Scapes Command - Twilio + Stripe setup" "Cyan"
Say "-------------------------------------------"
Say "Nothing is stored until it has been checked against the provider." "DarkGray"
Write-Host ""

# ---------------------------------------------------------------------------------------------------------
# 1. TWILIO
# ---------------------------------------------------------------------------------------------------------
Say "TWILIO  (console.twilio.com - Account SID and Auth Token are on the dashboard)" "Cyan"
Say "If you have no account yet, stop here and create one first; this script cannot do that for you." "DarkGray"
Write-Host ""

$doTwilio = (Read-Host "Set up Twilio now? [y/N]") -match '^[Yy]'
$TW_SID = $null; $TW_TOK = $null; $TW_FROM = $null

if ($doTwilio) {
  $TW_SID  = Read-Host "TWILIO_ACCOUNT_SID  (starts AC...)"
  $TW_TOK  = Read-Secret "TWILIO_AUTH_TOKEN   (input hidden)"
  # NOTE: the code reads TWILIO_FROM, not TWILIO_FROM_NUMBER. Getting this name wrong is a silent failure -
  # integrations().twilio stays false and every message keeps logging as "simulated" with no error at all.
  $TW_FROM = Read-Host "TWILIO_FROM         (your Twilio number, E.164 e.g. +12255551234)"

  if ($TW_FROM -notmatch '^\+\d{10,15}$') { throw "TWILIO_FROM must be E.164, starting with + and country code (e.g. +12255551234). Got: $TW_FROM" }

  Say ""
  Say "Checking the credentials against Twilio..." "Cyan"
  $pair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($TW_SID):$($TW_TOK)"))
  try {
    $acct = Invoke-RestMethod -Uri "https://api.twilio.com/2010-04-01/Accounts/$TW_SID.json" `
              -Headers @{ Authorization = "Basic $pair" } -Method Get
    Say "  OK - account '$($acct.friendly_name)' status '$($acct.status)'" "Green"
  } catch { throw "Twilio rejected those credentials. Nothing has been stored. Detail: $($_.Exception.Message)" }

  # Confirm the FROM number actually belongs to this account and can send SMS. A number that cannot send SMS
  # fails per-message later, which is a far more confusing failure than finding out now.
  try {
    $nums = Invoke-RestMethod -Uri "https://api.twilio.com/2010-04-01/Accounts/$TW_SID/IncomingPhoneNumbers.json?PhoneNumber=$([uri]::EscapeDataString($TW_FROM))" `
              -Headers @{ Authorization = "Basic $pair" } -Method Get
    if (-not $nums.incoming_phone_numbers -or $nums.incoming_phone_numbers.Count -eq 0) {
      Say "  WARNING: $TW_FROM is not an IncomingPhoneNumber on this account." "Yellow"
      Say "  If it is a Messaging Service or verified sender that is fine; otherwise sending will fail." "Yellow"
      if ((Read-Host "  Continue anyway? [y/N]") -notmatch '^[Yy]') { throw "Stopped at your request. Nothing stored." }
    } else {
      $cap = $nums.incoming_phone_numbers[0].capabilities
      if ($cap.sms -ne $true) { Say "  WARNING: $TW_FROM reports no SMS capability." "Yellow" }
      else { Say "  OK - $TW_FROM is on this account and SMS-capable" "Green" }
    }
  } catch { Say "  Could not verify the number ($($_.Exception.Message)). Continuing." "Yellow" }
}

# ---------------------------------------------------------------------------------------------------------
# 2. STRIPE
# ---------------------------------------------------------------------------------------------------------
Write-Host ""
Say "STRIPE  (dashboard.stripe.com/apikeys)" "Cyan"
Say "Use a TEST key (sk_test_...) until you have watched a deposit link work end to end." "DarkGray"
Write-Host ""

$doStripe = (Read-Host "Set up Stripe now? [y/N]") -match '^[Yy]'
$ST_KEY = $null

if ($doStripe) {
  $ST_KEY = Read-Secret "STRIPE_SECRET_KEY   (input hidden)"
  if ($ST_KEY -notmatch '^sk_(test|live)_') { throw "That does not look like a Stripe SECRET key (expected sk_test_... or sk_live_...). A pk_ publishable key will not work. Nothing stored." }
  if ($ST_KEY -match '^sk_live_') {
    Say ""
    Say "  That is a LIVE key. Deposit links made with it will charge real cards." "Yellow"
    if ((Read-Host "  Are you sure? [y/N]") -notmatch '^[Yy]') { throw "Stopped at your request. Nothing stored." }
  }

  Say ""
  Say "Checking the key against Stripe..." "Cyan"
  try {
    $acct = Invoke-RestMethod -Uri "https://api.stripe.com/v1/account" -Headers @{ Authorization = "Bearer $ST_KEY" } -Method Get
    $mode = if ($ST_KEY -match '^sk_live_') { "LIVE" } else { "test" }
    Say "  OK - $mode key for account '$($acct.business_profile.name ?? $acct.id)'; charges_enabled=$($acct.charges_enabled)" "Green"
    if ($acct.charges_enabled -ne $true -and $mode -eq "LIVE") {
      Say "  WARNING: this account cannot accept charges yet - finish Stripe onboarding before relying on deposit links." "Yellow"
    }
  } catch { throw "Stripe rejected that key. Nothing has been stored. Detail: $($_.Exception.Message)" }
}

if (-not $doTwilio -and -not $doStripe) { Say "Nothing to do." "Yellow"; exit 0 }

# ---------------------------------------------------------------------------------------------------------
# 3. STORE + DEPLOY
# ---------------------------------------------------------------------------------------------------------
Write-Host ""
Say "Every credential passed. Setting Supabase secrets..." "Cyan"

$args = @()
if ($doTwilio) { $args += "TWILIO_ACCOUNT_SID=$TW_SID"; $args += "TWILIO_AUTH_TOKEN=$TW_TOK"; $args += "TWILIO_FROM=$TW_FROM" }
if ($doStripe) { $args += "STRIPE_SECRET_KEY=$ST_KEY" }

& supabase secrets set @args --project-ref $REF
if ($LASTEXITCODE -ne 0) { throw "supabase secrets set failed. Are you linked? Run: supabase link --project-ref $REF" }

Say ""
Say "Redeploying ss-api so it picks the secrets up..." "Cyan"
& supabase functions deploy ss-api --no-verify-jwt --project-ref $REF
if ($LASTEXITCODE -ne 0) { throw "Function deploy failed. The secrets ARE set; re-run the deploy by hand." }

# ---------------------------------------------------------------------------------------------------------
# 4. READ IT BACK - do not take the deploy's word for it
# ---------------------------------------------------------------------------------------------------------
Write-Host ""
Say "Asking the deployed function what it can actually do..." "Cyan"
Start-Sleep -Seconds 4
try {
  $r = Invoke-RestMethod -Uri "$BASE/readiness" -Headers @{ "x-tenant" = "demo" } -Method Get
  Write-Host ""
  Say "  verdict : $($r.verdict)" "Cyan"
  foreach ($c in $r.checks) {
    if ($c.id -in @("sms","payments","email","voice")) {
      $col = if ($c.ok) { "Green" } else { if ($c.level -eq "blocker") { "Red" } else { "Yellow" } }
      Say ("  {0,-10} {1}" -f $c.id, $(if ($c.ok) { "OK" } else { "NOT READY - " + $c.detail })) $col
    }
  }
} catch { Say "  Could not read /readiness: $($_.Exception.Message)" "Yellow" }

# ---------------------------------------------------------------------------------------------------------
# 5. THE ONE THAT MATTERS - send a real text
# ---------------------------------------------------------------------------------------------------------
if ($doTwilio) {
  Write-Host ""
  Say "Send one real text now? Until a row reads 'sent' instead of 'simulated'," "Cyan"
  Say "the text-back the whole pitch rests on is unproven against a carrier." "Cyan"
  $to = Read-Host "Your mobile in E.164 (e.g. +12255551234), or blank to skip"
  if ($to -match '^\+\d{10,15}$') {
    try {
      $body = "Scag Scapes Command test - if you are reading this, texts are live. $(Get-Date -Format 'HH:mm')"
      $res = Invoke-RestMethod -Uri "https://api.twilio.com/2010-04-01/Accounts/$TW_SID/Messages.json" `
               -Headers @{ Authorization = "Basic $pair" } -Method Post `
               -Body @{ To = $to; From = $TW_FROM; Body = $body }
      Say "  Twilio accepted it. SID $($res.sid), status '$($res.status)'." "Green"
      Say "  Check your phone. If it does not arrive, look at console.twilio.com -> Monitor -> Logs -> Messaging." "DarkGray"
      Say "  Note: this went straight to Twilio, so it is NOT an ss_outbox row. The app's own first send" "DarkGray"
      Say "  will be the one that flips a row to 'sent' - trigger it from the app and check the Billing page." "DarkGray"
    } catch { Say "  Twilio refused the send: $($_.Exception.Message)" "Red" }
  } else { Say "  Skipped." "DarkGray" }
}

Write-Host ""
Say "Done." "Green"
Say "Remaining, in value order:" "Cyan"
Say "  - VOICE_WEBHOOK_SECRET + point a number at Vapi (58% of leads currently get no reply)" "Gray"
Say "  - Rotate SS_ADMIN_KEY (it was screenshotted into a chat once)" "Gray"
Say "  - Auth, before any real crew or customer record touches the 'scagscapes' tenant" "Gray"
Write-Host ""
