//! Starting SAP GUI for Windows and writing `.sap` shortcuts.
//!
//! SAP ships a small launcher for exactly this job — `sapshcut.exe` — which
//! takes the system, client, user, language and connection string on the command
//! line (SAP Note 103019 "SAPShortcut: Program parameters"). Everything here is
//! built around that tool: we never touch SAP's own configuration files, we only
//! read the landscape (see `saplogon.rs`) and hand `sapshcut.exe` the arguments.
//!
//! The password is the one interesting decision. `-pw=<password>` works, but the
//! value lands in the process command line where any local process can read it,
//! so it is opt-in. The default mode starts SAP GUI with the user name filled in
//! and no password: the login screen asks for the password, and the password
//! alone is waiting in the clipboard.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{AppError, AppResult};
use crate::model::SapLaunch;

/// `-pw=<password>` on the command line (visible to other local processes).
pub const PASSWORD_MODE_COMMAND_LINE: &str = "commandLine";
/// Clipboard payload plus an SAP GUI login prompt (default).
pub const PASSWORD_MODE_CLIPBOARD: &str = "clipboard";

const EXECUTABLE: &str = "sapshcut.exe";

/// Every place we look for `sapshcut.exe`: the two documented install roots plus
/// whatever sits next to them on this machine.
pub fn candidate_paths() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for variable in ["ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"] {
        if let Some(value) = std::env::var_os(variable) {
            let path = PathBuf::from(value);
            if !roots.contains(&path) {
                roots.push(path);
            }
        }
    }
    for fallback in [r"C:\Program Files (x86)", r"C:\Program Files"] {
        let path = PathBuf::from(fallback);
        if !roots.contains(&path) {
            roots.push(path);
        }
    }

    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |path: PathBuf| {
        if !out.contains(&path) {
            out.push(path);
        }
    };
    for root in roots {
        let front_end = root.join("SAP").join("FrontEnd");
        for folder in ["SAPGUI", "SapGui", "SAPGui"] {
            push(front_end.join(folder).join(EXECUTABLE));
        }
        // Custom installations: any FrontEnd subfolder that holds the launcher.
        if let Ok(entries) = std::fs::read_dir(&front_end) {
            for entry in entries.flatten() {
                push(entry.path().join(EXECUTABLE));
            }
        }
    }
    out
}

/// Returns the launcher to use: the explicit path when it exists, otherwise the
/// first detected installation.
pub fn locate(explicit: &str) -> Option<PathBuf> {
    let trimmed = explicit.trim();
    if !trimmed.is_empty() {
        let path = PathBuf::from(trimmed);
        if path.is_file() {
            return Some(path);
        }
    }
    candidate_paths().into_iter().find(|path| path.is_file())
}

/// Builds the `sapshcut.exe` argument list.
///
/// `include_password` is what separates the two password modes: the clipboard
/// mode still passes `-user` (so only the password is left to paste) but never
/// `-pw`.
pub fn build_arguments(
    launch: &SapLaunch,
    username: &str,
    password: &str,
    include_password: bool,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    let guiparm = launch.guiparm.trim();
    // A `/R/` (system ID + logon group) or `/M/` (message server + logon group)
    // connection string already names the target system, and SAP GUI rejects the
    // combination with `-system` as contradictory. Plain `/H/<host>/S/<port>`
    // connection strings keep the system ID.
    let guiparm_names_the_system =
        guiparm.contains("/R/") || guiparm.contains("/M/");
    let system_id = launch.system_id.trim();
    if !system_id.is_empty() && !guiparm_names_the_system {
        args.push(format!("-system={system_id}"));
    }
    let client = normalize_client(&launch.client);
    if !client.is_empty() {
        args.push(format!("-client={client}"));
    }
    if !guiparm.is_empty() {
        args.push(format!("-guiparm={guiparm}"));
    }
    let username = username.trim();
    if !username.is_empty() {
        args.push(format!("-user={username}"));
    }
    let language = launch.language.trim();
    if !language.is_empty() {
        args.push(format!("-language={language}"));
    }
    if include_password && !password.is_empty() {
        args.push(format!("-pw={password}"));
    }
    if launch.maximize {
        args.push("-maxgui".to_string());
    }
    let transaction = launch.transaction.trim();
    if !transaction.is_empty() {
        args.push("-type=Transaction".to_string());
        args.push(format!("-command={transaction}"));
    }
    args
}

/// SAP Logon always shows the client as three digits; users type `1` or `100`.
fn normalize_client(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.chars().all(|c| c.is_ascii_digit()) && trimmed.len() < 3 {
        format!("{trimmed:0>3}")
    } else {
        trimmed.to_string()
    }
}

/// Starts `sapshcut.exe` without a shell, so the arguments reach SAP verbatim.
pub fn start(executable: &Path, arguments: &[String]) -> AppResult<()> {
    Command::new(executable)
        .args(arguments)
        .spawn()
        .map(|_| ())
        .map_err(|err| {
            AppError::Msg(format!("无法启动 {}：{err}", executable.to_string_lossy()))
        })
}

/// Builds a `.sap` shortcut file.
///
/// The layout is SAP's own INI style (the file SAP NetWeaver Portal hands out
/// and `sapshcut -edit` writes). The password is deliberately not part of it:
/// the file is plain text, and SAP GUI asks for the password by itself.
pub fn shortcut_text(launch: &SapLaunch, username: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push("[System]".to_string());
    let name = launch.system_id.trim();
    if !name.is_empty() {
        lines.push(format!("Name={name}"));
    }
    let client = normalize_client(&launch.client);
    if !client.is_empty() {
        lines.push(format!("Client={client}"));
    }
    let guiparm = launch.guiparm.trim();
    if !guiparm.is_empty() {
        lines.push(format!("GuiParm={guiparm}"));
    }

    let username = username.trim();
    let language = launch.language.trim();
    if !username.is_empty() || !language.is_empty() {
        lines.push("[User]".to_string());
        if !username.is_empty() {
            lines.push(format!("Name={username}"));
        }
        if !language.is_empty() {
            lines.push(format!("Language={language}"));
        }
    }

    let transaction = launch.transaction.trim();
    if !transaction.is_empty() {
        lines.push("[Function]".to_string());
        lines.push(format!("Command={transaction}"));
        lines.push("Type=Transaction".to_string());
    }

    let mut text = lines.join("\r\n");
    text.push_str("\r\n");
    text
}

/// Writes a shortcut file, creating the parent folder when needed.
pub fn write_shortcut(path: &Path, contents: &str) -> AppResult<String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(path, contents)?;
    Ok(path.to_string_lossy().to_string())
}

/// Everything the UI needs to explain what a login is about to do.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOutcome {
    pub mode: String,
    pub executable: String,
    /// Arguments with the password masked; safe to show in a toast.
    pub arguments: Vec<String>,
    pub password_on_command_line: bool,
    pub clipboard_seconds: u32,
    pub message: String,
}

/// Replaces a `-pw=…` argument with `-pw=***` for display.
pub fn mask_password(arguments: &[String]) -> Vec<String> {
    arguments
        .iter()
        .map(|argument| {
            if argument.starts_with("-pw=") {
                "-pw=***".to_string()
            } else {
                argument.clone()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch() -> SapLaunch {
        SapLaunch {
            system_id: "PRD".to_string(),
            client: "1".to_string(),
            language: "ZH".to_string(),
            guiparm: "/H/sap-prd.example/S/3200".to_string(),
            service_uuid: "s-prd".to_string(),
            transaction: "se80".to_string(),
            maximize: true,
        }
    }

    #[test]
    fn command_line_mode_carries_the_password() {
        let args = build_arguments(&launch(), "USER01", "S3cret!", true);
        assert!(args.contains(&"-system=PRD".to_string()));
        assert!(args.contains(&"-client=001".to_string()));
        assert!(args.contains(&"-guiparm=/H/sap-prd.example/S/3200".to_string()));
        assert!(args.contains(&"-user=USER01".to_string()));
        assert!(args.contains(&"-language=ZH".to_string()));
        assert!(args.contains(&"-pw=S3cret!".to_string()));
        assert!(args.contains(&"-maxgui".to_string()));
        assert!(args.contains(&"-type=Transaction".to_string()));
        assert!(args.contains(&"-command=se80".to_string()));
    }

    #[test]
    fn clipboard_mode_keeps_the_user_but_never_the_password() {
        // The user name is prefilled so only the password has to be pasted;
        // the password itself must never reach the command line.
        let args = build_arguments(&launch(), "USER01", "S3cret!", false);
        assert!(!args.iter().any(|arg| arg.starts_with("-pw=")));
        assert!(args.contains(&"-user=USER01".to_string()));
        assert!(args.iter().any(|arg| arg.starts_with("-system=")));
    }

    #[test]
    fn logon_group_connection_strings_replace_the_system_id() {
        // SAP GUI treats `-system` together with `/R/` or `/M/` as contradictory.
        let group = SapLaunch {
            system_id: "PRD".to_string(),
            guiparm: "/R/PRD/G/SPACE".to_string(),
            client: "100".to_string(),
            ..Default::default()
        };
        let args = build_arguments(&group, "USER01", "", false);
        assert!(!args.iter().any(|arg| arg.starts_with("-system=")));
        assert!(args.contains(&"-guiparm=/R/PRD/G/SPACE".to_string()));
        assert!(args.contains(&"-client=100".to_string()));

        let routed = SapLaunch {
            system_id: "PRD".to_string(),
            guiparm: "/H/10.0.0.1/S/3299/M/sapmsgsrv/S/3600/G/SPACE".to_string(),
            ..Default::default()
        };
        let args = build_arguments(&routed, "", "", false);
        assert!(!args.iter().any(|arg| arg.starts_with("-system=")));
        assert!(args.contains(&"-guiparm=/H/10.0.0.1/S/3299/M/sapmsgsrv/S/3600/G/SPACE".to_string()));
    }

    #[test]
    fn optional_arguments_are_dropped_when_empty() {
        let bare = SapLaunch {
            system_id: "DEV".to_string(),
            ..Default::default()
        };
        let args = build_arguments(&bare, "", "", false);
        assert_eq!(args, vec!["-system=DEV".to_string()]);
    }

    #[test]
    fn clients_are_padded_to_three_digits() {
        assert_eq!(normalize_client("1"), "001");
        assert_eq!(normalize_client("10"), "010");
        assert_eq!(normalize_client("100"), "100");
        assert_eq!(normalize_client(" 200 "), "200");
        assert_eq!(normalize_client(""), "");
    }

    #[test]
    fn shortcut_file_uses_sap_ini_layout() {
        let text = shortcut_text(&launch(), "USER01");
        assert!(text.starts_with("[System]\r\n"));
        assert!(text.contains("Name=PRD\r\n"));
        assert!(text.contains("Client=001\r\n"));
        assert!(text.contains("GuiParm=/H/sap-prd.example/S/3200\r\n"));
        assert!(text.contains("[User]\r\nName=USER01\r\nLanguage=ZH\r\n"));
        assert!(text.contains("[Function]\r\nCommand=se80\r\nType=Transaction\r\n"));
        assert!(text.ends_with("\r\n"));
        // A shortcut file is plain text on disk — never put the password in it.
        assert!(!text.contains("pw="));
    }

    #[test]
    fn shortcut_file_skips_sections_without_values() {
        let bare = SapLaunch {
            system_id: "DEV".to_string(),
            guiparm: "/H/dev.example/S/3200".to_string(),
            ..Default::default()
        };
        let text = shortcut_text(&bare, "");
        assert!(!text.contains("[User]"));
        assert!(!text.contains("[Function]"));
        assert!(text.contains("[System]"));
    }

    #[test]
    fn displayed_arguments_never_leak_the_password() {
        let args = build_arguments(&launch(), "USER01", "S3cret!", true);
        let shown = mask_password(&args);
        assert!(shown.contains(&"-pw=***".to_string()));
        assert!(!shown.iter().any(|arg| arg.contains("S3cret!")));
    }

    #[test]
    fn candidate_paths_look_like_sap_installations() {
        let candidates = candidate_paths();
        assert!(!candidates.is_empty());
        assert!(candidates
            .iter()
            .all(|path| path.file_name().and_then(|name| name.to_str()) == Some(EXECUTABLE)));
    }

    #[test]
    fn outcome_json_matches_the_frontend() {
        let outcome = LaunchOutcome {
            mode: PASSWORD_MODE_CLIPBOARD.to_string(),
            executable: r"C:\SAP\sapshcut.exe".to_string(),
            arguments: mask_password(&build_arguments(&launch(), "U", "P", true)),
            password_on_command_line: false,
            clipboard_seconds: 30,
            message: "ok".to_string(),
        };
        let json = serde_json::to_value(&outcome).expect("serialize");
        for key in [
            "mode",
            "executable",
            "arguments",
            "passwordOnCommandLine",
            "clipboardSeconds",
            "message",
        ] {
            assert!(json.get(key).is_some(), "missing field {key}");
        }
    }

    #[test]
    fn launch_settings_json_matches_the_entry_model() {
        let json = serde_json::to_value(launch()).expect("serialize");
        for key in [
            "systemId",
            "client",
            "language",
            "guiparm",
            "serviceUuid",
            "transaction",
            "maximize",
        ] {
            assert!(json.get(key).is_some(), "missing field {key}");
        }
        // Entries written by 1.0.x have no SAP block at all.
        let empty: SapLaunch = serde_json::from_str("{}").expect("deserialize empty");
        assert!(empty.is_empty());
        assert!(!empty.is_usable());
    }
}
