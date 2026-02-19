use std::path::PathBuf;

/// Get the directory containing the shell hook scripts.
/// In development, this is src-tauri/shell-hooks/.
/// In a release build, hooks are bundled as Tauri resources and
/// resolved via platform-specific resource directory layouts.
pub fn hooks_dir() -> PathBuf {
    // For dev: use the source directory
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("shell-hooks");
    if dev_path.exists() {
        return dev_path;
    }

    if let Ok(exe) = std::env::current_exe() {
        let exe = exe.canonicalize().unwrap_or(exe);
        if let Some(dir) = exe.parent() {
            // Tauri resource paths by platform:
            let candidates: &[PathBuf] = &[
                // macOS: {app}/Contents/MacOS/{exe} -> ../Resources/shell-hooks
                dir.join("../Resources/shell-hooks"),
                // Linux (AppImage/deb): {exe_dir}/../resources/shell-hooks
                dir.join("../resources/shell-hooks"),
                // Linux alternate: {exe_dir}/../lib/{app}/resources/shell-hooks
                dir.join("../lib/rain/resources/shell-hooks"),
                // Windows: {exe_dir}/resources/shell-hooks or alongside exe
                dir.join("resources/shell-hooks"),
                dir.join("shell-hooks"),
            ];
            for candidate in candidates {
                if candidate.exists() {
                    if let Ok(resolved) = candidate.canonicalize() {
                        return resolved;
                    }
                    return candidate.clone();
                }
            }
        }
    }

    dev_path
}

/// Get the hook script path for a given shell.
/// Maps shell names to their hook script filenames (e.g. "pwsh" -> "rain.ps1").
pub fn hook_script_path(shell_name: &str) -> Option<PathBuf> {
    let dir = hooks_dir();
    let filename = match shell_name {
        "pwsh" | "powershell" => "rain.ps1".to_string(),
        _ => format!("rain.{}", shell_name),
    };
    let path = dir.join(filename);

    if path.exists() {
        Some(path)
    } else {
        None
    }
}

/// Build the shell command that sources our hooks.
/// For POSIX shells this is injected via environment variables;
/// for PowerShell it returns a dot-source command used in `-Command` args.
pub fn shell_init_command(shell_name: &str) -> Option<String> {
    let script = hook_script_path(shell_name)?;
    let script_str = script.to_string_lossy();

    match shell_name {
        "zsh" => Some(format!(
            r#"if [ -f "{script_str}" ]; then source "{script_str}"; fi"#
        )),
        "bash" => Some(format!(
            r#"if [ -f "{script_str}" ]; then source "{script_str}"; fi"#
        )),
        "fish" => Some(format!(
            r#"if test -f "{script_str}"; source "{script_str}"; end"#
        )),
        "pwsh" | "powershell" => Some(format!(
            r#". "{script_str}""#
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hooks_dir_returns_dev_path_in_test_environment() {
        let dir = hooks_dir();
        assert!(dir.exists(), "hooks dir should exist in dev: {:?}", dir);
        assert!(dir.ends_with("shell-hooks"));
    }

    #[test]
    fn hook_script_path_finds_existing_shells() {
        assert!(hook_script_path("zsh").is_some(), "rain.zsh should exist");
        assert!(hook_script_path("bash").is_some(), "rain.bash should exist");
        assert!(hook_script_path("fish").is_some(), "rain.fish should exist");
    }

    #[test]
    fn hook_script_path_maps_powershell_to_ps1() {
        let pwsh = hook_script_path("pwsh");
        let powershell = hook_script_path("powershell");
        assert!(pwsh.is_some(), "rain.ps1 should exist for pwsh");
        assert!(powershell.is_some(), "rain.ps1 should exist for powershell");
        assert_eq!(pwsh, powershell, "pwsh and powershell should resolve to same file");
    }

    #[test]
    fn hook_script_path_returns_none_for_unknown_shell() {
        assert!(hook_script_path("cmd").is_none());
        assert!(hook_script_path("nushell").is_none());
        assert!(hook_script_path("").is_none());
    }

    #[test]
    fn shell_init_command_generates_posix_source_for_zsh() {
        let cmd = shell_init_command("zsh").expect("zsh should produce init command");
        assert!(cmd.contains("source"), "zsh init should use `source`");
        assert!(cmd.contains("rain.zsh"), "zsh init should reference rain.zsh");
        assert!(cmd.starts_with("if [ -f"), "should guard with file existence check");
    }

    #[test]
    fn shell_init_command_generates_posix_source_for_bash() {
        let cmd = shell_init_command("bash").expect("bash should produce init command");
        assert!(cmd.contains("source"), "bash init should use `source`");
        assert!(cmd.contains("rain.bash"), "bash init should reference rain.bash");
    }

    #[test]
    fn shell_init_command_generates_fish_syntax() {
        let cmd = shell_init_command("fish").expect("fish should produce init command");
        assert!(cmd.contains("test -f"), "fish should use `test -f`");
        assert!(cmd.contains("; end"), "fish should close with `; end`");
        assert!(cmd.contains("rain.fish"));
    }

    #[test]
    fn shell_init_command_generates_dot_source_for_powershell() {
        let cmd = shell_init_command("pwsh").expect("pwsh should produce init command");
        assert!(cmd.starts_with(". "), "PowerShell should use dot-source");
        assert!(cmd.contains("rain.ps1"));

        let cmd2 = shell_init_command("powershell").expect("powershell variant");
        assert!(cmd2.starts_with(". "), "powershell should also dot-source");
    }

    #[test]
    fn shell_init_command_returns_none_for_unsupported_shells() {
        assert!(shell_init_command("cmd").is_none());
        assert!(shell_init_command("nushell").is_none());
        assert!(shell_init_command("unknown_shell").is_none());
    }
}
