use std::time::Duration;

use arboard::Clipboard;

use crate::error::{AppError, AppResult};

/// Writes text to the clipboard.
///
/// `arboard` opens a fresh handle per call because the Windows clipboard is a
/// shared, short-lived resource: holding one open while the user interacts with
/// SAP GUI can block other applications.
pub fn set_text(text: &str) -> AppResult<()> {
    let mut clipboard =
        Clipboard::new().map_err(|e| AppError::Msg(format!("无法访问剪贴板：{e}")))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|e| AppError::Msg(format!("写入剪贴板失败：{e}")))?;
    Ok(())
}

pub fn get_text() -> AppResult<String> {
    let mut clipboard =
        Clipboard::new().map_err(|e| AppError::Msg(format!("无法访问剪贴板：{e}")))?;
    clipboard
        .get_text()
        .map_err(|e| AppError::Msg(format!("读取剪贴板失败：{e}")))
}

/// Clears the clipboard only when it still holds what we put there, so content
/// copied in the meantime is never destroyed.
pub fn clear_if_equals(expected: &str) -> AppResult<bool> {
    let current = match get_text() {
        Ok(text) => text,
        // A clipboard holding an image or a locked clipboard both land here;
        // either way there is nothing of ours left to remove.
        Err(_) => return Ok(false),
    };
    if current != expected {
        return Ok(false);
    }
    let mut clipboard =
        Clipboard::new().map_err(|e| AppError::Msg(format!("无法访问剪贴板：{e}")))?;
    clipboard
        .clear()
        .map_err(|e| AppError::Msg(format!("清空剪贴板失败：{e}")))?;
    Ok(true)
}

/// Schedules the "wipe the clipboard after N seconds" behaviour. `on_cleared`
/// runs only when something was actually removed, so the UI can show a toast.
pub fn schedule_auto_clear<F>(text: String, seconds: u64, on_cleared: F)
where
    F: FnOnce() + Send + 'static,
{
    if seconds == 0 {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(seconds));
        if matches!(clear_if_equals(&text), Ok(true)) {
            on_cleared();
        }
    });
}

/// Builds the clipboard payload SAP GUI expects: pasting a multi-line text into
/// the first login field fills the following fields, so user name and password
/// travel as two lines.
pub fn sap_credentials_payload(username: &str, password: &str, separator: &str) -> String {
    format!("{username}{separator}{password}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sap_payload_uses_the_configured_separator() {
        assert_eq!(
            sap_credentials_payload("JDOE", "S3cret!", "\r\n"),
            "JDOE\r\nS3cret!"
        );
        assert_eq!(
            sap_credentials_payload("JDOE", "S3cret!", "\n"),
            "JDOE\nS3cret!"
        );
    }

    #[test]
    fn payload_handles_empty_values() {
        assert_eq!(sap_credentials_payload("", "", "\r\n"), "\r\n");
    }
}
