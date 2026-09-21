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

/// How long we keep looking for the SAP GUI window a launch creates.
const WINDOW_WATCH: std::time::Duration = std::time::Duration::from_secs(30);

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
    // The system ID is always handed over: for a logon-group connection SAP GUI
    // reports "system ID missing" when it is omitted, even though the `/R/` or
    // `/M/` connection string already carries the group (verified on 2026-09-21).
    let system_id = launch.system_id.trim();
    if !system_id.is_empty() {
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
///
/// SAP GUI builds its window asynchronously and, when it is started by another
/// application, Windows may keep that window behind the caller — which looks
/// exactly like "the login happened but no window appeared". Two things are done
/// about that: SAP GUI is granted the right to take the foreground, and a
/// watcher then raises the session window that appears after the launch.
pub fn start(executable: &Path, arguments: &[String]) -> AppResult<()> {
    #[cfg(windows)]
    let existing = foreground::session_windows();
    #[cfg(windows)]
    foreground::allow_taking_foreground();

    Command::new(executable)
        .args(arguments)
        .spawn()
        .map(|_| ())
        .map_err(|err| AppError::Msg(format!("无法启动 {}：{err}", executable.to_string_lossy())))?;

    #[cfg(windows)]
    std::thread::spawn(move || {
        foreground::raise_new_session_window(&existing, WINDOW_WATCH);
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Window handling (Windows only)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod foreground {
    use std::ffi::c_void;
    use std::time::{Duration, Instant};

    type Hwnd = *mut c_void;

    const SW_SHOW: i32 = 5;
    const SW_RESTORE: i32 = 9;
    /// `ASFW_ANY`: let the next process that asks take the foreground.
    const ASFW_ANY: u32 = u32::MAX;
    /// SAP GUI session windows are `SAP_FRONTEND_SESSION` / `SAP_FRONTEND_*`.
    const SESSION_CLASS_PREFIX: &str = "SAP_FRONTEND";

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(
            callback: Option<extern "system" fn(Hwnd, isize) -> i32>,
            param: isize,
        ) -> i32;
        fn GetClassNameW(hwnd: Hwnd, buffer: *mut u16, max_count: i32) -> i32;
        fn IsIconic(hwnd: Hwnd) -> i32;
        fn IsWindowVisible(hwnd: Hwnd) -> i32;
        fn ShowWindow(hwnd: Hwnd, command: i32) -> i32;
        fn SetForegroundWindow(hwnd: Hwnd) -> i32;
        fn AllowSetForegroundWindow(process_id: u32) -> i32;
    }

    fn class_name(hwnd: Hwnd) -> String {
        let mut buffer = [0u16; 256];
        let length = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if length <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..length as usize])
    }

    extern "system" fn collect_sessions(hwnd: Hwnd, param: isize) -> i32 {
        let found = unsafe { &mut *(param as *mut Vec<isize>) };
        if class_name(hwnd).starts_with(SESSION_CLASS_PREFIX) {
            found.push(hwnd as isize);
        }
        1
    }

    /// Handles of every SAP GUI session window that exists right now.
    pub fn session_windows() -> Vec<isize> {
        let mut found: Vec<isize> = Vec::new();
        unsafe {
            EnumWindows(Some(collect_sessions), &mut found as *mut Vec<isize> as isize);
        }
        found
    }

    /// Lets SAP GUI put its own window in front even though we started it.
    pub fn allow_taking_foreground() {
        unsafe {
            AllowSetForegroundWindow(ASFW_ANY);
        }
    }

    /// Waits for a session window that was not there before and raises it.
    /// Returns `true` when a window was found.
    pub fn raise_new_session_window(known: &[isize], timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            for handle in session_windows() {
                if known.contains(&handle) {
                    continue;
                }
                let hwnd = handle as Hwnd;
                unsafe {
                    if IsIconic(hwnd) != 0 {
                        ShowWindow(hwnd, SW_RESTORE);
                    } else if IsWindowVisible(hwnd) == 0 {
                        ShowWindow(hwnd, SW_SHOW);
                    }
                    SetForegroundWindow(hwnd);
                }
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(400));
        }
    }
}

/// Builds a `.sap` shortcut file.
///
/// The layout follows a shortcut saved by SAP GUI itself (sample verified on
/// 2026-09-21): `[System]` describes the connection by **system ID and client**
/// — there is deliberately no connection string, SAP GUI resolves the server
/// from SAP Logon — `[User]` carries the user name and language, `[Function]`
/// the window title and start transaction, followed by `[Configuration]` and
/// `[Options]`.
///
/// The password is deliberately not part of it: the file is plain text, and SAP
/// GUI asks for the password by itself.
pub fn shortcut_text(
    launch: &SapLaunch,
    username: &str,
    description: &str,
    work_dir: &str,
) -> String {
    let system_id = launch.system_id.trim();
    let description = match description.trim() {
        "" => system_id,
        value => value,
    };
    let mut lines: Vec<String> = Vec::new();

    lines.push("[System]".to_string());
    if !description.is_empty() {
        lines.push(format!("Description={description}"));
    }
    if !system_id.is_empty() {
        lines.push(format!("SystemID={system_id}"));
    }
    let client = normalize_client(&launch.client);
    if !client.is_empty() {
        lines.push(format!("Client={client}"));
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

    // S000 is SAP's own "SAP Easy Access" start transaction, which is what SAP
    // GUI writes into a shortcut when no other transaction was chosen.
    lines.push("[Function]".to_string());
    lines.push("Title=SAP".to_string());
    let command = launch.transaction.trim();
    lines.push(format!(
        "Command={}",
        if command.is_empty() { "S000" } else { command }
    ));

    let work_dir = work_dir.trim();
    if !work_dir.is_empty() {
        lines.push("[Configuration]".to_string());
        lines.push(format!("WorkDir={work_dir}"));
    }
    lines.push("[Options]".to_string());
    lines.push("Reuse=1".to_string());

    let mut text = lines.join("\r\n");
    text.push_str("\r\n");
    text
}

/// Where SAP GUI keeps its work files: `<Documents>\SAP\SAP GUI`.
pub fn default_work_dir() -> Option<PathBuf> {
    dirs::document_dir().map(|documents| documents.join("SAP").join("SAP GUI"))
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
    fn logon_group_connection_strings_keep_the_system_id() {
        // Verified on 2026-09-21: a logon-group connection started without
        // `-system` makes SAP GUI complain that the system ID is missing, even
        // though `/R/` already carries the group.
        let group = SapLaunch {
            system_id: "PRD".to_string(),
            guiparm: "/R/PRD/G/SPACE".to_string(),
            client: "100".to_string(),
            ..Default::default()
        };
        let args = build_arguments(&group, "USER01", "", false);
        assert!(args.contains(&"-system=PRD".to_string()));
        assert!(args.contains(&"-guiparm=/R/PRD/G/SPACE".to_string()));
        assert!(args.contains(&"-client=100".to_string()));

        let routed = SapLaunch {
            system_id: "PRD".to_string(),
            guiparm: "/H/10.0.0.1/S/3299/M/sapmsgsrv/S/3600/G/SPACE".to_string(),
            ..Default::default()
        };
        let args = build_arguments(&routed, "", "", false);
        assert!(args.contains(&"-system=PRD".to_string()));
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
    fn shortcut_file_matches_the_format_sap_gui_writes() {
        let text = shortcut_text(
            &launch(),
            "USER01",
            "PRD [SPACE]",
            r"C:\Users\me\Documents\SAP\SAP GUI",
        );
        assert!(text.starts_with("[System]\r\n"));
        assert!(text.contains("Description=PRD [SPACE]\r\n"));
        assert!(text.contains("SystemID=PRD\r\n"));
        assert!(text.contains("Client=001\r\n"));
        assert!(text.contains("[User]\r\nName=USER01\r\nLanguage=ZH\r\n"));
        assert!(text.contains("[Function]\r\nTitle=SAP\r\nCommand=se80\r\n"));
        assert!(
            text.contains("[Configuration]\r\nWorkDir=C:\\Users\\me\\Documents\\SAP\\SAP GUI\r\n")
        );
        assert!(text.contains("[Options]\r\nReuse=1\r\n"));
        assert!(text.ends_with("\r\n"));
        // SAP GUI looks the server up in SAP Logon by system ID, so the file must
        // not carry a connection string — and never the password.
        assert!(!text.contains("GuiParm"));
        assert!(!text.contains("pw="));
    }

    #[test]
    fn shortcut_file_defaults_to_the_easy_access_transaction() {
        let bare = SapLaunch {
            system_id: "DEV".to_string(),
            guiparm: "/H/dev.example/S/3200".to_string(),
            ..Default::default()
        };
        let text = shortcut_text(&bare, "", "", "");
        // No description, no user, no work dir passed in → those sections shrink
        // or fall back instead of writing empty keys.
        assert!(text.contains("Description=DEV\r\n"));
        assert!(text.contains("SystemID=DEV\r\n"));
        assert!(text.contains("[Function]\r\nTitle=SAP\r\nCommand=S000\r\n"));
        assert!(!text.contains("[User]"));
        assert!(!text.contains("[Configuration]"));
        assert!(text.contains("[Options]\r\nReuse=1\r\n"));
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
    #[cfg(windows)]
    fn session_window_lookup_is_safe_to_call() {
        // The watcher runs on every launch; on a machine without SAP GUI the list
        // is simply empty, and it must never panic.
        let windows = foreground::session_windows();
        assert!(windows.len() < 10_000);
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
