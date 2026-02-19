use std::env;
use std::path::Path;

/// Detect the user's default shell on Unix (macOS / Linux).
/// Checks `$SHELL` first, verifying the path exists, then falls back through
/// `/bin/zsh`, `/bin/bash`, `/bin/sh`.
#[cfg(unix)]
pub fn detect_shell() -> String {
    if let Ok(shell) = env::var("SHELL") {
        if !shell.is_empty() {
            if Path::new(&shell).exists() {
                return shell;
            }
            tracing::warn!(
                "$SHELL is set to '{}' but the path does not exist; falling back",
                shell
            );
        }
    }

    for candidate in &["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if Path::new(candidate).exists() {
            tracing::info!("Using fallback shell: {}", candidate);
            return candidate.to_string();
        }
    }

    "/bin/sh".to_string()
}

/// Detect the user's default shell on Windows.
/// Prefers PowerShell 7 (pwsh) over Windows PowerShell 5.1 over cmd.exe.
#[cfg(windows)]
pub fn detect_shell() -> String {
    let pwsh_candidates = [
        r"C:\Program Files\PowerShell\7\pwsh.exe",
        r"C:\Program Files (x86)\PowerShell\7\pwsh.exe",
    ];
    for candidate in &pwsh_candidates {
        if Path::new(candidate).exists() {
            tracing::info!("Found PowerShell 7: {}", candidate);
            return candidate.to_string();
        }
    }

    // Check COMSPEC (usually points to cmd.exe, but respect user overrides)
    if let Ok(comspec) = env::var("COMSPEC") {
        if !comspec.is_empty() && Path::new(&comspec).exists() {
            tracing::info!("Using COMSPEC shell: {}", comspec);
            return comspec;
        }
    }

    let fallbacks = [
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        r"C:\Windows\System32\cmd.exe",
    ];
    for candidate in &fallbacks {
        if Path::new(candidate).exists() {
            tracing::info!("Using fallback shell: {}", candidate);
            return candidate.to_string();
        }
    }

    r"C:\Windows\System32\cmd.exe".to_string()
}

/// Extract the shell name from its full path, stripping directory and extension.
///
/// Works with both Unix (`/bin/zsh` -> `"zsh"`) and Windows
/// (`C:\Program Files\PowerShell\7\pwsh.exe` -> `"pwsh"`) paths.
/// Uses manual separator splitting so Windows paths parse correctly on Unix
/// hosts (where `std::path::Path` doesn't recognise `\`).
pub fn shell_name(shell_path: &str) -> &str {
    let name = shell_path
        .rsplit(|c: char| c == '/' || c == '\\')
        .next()
        .unwrap_or(shell_path);
    name.strip_suffix(".exe").unwrap_or(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shell_name_unix_paths() {
        assert_eq!(shell_name("/bin/zsh"), "zsh");
        assert_eq!(shell_name("/usr/local/bin/fish"), "fish");
        assert_eq!(shell_name("bash"), "bash");
    }

    #[test]
    fn test_shell_name_windows_paths() {
        assert_eq!(shell_name(r"C:\Program Files\PowerShell\7\pwsh.exe"), "pwsh");
        assert_eq!(
            shell_name(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
            "powershell"
        );
        assert_eq!(shell_name(r"C:\Windows\System32\cmd.exe"), "cmd");
    }
}
