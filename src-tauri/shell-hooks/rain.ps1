# Rain terminal - PowerShell shell integration hooks
# Implements FinalTerm protocol (OSC 133) for command block detection.

# Guard: only run inside Rain
if (-not $env:RAIN_TERMINAL) { return }

$script:__rain_esc = [char]27
$script:__rain_bel = [char]7
$script:__rain_cmd_active = $false

function global:prompt {
    $lastSuccess = $?
    $savedExit = $global:LASTEXITCODE
    $e = $script:__rain_esc
    $b = $script:__rain_bel

    # OSC 133;D - previous command finished
    if ($script:__rain_cmd_active) {
        $code = if ($lastSuccess) { 0 } else { if ($savedExit) { $savedExit } else { 1 } }
        [Console]::Write("${e}]133;D;${code}${b}")
        $script:__rain_cmd_active = $false
    }

    # OSC 7 - report current working directory
    $cwd = (Get-Location).Path -replace '\\', '/'
    $hostname = [System.Net.Dns]::GetHostName()
    [Console]::Write("${e}]7;file://${hostname}/${cwd}${b}")

    # OSC 133;A - prompt start
    [Console]::Write("${e}]133;A${b}")

    # Return empty prompt; Rain renders its own
    $global:LASTEXITCODE = $savedExit
    return " "
}

# Hook command execution via PSReadLine (available by default in pwsh 7+)
if (Get-Module PSReadLine -ErrorAction SilentlyContinue) {
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
        $line = $null
        $cursor = $null
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)

        $e = $script:__rain_esc
        $b = $script:__rain_bel

        # OSC 133;B - command identified (with command text)
        [Console]::Write("${e}]133;B;${line}${b}")

        # OSC 133;C - command output starts
        [Console]::Write("${e}]133;C${b}")

        $script:__rain_cmd_active = $true

        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
}

# Tmux interception - redirect through Rain's integrated tmux support
function global:tmux {
    if ($env:RAIN_TMUX_MODE -eq "native" -or $env:RAIN_NATIVE_TMUX) {
        $tmuxBin = Get-Command -CommandType Application tmux -ErrorAction SilentlyContinue
        if ($tmuxBin) {
            & $tmuxBin.Source @args
        }
        return
    }
    $e = $script:__rain_esc
    $b = $script:__rain_bel
    $argString = $args -join ' '
    [Console]::Write("${e}]133;T;${argString}${b}")
}
