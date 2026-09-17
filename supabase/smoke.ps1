$b='https://cscowglyrgxqxwcnftzt.supabase.co/functions/v1/ss-api'
Write-Output '--- models ---'; (Invoke-WebRequest -UseBasicParsing "$b/ai/models").Content.Substring(0,240)
Write-Output "`n--- recommend (no key: honest fallback) ---"
$body = '{"task":"job_risk","ref":{}}'
(Invoke-WebRequest -UseBasicParsing -Method POST -ContentType 'application/json' -Body $body "$b/ai/recommend").Content.Substring(0,300)
Write-Output "`n--- export ---"; $e=(Invoke-WebRequest -UseBasicParsing "$b/export").Content; Write-Output ("$($e.Length) bytes; tables: " + (($e | ConvertFrom-Json).tables.PSObject.Properties.Name -join ','))
Write-Output "`n--- health ---"; (Invoke-WebRequest -UseBasicParsing "$b/health").Content.Substring(0,40)
