# Sync the pomodoro plugin source into the profile that loads it.
#
# The profile resolves the package from
#   $DSH_HOME\profiles\desktop\node_modules\@deepseek-ai\dsh-plugin-pomodoro
# while development happens in this repository. pnpm installs a hardlinked copy, so
# editing here does not reach the running plugin: this script rewrites the installed
# files, and the client HMR watcher then reloads the browser bundle.
#
# Usage:  pwsh -File tools\sync-plugin.ps1

[CmdletBinding()]
param(
  [string] $Profile = 'desktop',
  [switch] $SkipClient
)

$ErrorActionPreference = 'Stop'

$source = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$target = Join-Path $dshHome "profiles\$Profile\node_modules\@deepseek-ai\dsh-plugin-pomodoro"

if (-not (Test-Path $target)) {
  throw "plugin is not installed in profile '$Profile': $target`nInstall it first (plugin_manager install_bundle, target file:$source)."
}

$files = @('package.json', 'cordis.patch.yml')
if (-not $SkipClient) { $files += 'lib\client.js' }
$files += 'lib\index.js'
# The host half imports the shared engine from src/, so that file has to be in the
# installed copy too — a `file:` install is filtered by package.json's `files` list.
$files += 'src\engine.js'

foreach ($relative in $files) {
  $from = Join-Path $source $relative
  $to = Join-Path $target $relative
  if (-not (Test-Path $from)) { throw "missing source file: $from" }
  # A file the installed package has never carried (a newly added source directory)
  # needs its destination directory created first.
  $directory = Split-Path -Parent $to
  if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
  # Copy over the pnpm hardlink instead of writing through it, so the package in the
  # pnpm store is never mutated by a development edit.
  if (Test-Path $to) { Remove-Item $to -Force }
  Copy-Item $from $to -Force
  Write-Host "synced $relative"
}

$installed = Get-Item (Join-Path $target 'package.json')
Write-Host "profile '$Profile' now has version $((Get-Content $installed.FullName -Raw | ConvertFrom-Json).version)"
