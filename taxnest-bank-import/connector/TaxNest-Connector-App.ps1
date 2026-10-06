<#
 TaxNest Tally Connector - desktop app (Windows PowerShell 5.1+, nothing to install)

 Double-click "TaxNest Connector.bat". A window opens showing whether Tally is connected and which company is open.
 The window can be minimised to the system tray; the connector keeps running until you choose Exit.

   TaxNest website  <->  this app (http://127.0.0.1:9911)  <->  Tally (http://127.0.0.1:9000)

 It only listens on your own computer. The first time a website asks to use it, you are asked to Allow or Block it.
 STATUS: the connection logic is the same as the proven console connector (TaxNest-Connector.ps1). The window itself is new
 and has not yet been run on every Windows version; if it fails to start, the classic connector is started instead.
 (This file is plain ASCII on purpose: Windows PowerShell 5.1 misreads UTF-8 without a BOM.)
#>
param([int]$Port = 9911, [string]$TallyHost = '127.0.0.1', [int]$TallyPort = 9000)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Start-Classic { try { Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'TaxNest-Connector.ps1')) } catch { } }

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Web
  [System.Windows.Forms.Application]::EnableVisualStyles()
  [System.Net.ServicePointManager]::Expect100Continue = $false

  # ---------- one copy only ----------
  $createdNew = $false
  $mutex = New-Object System.Threading.Mutex($true, 'TaxNestTallyConnector9911', [ref]$createdNew)
  if (-not $createdNew) { [void][System.Windows.Forms.MessageBox]::Show('TaxNest Connector is already running. Look for its icon near the clock (system tray).', 'TaxNest Connector'); exit 0 }

  $ConfigDir = Join-Path $env:APPDATA 'TaxNestConnector'
  $AllowFile = Join-Path $ConfigDir 'allowed-origins.txt'
  if (-not (Test-Path $ConfigDir)) { New-Item -ItemType Directory -Path $ConfigDir | Out-Null }
  if (-not (Test-Path $AllowFile)) { New-Item -ItemType File -Path $AllowFile | Out-Null }
  $script:Denied = New-Object System.Collections.Generic.HashSet[string]
  $script:tally = @{ reachable = $false; companies = @(); error = '' }
  $script:lastSite = ''
  $script:pulse = 0.0
  $script:quit = $false

  # ---------- Tally helpers (same as the console connector) ----------
  function Esc([string]$s)   { [System.Security.SecurityElement]::Escape($s) }
  function Unesc([string]$s) { [System.Net.WebUtility]::HtmlDecode($s) }
  function Call-Tally([string]$xml, [int]$timeoutMs = 60000) {
    $req = [System.Net.HttpWebRequest]::Create("http://${TallyHost}:${TallyPort}")
    $req.Method = 'POST'; $req.ContentType = 'text/xml; charset=utf-8'; $req.Timeout = $timeoutMs; $req.ReadWriteTimeout = $timeoutMs
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($xml); $req.ContentLength = $bytes.Length
    $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
    $resp = $req.GetResponse(); $ms = New-Object System.IO.MemoryStream; $resp.GetResponseStream().CopyTo($ms); $resp.Close()
    $b = $ms.ToArray()
    if ($b.Length -gt 1 -and $b[1] -eq 0) { return [System.Text.Encoding]::Unicode.GetString($b).TrimStart([char]0xFEFF) }
    return [System.Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF)
  }
  function Collection-Request([string]$name, [string]$type, [string]$fetch, [string]$company) {
    $co = ''; if ($company) { $co = '<SVCURRENTCOMPANY>' + (Esc $company) + '</SVCURRENTCOMPANY>' }
    return '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>' + $name + '</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' + $co +
      '</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="' + $name + '" ISMODIFY="No"><TYPE>' + $type + '</TYPE><FETCH>' + $fetch + '</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
  }
  function Parse-Named([string]$xml, [string]$tag) {
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

  # ---------- window ----------
  $navy = [System.Drawing.Color]::FromArgb(7, 26, 63); $navy2 = [System.Drawing.Color]::FromArgb(11, 42, 102)
  $gold = [System.Drawing.Color]::FromArgb(212, 161, 42); $goldL = [System.Drawing.Color]::FromArgb(240, 203, 106)
  $white = [System.Drawing.Color]::White; $soft = [System.Drawing.Color]::FromArgb(170, 185, 215)
  $green = [System.Drawing.Color]::FromArgb(46, 204, 113); $red = [System.Drawing.Color]::FromArgb(229, 83, 61)

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'TaxNest Tally Connector'; $form.ClientSize = New-Object System.Drawing.Size(500, 600); $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedSingle'; $form.MaximizeBox = $false; $form.BackColor = $navy; $form.ForeColor = $white
  $form.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
  $iconPath = Join-Path $here 'taxnest.ico'; $logoPath = Join-Path $here 'taxnest-logo.png'
  if (Test-Path $iconPath) { try { $form.Icon = New-Object System.Drawing.Icon($iconPath) } catch { } }

  # header band
  $hdr = New-Object System.Windows.Forms.Panel; $hdr.SetBounds(0, 0, 500, 132); $hdr.BackColor = $navy2; $form.Controls.Add($hdr)
  $hdr.Add_Paint({ param($s, $e) $pen = New-Object System.Drawing.Pen($gold, 3); $e.Graphics.DrawLine($pen, 0, 130, 500, 130); $pen.Dispose() })
  if (Test-Path $logoPath) {
    $pic = New-Object System.Windows.Forms.PictureBox; $pic.SetBounds(22, 18, 96, 96); $pic.SizeMode = 'Zoom'; $pic.BackColor = $navy2
    try { $pic.Image = [System.Drawing.Image]::FromFile($logoPath) } catch { }; $hdr.Controls.Add($pic)
  }
  $t1 = New-Object System.Windows.Forms.Label; $t1.Text = 'TaxNest'; $t1.Font = New-Object System.Drawing.Font('Segoe UI', 22, [System.Drawing.FontStyle]::Bold); $t1.ForeColor = $goldL; $t1.AutoSize = $true; $t1.Location = New-Object System.Drawing.Point(132, 22); $t1.BackColor = $navy2; $hdr.Controls.Add($t1)
  $t2 = New-Object System.Windows.Forms.Label; $t2.Text = 'Tally Connector'; $t2.Font = New-Object System.Drawing.Font('Segoe UI', 13); $t2.ForeColor = $white; $t2.AutoSize = $true; $t2.Location = New-Object System.Drawing.Point(135, 66); $t2.BackColor = $navy2; $hdr.Controls.Add($t2)
  $t3 = New-Object System.Windows.Forms.Label; $t3.Text = 'GST  |  TDS  |  Bookkeeping'; $t3.ForeColor = $soft; $t3.AutoSize = $true; $t3.Location = New-Object System.Drawing.Point(136, 94); $t3.BackColor = $navy2; $hdr.Controls.Add($t3)

  # status card
  $card = New-Object System.Windows.Forms.Panel; $card.SetBounds(22, 150, 456, 130); $card.BackColor = [System.Drawing.Color]::FromArgb(14, 40, 92); $form.Controls.Add($card)
  $dot = New-Object System.Windows.Forms.Panel; $dot.SetBounds(18, 22, 60, 60); $dot.BackColor = $card.BackColor; $card.Controls.Add($dot)
  try { $dot.GetType().GetProperty('DoubleBuffered', [Reflection.BindingFlags]'Instance,NonPublic').SetValue($dot, $true, $null) } catch { }
  $dot.Add_Paint({
    param($s, $e)
    $e.Graphics.SmoothingMode = 'AntiAlias'
    $c = if ($script:tally.reachable) { $green } else { $red }
    $ring = [Math]::Min(1.0, $script:pulse); $alpha = [int](150 * (1 - $ring))
    $pb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($alpha, $c)); $rr = 14 + 16 * $ring
    $e.Graphics.FillEllipse($pb, 30 - $rr, 30 - $rr, 2 * $rr, 2 * $rr); $pb.Dispose()
    $b = New-Object System.Drawing.SolidBrush($c); $e.Graphics.FillEllipse($b, 16, 16, 28, 28); $b.Dispose()
  })
  $stTitle = New-Object System.Windows.Forms.Label; $stTitle.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold); $stTitle.AutoSize = $false; $stTitle.SetBounds(92, 20, 350, 30); $stTitle.BackColor = $card.BackColor; $card.Controls.Add($stTitle)
  $stCo = New-Object System.Windows.Forms.Label; $stCo.Font = New-Object System.Drawing.Font('Segoe UI', 11); $stCo.ForeColor = $goldL; $stCo.AutoSize = $false; $stCo.SetBounds(92, 52, 350, 24); $stCo.BackColor = $card.BackColor; $card.Controls.Add($stCo)
  $stSub = New-Object System.Windows.Forms.Label; $stSub.ForeColor = $soft; $stSub.AutoSize = $false; $stSub.SetBounds(92, 78, 350, 40); $stSub.BackColor = $card.BackColor; $card.Controls.Add($stSub)

  # info lines
  function New-Info([string]$k, [int]$y) {
    $a = New-Object System.Windows.Forms.Label; $a.Text = $k; $a.ForeColor = $soft; $a.AutoSize = $true; $a.Location = New-Object System.Drawing.Point(24, $y); $form.Controls.Add($a)
    $b = New-Object System.Windows.Forms.Label; $b.ForeColor = $white; $b.AutoSize = $false; $b.SetBounds(150, $y, 330, 20); $form.Controls.Add($b); return $b
  }
  $iTally = New-Info 'Tally address' 296;       $iTally.Text = "${TallyHost}:${TallyPort}"
  $iConn  = New-Info 'Connector address' 320;   $iConn.Text = "127.0.0.1:$Port  (this computer only)"
  $iSite  = New-Info 'Last website' 344;        $iSite.Text = '-'
  $iAllow = New-Info 'Allowed websites' 368

  # log
  $logLbl = New-Object System.Windows.Forms.Label; $logLbl.Text = 'Activity'; $logLbl.ForeColor = $soft; $logLbl.AutoSize = $true; $logLbl.Location = New-Object System.Drawing.Point(24, 400); $form.Controls.Add($logLbl)
  $log = New-Object System.Windows.Forms.ListBox; $log.SetBounds(22, 422, 456, 118); $log.BackColor = [System.Drawing.Color]::FromArgb(5, 18, 45); $log.ForeColor = $white; $log.BorderStyle = 'None'; $log.Font = New-Object System.Drawing.Font('Consolas', 9); $log.HorizontalScrollbar = $true; $form.Controls.Add($log)
  function Add-Log([string]$t) { $log.Items.Insert(0, ((Get-Date).ToString('HH:mm:ss') + '  ' + $t)); while ($log.Items.Count -gt 60) { $log.Items.RemoveAt($log.Items.Count - 1) } }

  function New-Btn([string]$text, [int]$x, [int]$w, [bool]$primary) {
    $b = New-Object System.Windows.Forms.Button; $b.Text = $text; $b.SetBounds($x, 552, $w, 34); $b.FlatStyle = 'Flat'; $b.Cursor = 'Hand'
    if ($primary) { $b.BackColor = $gold; $b.ForeColor = [System.Drawing.Color]::FromArgb(27, 19, 0); $b.FlatAppearance.BorderSize = 0 } else { $b.BackColor = $navy2; $b.ForeColor = $white; $b.FlatAppearance.BorderColor = $gold }
    $form.Controls.Add($b); return $b
  }
  $bMin = New-Btn 'Minimize to tray' 22 140 $true
  $bAllow = New-Btn 'Allowed websites' 172 150 $false
  $bExit = New-Btn 'Exit' 332 146 $false

  function Refresh-Allow { $n = @(Get-Content $AllowFile -ErrorAction SilentlyContinue | Where-Object { $_ -and $_.Trim() }).Count; $iAllow.Text = "$n website(s) approved (localhost is always allowed)" }
  function Update-Ui {
    if ($script:tally.reachable) {
      $stTitle.Text = 'Connected to Tally'; $stTitle.ForeColor = $green
      $cos = @($script:tally.companies)
      if ($cos.Count -gt 0) { $stCo.Text = $cos[0] + $(if ($cos.Count -gt 1) { '  (+' + ($cos.Count - 1) + ' more open)' } else { '' }) } else { $stCo.Text = 'Company name not reported' }
      $stSub.Text = 'Ready. Open the TaxNest Bank Import website - its Tally light will turn green.'
    } else {
      $stTitle.Text = 'Waiting for Tally'; $stTitle.ForeColor = $red; $stCo.Text = ''
      $stSub.Text = 'Open Tally and load your company. In Tally, the XML/ODBC server must be on (port ' + $TallyPort + ').'
    }
    $iSite.Text = $(if ($script:lastSite) { $script:lastSite } else { '-' })
    $dot.Invalidate(); $tray.Text = $(if ($script:tally.reachable) { 'TaxNest Connector - Tally connected' } else { 'TaxNest Connector - waiting for Tally' })
  }

  # tray icon
  $tray = New-Object System.Windows.Forms.NotifyIcon; $tray.Visible = $true; $tray.Text = 'TaxNest Connector'
  if ($form.Icon) { $tray.Icon = $form.Icon } else { $tray.Icon = [System.Drawing.SystemIcons]::Application }
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $miShow = $menu.Items.Add('Show window'); $miExit = $menu.Items.Add('Exit connector'); $tray.ContextMenuStrip = $menu
  function Show-Window { $form.Show(); $form.WindowState = 'Normal'; $form.Activate() }
  function Quit-App { $script:quit = $true; $tray.Visible = $false; $tray.Dispose(); try { $listener.Stop() } catch { }; $form.Close() }
  $miShow.Add_Click({ Show-Window }); $miExit.Add_Click({ Quit-App }); $tray.Add_DoubleClick({ Show-Window })
  $bMin.Add_Click({ $form.Hide(); $tray.ShowBalloonTip(2500, 'TaxNest Connector', 'Still running in the background.', 'Info') })
  $bExit.Add_Click({ Quit-App })
  $bAllow.Add_Click({ try { Start-Process notepad.exe -ArgumentList $AllowFile } catch { } })
  $form.Add_FormClosing({ param($s, $e) if (-not $script:quit) { $e.Cancel = $true; $form.Hide(); $tray.ShowBalloonTip(2500, 'TaxNest Connector', 'Still running in the background. Right-click the icon to exit.', 'Info') } })

  # ---------- origin approval ----------
  function Origin-Allowed([string]$origin) {
    if ([string]::IsNullOrEmpty($origin)) { return $true }
    if ($origin -eq 'null') { return $true }
    if ($origin -match '^https?://(localhost|127\.0\.0\.1)(:\d+)?$') { return $true }
    if ((Get-Content $AllowFile -ErrorAction SilentlyContinue) -contains $origin) { return $true }
    if ($script:Denied.Contains($origin)) { return $false }
    Show-Window
    $ans = [System.Windows.Forms.MessageBox]::Show($form, "The website`n`n    $origin`n`nwants to read your Tally ledgers and import entries through this connector.`n`nAllow it?", 'TaxNest Connector', 'YesNo', 'Question')
    if ($ans -eq 'Yes') { Add-Content -Path $AllowFile -Value $origin; Add-Log "Allowed $origin"; Refresh-Allow; return $true }
    [void]$script:Denied.Add($origin); Add-Log "Blocked $origin"; return $false
  }

  # ---------- HTTP ----------
  function Send-Json($ctx, [int]$code, $obj, [string]$origin) {
    $json = $obj | ConvertTo-Json -Depth 6 -Compress; $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $res = $ctx.Response; $res.StatusCode = $code; $res.ContentType = 'application/json; charset=utf-8'
    $res.Headers.Add('Access-Control-Allow-Origin', $(if ($origin) { $origin } else { '*' })); $res.Headers.Add('Vary', 'Origin')
    $res.ContentLength64 = $bytes.Length; $res.OutputStream.Write($bytes, 0, $bytes.Length); $res.OutputStream.Close()
  }
  function Read-Body($ctx) { $sr = New-Object System.IO.StreamReader($ctx.Request.InputStream, [System.Text.Encoding]::UTF8); $t = $sr.ReadToEnd(); $sr.Close(); return $t }
  function Query-Param($ctx, [string]$name) { $v = [System.Web.HttpUtility]::ParseQueryString($ctx.Request.Url.Query)[$name]; if ($v) { return $v } else { return '' } }
  function Poll-Tally {
    try {
      $cos = @(); foreach ($c in (Parse-Named (Call-Tally (Collection-Request 'TaxNestCompanies' 'Company' 'Name' '') 2500) 'COMPANY')) { $cos += $c.name }
      $script:tally = @{ reachable = $true; companies = $cos; error = '' }
    } catch { $script:tally = @{ reachable = $false; companies = @(); error = $_.Exception.Message } }
  }
  function Handle-Request($ctx) {
    $req = $ctx.Request; $origin = $req.Headers['Origin']
    try {
      if (-not (Origin-Allowed $origin)) { Send-Json $ctx 403 @{ error = "Website not allowed: $origin" } $origin; return }
      if ($origin) { $script:lastSite = $origin }
      $path = $req.Url.AbsolutePath
      if ($req.HttpMethod -eq 'OPTIONS') {
        $res = $ctx.Response; $res.StatusCode = 204
        $res.Headers.Add('Access-Control-Allow-Origin', $(if ($origin) { $origin } else { '*' })); $res.Headers.Add('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        $res.Headers.Add('Access-Control-Allow-Headers', 'Content-Type'); $res.Headers.Add('Access-Control-Allow-Private-Network', 'true'); $res.Headers.Add('Vary', 'Origin')
        $res.OutputStream.Close(); return
      }
      if ($req.HttpMethod -eq 'GET' -and $path -eq '/status') {
        Poll-Tally; Update-Ui
        Send-Json $ctx 200 @{ helper = $true; connector = 'windows-app'; version = '0.2.0'; tally = @{ reachable = $script:tally.reachable; host = $TallyHost; port = $TallyPort; companies = @($script:tally.companies); error = $script:tally.error } } $origin
        return
      }
      if ($req.HttpMethod -eq 'GET' -and $path -eq '/ledgers') {
        $company = Query-Param $ctx 'company'
        $items = Parse-Named (Call-Tally (Collection-Request 'TaxNestLedgers' 'Ledger' 'Name,Parent' $company)) 'LEDGER'
        $obj = @{ company = $(if ($company) { $company } else { $null }); count = $items.Count; ledgers = @($items) }
        if ($items.Count -eq 0) { $obj['warning'] = 'Tally answered but no ledgers could be read. Is a company open in Tally?' }
        Send-Json $ctx 200 $obj $origin; Add-Log ("Sent {0} ledgers to the website" -f $items.Count); return
      }
      if ($req.HttpMethod -eq 'POST' -and $path -eq '/import') {
        $body = Read-Body $ctx
        if (($body -notmatch '<ENVELOPE>') -or ($body -notmatch 'Import Data')) { Send-Json $ctx 400 @{ error = 'Body must be a Tally import envelope.' } $origin; return }
        $company = Query-Param $ctx 'company'
        if ($company) { $body = $body.Replace('<SVCURRENTCOMPANY/>', '<SVCURRENTCOMPANY>' + (Esc $company) + '</SVCURRENTCOMPANY>') }
        $result = Parse-ImportReply (Call-Tally $body)
        Send-Json $ctx $(if ($result.ok) { 200 } else { 422 }) $result $origin
        Add-Log ("Import: created={0} altered={1} errors={2}" -f $result.created, $result.altered, $result.errors); return
      }
      Send-Json $ctx 404 @{ error = 'Not found' } $origin
    } catch {
      try { Send-Json $ctx 502 @{ error = "Could not talk to Tally at ${TallyHost}:${TallyPort} ($($_.Exception.Message))" } $origin } catch { }
      Add-Log ('Error: ' + $_.Exception.Message)
    }
  }

  # ---------- start listening ----------
  $listener = New-Object System.Net.HttpListener
  $listener.Prefixes.Add("http://127.0.0.1:$Port/"); $listener.Prefixes.Add("http://localhost:$Port/")
  try { $listener.Start() } catch { [void][System.Windows.Forms.MessageBox]::Show("Could not start on port $Port. Is another program using it?`n`n" + $_.Exception.Message, 'TaxNest Connector'); exit 1 }
  Add-Log "Connector started on 127.0.0.1:$Port"; Refresh-Allow
  $script:pending = $listener.GetContextAsync()

  $tReq = New-Object System.Windows.Forms.Timer; $tReq.Interval = 40
  $tReq.Add_Tick({
    try {
      if ($script:pending -and $script:pending.IsCompleted) {
        $ctx = $null; try { $ctx = $script:pending.Result } catch { }
        if (-not $script:quit) { $script:pending = $listener.GetContextAsync() }
        if ($ctx) { Handle-Request $ctx; Update-Ui }
      }
    } catch { Add-Log ('Error: ' + $_.Exception.Message) }
  })
  $tPoll = New-Object System.Windows.Forms.Timer; $tPoll.Interval = 3000
  $tPoll.Add_Tick({ $was = $script:tally.reachable; Poll-Tally; if ($was -ne $script:tally.reachable) { Add-Log $(if ($script:tally.reachable) { 'Tally connected' } else { 'Tally not reachable' }) }; Update-Ui })
  $tAnim = New-Object System.Windows.Forms.Timer; $tAnim.Interval = 50
  $tAnim.Add_Tick({ if ($form.Visible) { $script:pulse += 0.035; if ($script:pulse -gt 1.4) { $script:pulse = 0.0 }; $dot.Invalidate() } })
  Poll-Tally; Update-Ui; $tReq.Start(); $tPoll.Start(); $tAnim.Start()
  [System.Windows.Forms.Application]::Run($form)
  try { $mutex.ReleaseMutex() } catch { }
}
catch {
  try { [void][System.Windows.Forms.MessageBox]::Show("The TaxNest Connector window could not start:`n`n" + $_.Exception.Message + "`n`nStarting the classic connector instead.", 'TaxNest Connector') } catch { }
  Start-Classic
}
