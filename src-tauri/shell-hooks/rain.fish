# Rain terminal - fish shell integration hooks
# Implements FinalTerm shell integration protocol (OSC 133)
# for command block detection.

# Guard: only run inside Rain
if not set -q RAIN_TERMINAL
    exit
end

function __rain_prompt --on-event fish_prompt
    set -l exit_code $status

    # OSC 133;D - command finished (skip on first prompt)
    if set -q __rain_command_started
        printf '\033]133;D;%d\007' $exit_code
        set -e __rain_command_started
    end

    # OSC 7 - report current working directory
    printf '\033]7;file://%s%s\007' (hostname) $PWD

    # OSC 133;A - prompt start
    printf '\033]133;A\007'
end

function __rain_preexec --on-event fish_preexec
    # OSC 133;B - command identified
    printf '\033]133;B;%s\007' $argv[1]

    # OSC 133;C - command output starts
    printf '\033]133;C\007'

    set -g __rain_command_started 1
end
