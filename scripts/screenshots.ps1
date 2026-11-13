# Служебная проверка интерфейса: делает снимки экранов приложения в гостевом режиме.
# Использование: powershell -File scripts/screenshots.ps1 -OutDir <папка> [-Only home,search]
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Only = ''
)
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules/electron/dist/electron.exe'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$shots = [ordered]@{
  'home'      = @('--route=home')
  'search'    = @('--route=search:Imagine')
  'artist'    = @('--route=artist:102622')
  'release'   = @('--route=release:19896779')
  'wave'      = @('--route=wave')
  'np'        = @('--route=release:6233892', '--extra=np-hover')
  'nplyrics'  = @('--route=release:6233892', '--extra=np-lyrics')
  'queue'     = @('--route=release:19896779', '--extra=queue')
  'lyrics'    = @('--route=release:6233892', '--extra=lyrics')
  'menu'      = @('--route=release:19896779', '--extra=menu')
  'settings'  = @('--route=settings')
  'viz'       = @('--route=visualizer', '--extra=vizplay')
  'eq'        = @('--route=equalizer', '--extra=eqplay')
  'play'      = @('--route=release:6233892', '--extra=play')
  'login'     = @('--login-preview')
  'suggest'   = @('--route=artist:102622', '--extra=suggest')
  'waveplay'  = @('--route=wave', '--extra=waveplay')
  'collapse'  = @('--route=liked', '--extra=collapse')
  'npmenu'    = @('--route=release:6233892', '--extra=menunp')
  'npviz'     = @('--route=release:6233892', '--extra=np-play-viz')
  'classic'   = @('--route=artist:1457739', '--extra=classic')
  'seekset'   = @('--route=settings', '--extra=seekset')
  'vizwaves'  = @('--route=visualizer', '--extra=vizplay', '--vizstyle=waves')
  'npaura'    = @('--route=release:6233892', '--extra=np-play-viz', '--vizstyle=aura')
  'npring'    = @('--route=release:6233892', '--extra=np-play-viz', '--vizstyle=ring')
  'perf'      = @('--route=artist:1457739', '--extra=perf')
  'cliptest'  = @('--route=visualizer', '--extra=cliptest')
  'sbcollapse' = @('--route=artist:1457739', '--extra=sbcollapse')
  'sbexpand'  = @('--route=artist:1457739', '--extra=sbexpand')
}
$OnlyList = @($Only -split "," | Where-Object { $_ })
foreach ($name in $shots.Keys) {
  if ($OnlyList.Count -and -not ($OnlyList -contains $name)) { continue }
  $out = Join-Path $OutDir "shot-$name.png"
  if (Test-Path $out) { Remove-Item $out }
  $args = @($root, "--screenshot=$out") + $shots[$name]
  $p = Start-Process -FilePath $electron -ArgumentList $args -NoNewWindow -PassThru -RedirectStandardOutput "$OutDir/$name.out" -RedirectStandardError "$OutDir/$name.err"
  if (-not $p.WaitForExit(90000)) { $p.Kill(); Write-Output "$name : TIMEOUT" ; continue }
  $log = Get-Content "$OutDir/$name.out" -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch 'SCREENSHOT_SAVED' -and $_.Trim() }
  Write-Output ("{0} : {1}" -f $name, $(if (Test-Path $out) { 'ok' } else { 'НЕТ СНИМКА' }))
  $log | ForEach-Object { Write-Output "   $_" }
}
