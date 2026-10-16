<#
 TaxNest Tally Connector  (Windows PowerShell 5.1+, nothing to install)

 A tiny program that runs on THIS computer and lets the TaxNest Bank Import web page talk to Tally:
   web page  <->  this connector (http://127.0.0.1:9911)  <->  Tally (http://127.0.0.1:9000)
 It only listens on your own computer. Bank statement data is never sent anywhere else.
 The first time a website asks to use it, you are asked to Allow or Block that website.

 STATUS: written to mirror the tested Node connector (tally-helper/server.js). It has NOT been run on a real
 Windows machine by its author yet. If anything misbehaves, tell the developer what the black window prints.
#>
param(
  [int]$Port = 9911,
  [string]$TallyHost = '127.0.0.1',
  [int]$TallyPort = 9000
)
$ErrorActionPreference = 'Stop'
[System.Net.ServicePointManager]::Expect100Continue = $false     # Tally does not like "Expect: 100-continue"
Add-Type -AssemblyName System.Web
Add-Type -AssemblyName System.Windows.Forms

$ConfigDir = Join-Path $env:APPDATA 'TaxNestConnector'
$AllowFile = Join-Path $ConfigDir 'allowed-origins.txt'
if (-not (Test-Path $ConfigDir)) { New-Item -ItemType Directory -Path $ConfigDir | Out-Null }
if (-not (Test-Path $AllowFile)) { New-Item -ItemType File -Path $AllowFile | Out-Null }
$Denied = New-Object System.Collections.Generic.HashSet[string]

function Esc([string]$s)   { [System.Security.SecurityElement]::Escape($s) }
function Unesc([string]$s) { [System.Net.WebUtility]::HtmlDecode($s) }

# ---------- talking to Tally ----------
function Call-Tally([string]$xml) {
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('Content-Type', 'text/xml; charset=utf-8')
  $bytes = $wc.UploadData("http://${TallyHost}:${TallyPort}", 'POST', [System.Text.Encoding]::UTF8.GetBytes($xml))
  if ($bytes.Length -gt 1 -and $bytes[1] -eq 0) { return [System.Text.Encoding]::Unicode.GetString($bytes).TrimStart([char]0xFEFF) }   # UTF-16LE reply
  return [System.Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF)
}
function Collection-Request([string]$name, [string]$type, [string]$fetch, [string]$company) {
  $co = ''; if ($company) { $co = '<SVCURRENTCOMPANY>' + (Esc $company) + '</SVCURRENTCOMPANY>' }
  return '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>' + $name + '</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' + $co +
    '</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="' + $name + '" ISMODIFY="No"><TYPE>' + $type + '</TYPE><FETCH>' + $fetch + '</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
}
function Parse-Named([string]$xml, [string]$tag) {   # -> list of @{name; parent}
  $out = New-Object System.Collections.ArrayList; $seen = @{}
  $re = [regex]::new("<$tag\b([^>]*)>([\s\S]*?)</$tag>", 'IgnoreCase')
  foreach ($m in $re.Matches($xml)) {
    $name = ''
    $a = [regex]::Match($m.Groups[1].Value, 'NAME\s*=\s*"([^"]*)"')
    if ($a.Success) { $name = $a.Groups[1].Value } else { $n = [regex]::Match($m.Groups[2].Value, '<NAME>([^<]*)</NAME>'); if ($n.Success) { $name = $n.Groups[1].Value } }
    $name = (Unesc $name).Trim()
    $parent = ''; $p = [regex]::Match($m.Groups[2].Value, '<PARENT>([^<]*)</PARENT>'); if ($p.Success) { $parent = (Unesc $p.Groups[1].Value).Trim() }
    if ($name -and -not $seen.ContainsKey($name)) { $seen[$name] = 1; [void]$out.Add([pscustomobject]@{ name = $name; parent = $parent }) }
  }
  return ,$out
}
function Parse-ImportReply([string]$xml) {
  function N([string]$t) { $m = [regex]::Match($xml, "<$t>\s*(\d+)\s*</$t>"); if ($m.Success) { [int]$m.Groups[1].Value } else { 0 } }
  $lineErrors = @(); foreach ($m in [regex]::Matches($xml, '<LINEERROR>([\s\S]*?)</LINEERROR>')) { $lineErrors += (Unesc $m.Groups[1].Value).Trim() }
  $recognised = $xml -match '<RESPONSE>'
  $r = [ordered]@{ created = (N 'CREATED'); altered = (N 'ALTERED'); ignored = (N 'IGNORED'); cancelled = (N 'CANCELLED'); errors = (N 'ERRORS'); exceptions = (N 'EXCEPTIONS'); line_errors = $lineErrors; recognised = $recognised }
  $r['ok'] = ($recognised -and $r.errors -eq 0 -and $r.exceptions -eq 0 -and $lineErrors.Count -eq 0)
  return $r
}

# ---------- who may use the connector ----------
function Origin-Allowed([string]$origin) {
  if ([string]::IsNullOrEmpty($origin)) { return $true }            # address-bar / non-browser use
  if ($origin -eq 'null') { return $true }                           # a page opened straight from a file
  if ($origin -match '^https?://(localhost|127\.0\.0\.1)(:\d+)?$') { return $true }
  if ((Get-Content $AllowFile -ErrorAction SilentlyContinue) -contains $origin) { return $true }
  if ($Denied.Contains($origin)) { return $false }
  $owner = New-Object System.Windows.Forms.Form; $owner.TopMost = $true
  $ans = [System.Windows.Forms.MessageBox]::Show($owner, "The website`n`n    $origin`n`nwants to read your Tally ledgers and import entries through this connector.`n`nAllow it?", 'TaxNest Tally Connector', 'YesNo', 'Question')
  $owner.Dispose()
  if ($ans -eq 'Yes') { Add-Content -Path $AllowFile -Value $origin; Write-Host "Allowed: $origin"; return $true }
  [void]$Denied.Add($origin); Write-Host "Blocked: $origin"; return $false
}

# ---------- HTTP plumbing ----------
function Send-Json($ctx, [int]$code, $obj, [string]$origin) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $res = $ctx.Response; $res.StatusCode = $code; $res.ContentType = 'application/json; charset=utf-8'
  $res.Headers.Add('Access-Control-Allow-Origin', $(if ($origin) { $origin } else { '*' })); $res.Headers.Add('Vary', 'Origin')
  $res.ContentLength64 = $bytes.Length; $res.OutputStream.Write($bytes, 0, $bytes.Length); $res.OutputStream.Close()
}
function Read-Body($ctx) { $sr = New-Object System.IO.StreamReader($ctx.Request.InputStream, [System.Text.Encoding]::UTF8); $t = $sr.ReadToEnd(); $sr.Close(); return $t }
function Query-Param($ctx, [string]$name) { $v = [System.Web.HttpUtility]::ParseQueryString($ctx.Request.Url.Query)[$name]; if ($v) { return $v } else { return '' } }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch {
  Write-Host "Could not start on port $Port. Is another copy of the connector already running? ($($_.Exception.Message))" -ForegroundColor Red
  exit 1
}
Write-Host ''
Write-Host '  TaxNest Tally Connector is running.' -ForegroundColor Green
Write-Host "  Listening on http://127.0.0.1:$Port   |   Tally expected at ${TallyHost}:${TallyPort}"
Write-Host '  Keep this window open while you use the TaxNest Bank Import tool. Close it to stop.'
Write-Host ''

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request; $origin = $req.Headers['Origin']
  try {
    if (-not (Origin-Allowed $origin)) { Send-Json $ctx 403 @{ error = "Website not allowed: $origin" } $origin; continue }
    $path = $req.Url.AbsolutePath
    if ($req.HttpMethod -eq 'OPTIONS') {                             # CORS + Chrome "private network" preflight
      $res = $ctx.Response; $res.StatusCode = 204
      $res.Headers.Add('Access-Control-Allow-Origin', $(if ($origin) { $origin } else { '*' })); $res.Headers.Add('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      $res.Headers.Add('Access-Control-Allow-Headers', 'Content-Type'); $res.Headers.Add('Access-Control-Allow-Private-Network', 'true'); $res.Headers.Add('Vary', 'Origin')
      $res.OutputStream.Close(); continue
    }
    if ($req.HttpMethod -eq 'GET' -and $path -eq '/status') {
      try {
        $companies = @(); foreach ($c in (Parse-Named (Call-Tally (Collection-Request 'TaxNestCompanies' 'Company' 'Name' '')) 'COMPANY')) { $companies += $c.name }
        Send-Json $ctx 200 @{ helper = $true; connector = 'windows'; version = '0.1.0'; tally = @{ reachable = $true; host = $TallyHost; port = $TallyPort; companies = $companies } } $origin
      } catch {
        Send-Json $ctx 200 @{ helper = $true; connector = 'windows'; version = '0.1.0'; tally = @{ reachable = $false; host = $TallyHost; port = $TallyPort; error = $_.Exception.Message } } $origin
      }
      continue
    }
    if ($req.HttpMethod -eq 'GET' -and $path -eq '/ledgers') {
      $company = Query-Param $ctx 'company'
      $items = Parse-Named (Call-Tally (Collection-Request 'TaxNestLedgers' 'Ledger' 'Name,Parent' $company)) 'LEDGER'
      $obj = @{ company = $(if ($company) { $company } else { $null }); count = $items.Count; ledgers = @($items) }
      if ($items.Count -eq 0) { $obj['warning'] = 'Tally answered but no ledgers could be read. Is a company open in Tally?' }
      Send-Json $ctx 200 $obj $origin; Write-Host ("Sent {0} ledgers to {1}" -f $items.Count, $origin); continue
    }
    if ($req.HttpMethod -eq 'POST' -and $path -eq '/import') {
      $body = Read-Body $ctx
      if (($body -notmatch '<ENVELOPE>') -or ($body -notmatch 'Import Data')) { Send-Json $ctx 400 @{ error = 'Body must be a Tally import envelope.' } $origin; continue }
      $company = Query-Param $ctx 'company'
      if ($company) { $body = $body.Replace('<SVCURRENTCOMPANY/>', '<SVCURRENTCOMPANY>' + (Esc $company) + '</SVCURRENTCOMPANY>') }
      $result = Parse-ImportReply (Call-Tally $body)
      Send-Json $ctx $(if ($result.ok) { 200 } else { 422 }) $result $origin
      Write-Host ("Import: created={0} altered={1} errors={2}" -f $result.created, $result.altered, $result.errors); continue
    }
    Send-Json $ctx 404 @{ error = 'Not found' } $origin
  } catch {
    try { Send-Json $ctx 502 @{ error = "Could not talk to Tally at ${TallyHost}:${TallyPort} ($($_.Exception.Message))" } $origin } catch { }
    Write-Host ("Error: " + $_.Exception.Message) -ForegroundColor Yellow
  }
}
