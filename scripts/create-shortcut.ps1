# Создаёт ярлык «Zvuk Glass» на рабочем столе и в меню «Пуск».
# Запуск: powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$ico = Join-Path $root 'assets\icon.ico'
if (-not (Test-Path $exe)) { Write-Error "Не найден Electron ($exe). Сначала выполните npm install."; exit 1 }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Zvuk Glass.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Zvuk Glass.lnk')
)
foreach ($lnkPath in $targets) {
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = $exe
  $lnk.Arguments = "`"$root`""
  $lnk.WorkingDirectory = $root
  $lnk.Description = 'Zvuk Glass — плеер для Zvuk'
  if (Test-Path $ico) { $lnk.IconLocation = $ico }
  $lnk.Save()
  Write-Output "Создан ярлык: $lnkPath"
}
