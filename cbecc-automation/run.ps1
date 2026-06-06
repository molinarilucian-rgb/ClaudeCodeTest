<#
run.ps1 — invoke the CBECC automation scripts with the correct Python.

Finds a real Python (ignoring the Windows Store alias stub) and runs the named
script from this folder, forwarding all remaining arguments verbatim.

Usage:
    .\run.ps1                         # print resolved Python + usage
    .\run.ps1 init_db.py --force
    .\run.ps1 qa_review.py list
    .\run.ps1 qa_review.py verify-all --by "L. Molinari"
    .\run.ps1 generate_ribd.py --intake sample_intake.json --out Doe.ribd --strict
    .\run.ps1 intake_from_csv.py build .\intake_csv_example --out intake.json
    .\run.ps1 verify_cbecc.py --probe

If PowerShell blocks the script ("running scripts is disabled"), either run it as
    powershell -ExecutionPolicy Bypass -File .\run.ps1 init_db.py --force
or allow local scripts once:
    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

NOTE: deliberately NOT an advanced function (no param()/CmdletBinding). That
keeps PowerShell from auto-adding common params like -OutVariable, which would
otherwise hijack a forwarded "--out" flag. All tokens land in $args untouched.
#>

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Resolve-Python {
    $candidates = @()

    # 1. known winget user-scope install
    $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe')

    # 2. any other Python3x user install (newest first)
    $root = Join-Path $env:LOCALAPPDATA 'Programs\Python'
    if (Test-Path $root) {
        Get-ChildItem $root -Directory -Filter 'Python3*' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { $candidates += (Join-Path $_.FullName 'python.exe') }
    }

    # 3. any python.exe on PATH that is NOT the Store alias stub (WindowsApps)
    Get-Command python.exe -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -and ($_.Source -notmatch 'WindowsApps') } |
        ForEach-Object { $candidates += $_.Source }

    foreach ($c in ($candidates | Select-Object -Unique)) {
        if ($c -and (Test-Path $c)) {
            try {
                & $c --version *> $null
                if ($LASTEXITCODE -eq 0) { return $c }
            } catch { }
        }
    }
    return $null
}

$py = Resolve-Python
if (-not $py) {
    Write-Error "No real Python found. Install it with:  winget install Python.Python.3.12"
    exit 1
}

if ($args.Count -eq 0) {
    Write-Host "Python : $py"
    Write-Host ""
    Write-Host "Usage  : .\run.ps1 <script.py> [args...]"
    Write-Host "  e.g.   .\run.ps1 init_db.py --force"
    Write-Host "         .\run.ps1 qa_review.py verify-all --by `"L. Molinari`""
    Write-Host "         .\run.ps1 generate_ribd.py --intake sample_intake.json --strict"
    exit 0
}

$script = [string]$args[0]
$rest = @()
if ($args.Count -gt 1) { $rest = $args[1..($args.Count - 1)] }

$scriptPath = if (Test-Path $script) { (Resolve-Path $script).Path } else { Join-Path $here $script }
if (-not (Test-Path $scriptPath)) {
    Write-Error "Script not found: $script"
    exit 1
}

if ($rest.Count -gt 0) { & $py $scriptPath @rest } else { & $py $scriptPath }
exit $LASTEXITCODE
