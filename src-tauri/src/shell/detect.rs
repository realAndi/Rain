use std::env;
use std::path::Path;

/// Detect the user's default shell on macOS.
/// Checks `$SHELL` first, verifying the path exists, then falls back through
/// `/bin/zsh`, `/bin/bash`, `/bin/sh`.
pub fn detect_shell() -> String {
    // Check SHELL environment variable first
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

    // Fallback chain
    for candidate in &["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if Path::new(candidate).exists() {
            tracing::info!("Using fallback shell: {}", candidate);
            return candidate.to_string();
        }
    }

    // Last resort (should always exist on any Unix system)
    "/bin/sh".to_string()
}

/// Get the shell name from its full path (e.g. "/bin/zsh" -> "zsh").
pub fn shell_name(shell_path: &str) -> &str {
    shell_path.rsplit('/').next().unwrap_or(shell_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shell_name() {
        assert_eq!(shell_name("/bin/zsh"), "zsh");
        assert_eq!(shell_name("/usr/local/bin/fish"), "fish");
        assert_eq!(shell_name("bash"), "bash");
    }
}
