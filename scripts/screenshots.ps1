# Служебная проверка интерфейса: делает снимки экранов приложения в гостевом режиме.
# Использование: powershell -File scripts/screenshots.ps1 -OutDir <папка> [-Only home,search] [-Exe путь]
# По умолчанию берётся собранная версия (src-tauri/target/release или debug).
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Only = '',
  [string]$Exe = ''
)
$root = Split-Path -Parent $PSScriptRoot
if (-not $Exe) {
  $Exe = @('src-tauri/target/release/zvuk-glass.exe', 'src-tauri/target/debug/zvuk-glass.exe') | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Exe) { Write-Error 'Сначала соберите приложение: npm run build'; exit 1 }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$shots = [ordered]@{
  'home'      = @('--route=home')
  'search'    = @('--route=search:Imagine')
  'artist'    = @('--route=artist:102622')
  'release'   = @('--route=release:19896779')
  'wave'      = @('--route=wave')
  'np'        = @('--route=release:6233892', '--extra=np-real')
  'nplyrics'  = @('--route=release:6233892', '--extra=np-lyrics')
  'nova'      = @('--route=release:6233892', '--extra=nova')
  'novacollapsed' = @('--route=release:6233892', '--extra=novacollapsed')
  'queue'     = @('--route=release:19896779', '--extra=queue')
  'lyrics'    = @('--route=release:6233892', '--extra=lyrics')
  'menu'      = @('--route=release:19896779', '--extra=menu')
  'settings'  = @('--route=settings')
  'viz'       = @('--route=visualizer', '--extra=vizplay')
  'vizpanel'  = @('--route=visualizer', '--extra=vizpanel')
  'vizparticles' = @('--route=visualizer', '--extra=vizparticles')
  'vizoff'    = @('--route=visualizer', '--extra=vizoff')
  'vizimpact' = @('--route=visualizer', '--extra=vizimpact')
  'npvizimpact' = @('--route=release:6233892', '--extra=npvizimpact')
  'clipoffset' = @('--route=release:6233892', '--extra=clipoffset')
  'artistcard' = @('--route=search:Blackpink', '--extra=artistcard')
  'npvizpanel' = @('--route=release:6233892', '--extra=npvizpanel')
  'chart'     = @('--route=popular')
  'eq'        = @('--route=equalizer', '--extra=eqplay')
  'play'      = @('--route=release:6233892', '--extra=play')
  'login'     = @('--login-preview')
  'suggest'   = @('--route=artist:102622', '--extra=suggest')
  'waveplay'  = @('--route=wave', '--extra=waveplay')
  'waveplaywide' = @('--route=wave', '--extra=waveplaywide')
  'wavefx'    = @('--route=wave', '--extra=wavefx')
  'waveconsole' = @('--route=wave', '--extra=waveconsole')
  'orbit3d'   = @('--route=wave', '--extra=orbit3d')
  'recent'    = @('--route=wave', '--extra=recent')
  'wavenarrow' = @('--route=wave', '--extra=wavenarrow')
  'collapse'  = @('--route=liked', '--extra=collapse')
  'npmenu'    = @('--route=release:6233892', '--extra=menunp')
  'npviz'     = @('--route=release:6233892', '--extra=np-play-viz')
  'classic'   = @('--route=artist:1457739', '--extra=classic')
  'seekset'   = @('--route=settings', '--extra=seekset')
  'vizwaves'  = @('--route=visualizer', '--extra=vizplay', '--vizstyle=waves')
  'npaura'    = @('--route=release:6233892', '--extra=np-play-viz', '--vizstyle=aura')
  'npring'    = @('--route=release:6233892', '--extra=np-play-viz', '--vizstyle=ring')
  'perf'      = @('--route=artist:1457739', '--extra=perf')
  'scrollperf' = @('--route=home', '--extra=scrollperf')
  'cliptest'  = @('--route=visualizer', '--extra=cliptest')
  'clipq'     = @('--route=visualizer', '--extra=clipq1080')
  'clipsync'  = @('--route=visualizer', '--extra=clipsync')
  'sbcollapse' = @('--route=artist:1457739', '--extra=sbcollapse')
  'sbexpand'  = @('--route=artist:1457739', '--extra=sbexpand')
  'popular'   = @('--route=popular', '--extra=popular')
  'artistpop' = @('--route=artist:168687', '--extra=artistpop')
  'voldrag'   = @('--route=release:6233892', '--extra=voldrag')
  'minieq'    = @('--route=release:6233892', '--extra=minieq')
  'eqpresets' = @('--route=equalizer', '--extra=eqpresets')
  'whatsnew'  = @('--route=home', '--extra=whatsnew')
  'ink'       = @('--route=release:6233892', '--extra=ink')
  'inkclip'   = @('--route=release:6233892', '--extra=inkclip')
  'lyrext'    = @('--route=home', '--extra=lyrext')
  'clipfeedback' = @('--route=settings', '--extra=clipfeedback')
  'orbitalsettings' = @('--route=settings', '--extra=orbitalsettings')
  'pulse'     = @('--route=pulse', '--extra=pulse')
  'pulsecount' = @('--route=pulse', '--extra=pulsecount')
  'pulseplay' = @('--route=pulse', '--extra=pulseplay')
  'pulsepause' = @('--route=pulse', '--extra=pulsepause')
  'pulsewin'  = @('--route=pulse', '--extra=pulsewin')
  'pulselose' = @('--route=pulse', '--extra=pulselose')
  'pulsetest' = @('--route=pulse', '--extra=pulsetest')
  'pulserhythm' = @('--route=pulse', '--extra=pulserhythm')
  'pulseexpert' = @('--route=pulse', '--extra=pulseexpert')
  'pulsestart' = @('--route=pulse', '--extra=pulsestart')
  'nplayout'  = @('--route=release:6233892', '--extra=nplayout')
  'uiactions' = @('--route=release:6233892', '--extra=uiactions')
  'novaemotions' = @('--route=home', '--extra=novaemotions')
  'headphonetest' = @('--route=equalizer', '--extra=headphoneeq')
  'headphonesony' = @('--route=equalizer', '--extra=headphoneeqsony')
  'novatest'  = @('--route=home', '--extra=novatest')
  'homepanel' = @('--route=home', '--extra=homepanel')
  'liked'     = @('--route=liked')
  'homenarrow' = @('--route=home', '--extra=homenarrow')
  'pulsenarrow' = @('--route=pulse', '--extra=pulsenarrow')
  'likednarrow' = @('--route=liked', '--extra=likednarrow')
  'fullaudit' = @('--route=home', '--extra=fullaudit')
}
$OnlyList = @($Only -split "," | Where-Object { $_ })
foreach ($name in $shots.Keys) {
  if ($OnlyList.Count -and -not ($OnlyList -contains $name)) { continue }
  $out = Join-Path $OutDir "shot-$name.png"
  if (Test-Path $out) { Remove-Item $out }
  $args = @("--screenshot=$out") + $shots[$name]
  $p = Start-Process -FilePath $Exe -ArgumentList $args -NoNewWindow -PassThru -RedirectStandardOutput "$OutDir/$name.out" -RedirectStandardError "$OutDir/$name.err"
  if (-not $p.WaitForExit(300000)) { $p.Kill(); Write-Output "$name : TIMEOUT" ; continue }
  $log = Get-Content "$OutDir/$name.out" -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch 'SCREENSHOT_SAVED' -and $_.Trim() }
  Write-Output ("{0} : {1}" -f $name, $(if (Test-Path $out) { 'ok' } else { 'НЕТ СНИМКА' }))
  $log | ForEach-Object { Write-Output "   $_" }
}
