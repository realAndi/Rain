use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Rain terminal configuration, loaded from ~/.config/rain/config.toml
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RainConfig {
    pub font: FontConfig,
    pub terminal: TerminalConfig,
    pub theme: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FontConfig {
    pub family: String,
    pub size: f32,
    pub line_height: f32,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalConfig {
    pub scrollback_lines: usize,
    pub cursor_blink: bool,
    pub cursor_shape: String,
    pub option_as_meta: bool,
    pub shell: Option<String>,
}

impl Default for RainConfig {
    fn default() -> Self {
        Self {
            font: FontConfig {
                family: "JetBrains Mono, Menlo, Monaco, monospace".to_string(),
                size: 14.0,
                line_height: 1.4,
            },
            terminal: TerminalConfig {
                scrollback_lines: 10_000,
                cursor_blink: true,
                cursor_shape: "block".to_string(),
                option_as_meta: true,
                shell: None,
            },
            theme: "dark".to_string(),
        }
    }
}

#[allow(dead_code)]
impl RainConfig {
    /// Load config from the standard config path, falling back to defaults.
    pub fn load() -> Self {
        let path = config_path();
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(content) => {
                    // We store as JSON for simplicity in v1
                    match serde_json::from_str(&content) {
                        Ok(config) => return config,
                        Err(e) => {
                            tracing::warn!("Failed to parse config: {}", e);
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to read config: {}", e);
                }
            }
        }
        Self::default()
    }

    /// Save config to the standard config path.
    pub fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        let path = config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(self)?;
        std::fs::write(path, content)?;
        Ok(())
    }
}

#[allow(dead_code)]
fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("~/.config"))
        .join("rain")
        .join("config.json")
}
