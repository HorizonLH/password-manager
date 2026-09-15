use std::sync::Mutex;
use std::time::Instant;

use zeroize::Zeroize;

use crate::crypto::{KdfParams, KEY_LEN};
use crate::error::{AppError, AppResult};
use crate::model::{now_string, Vault};
use crate::store::{self, Settings, VaultEnvelope, VaultMode};

/// Everything that only exists while the vault is open. The derived key and the
/// decrypted passwords are wiped on `Drop`, which is what `lock()` relies on.
pub struct Unlocked {
    pub vault: Vault,
    pub key: [u8; KEY_LEN],
}

impl Drop for Unlocked {
    fn drop(&mut self) {
        self.key.zeroize();
        for entry in self.vault.entries.iter_mut() {
            entry.password.zeroize();
            for recorded in entry.password_history.iter_mut() {
                recorded.password.zeroize();
            }
        }
        for file in self.vault.files.iter_mut() {
            if let Some(analysis) = file.analysis.as_mut() {
                for record in analysis.records.iter_mut() {
                    for field in record.fields.iter_mut() {
                        if field.kind == "password" {
                            field.value.zeroize();
                        }
                    }
                }
            }
        }
    }
}

pub struct AppState {
    unlocked: Mutex<Option<Unlocked>>,
    envelope: Mutex<Option<VaultEnvelope>>,
    settings: Mutex<Settings>,
    last_activity: Mutex<Instant>,
    /// Set when the vault file exists but could not be read: the UI shows this
    /// instead of pretending there is no vault yet.
    startup_error: Option<String>,
}

impl AppState {
    pub fn new(
        settings: Settings,
        envelope: Option<VaultEnvelope>,
        startup_error: Option<String>,
    ) -> Self {
        Self {
            unlocked: Mutex::new(None),
            envelope: Mutex::new(envelope),
            settings: Mutex::new(settings),
            last_activity: Mutex::new(Instant::now()),
            startup_error,
        }
    }

    pub fn startup_error(&self) -> Option<String> {
        self.startup_error.clone()
    }

    pub fn touch(&self) {
        if let Ok(mut last) = self.last_activity.lock() {
            *last = Instant::now();
        }
    }

    pub fn idle_seconds(&self) -> u64 {
        self.last_activity
            .lock()
            .map(|last| last.elapsed().as_secs())
            .unwrap_or(0)
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    pub fn has_vault(&self) -> bool {
        self.envelope
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    pub fn envelope_snapshot(&self) -> Option<VaultEnvelope> {
        self.envelope.lock().ok().and_then(|guard| guard.clone())
    }

    pub fn set_envelope(&self, envelope: VaultEnvelope) {
        if let Ok(mut guard) = self.envelope.lock() {
            *guard = Some(envelope);
        }
    }

    pub fn settings_snapshot(&self) -> Settings {
        self.settings
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn update_settings<T>(&self, mutate: impl FnOnce(&mut Settings) -> T) -> AppResult<T> {
        let (result, snapshot) = {
            let mut guard = self
                .settings
                .lock()
                .map_err(|_| AppError::Msg("设置状态不可用".to_string()))?;
            let result = mutate(&mut guard);
            guard.normalize();
            (result, guard.clone())
        };
        store::save_settings(&snapshot)?;
        Ok(result)
    }

    pub fn set_unlocked(&self, unlocked: Unlocked) {
        if let Ok(mut guard) = self.unlocked.lock() {
            // Dropping the previous value wipes its key material.
            *guard = Some(unlocked);
        }
        self.touch();
    }

    /// Returns `true` when something was actually locked.
    pub fn lock(&self) -> bool {
        self.unlocked
            .lock()
            .map(|mut guard| guard.take().is_some())
            .unwrap_or(false)
    }

    /// Read-only access to the decrypted vault.
    pub fn with_vault<T>(&self, read: impl FnOnce(&Vault) -> AppResult<T>) -> AppResult<T> {
        let guard = self
            .unlocked
            .lock()
            .map_err(|_| AppError::Msg("保险库状态不可用".to_string()))?;
        let unlocked = guard.as_ref().ok_or(AppError::Locked)?;
        read(&unlocked.vault)
    }

    /// Mutating access. The vault is re-encrypted and written before returning,
    /// so the in-memory and on-disk copies never diverge.
    pub fn with_vault_mut<T>(
        &self,
        mutate: impl FnOnce(&mut Vault) -> AppResult<T>,
    ) -> AppResult<T> {
        let result = {
            let mut guard = self
                .unlocked
                .lock()
                .map_err(|_| AppError::Msg("保险库状态不可用".to_string()))?;
            let unlocked = guard.as_mut().ok_or(AppError::Locked)?;
            unlocked.vault.updated_at = now_string();
            mutate(&mut unlocked.vault)?
        };
        self.persist_current()?;
        self.touch();
        Ok(result)
    }

    /// Re-encrypts the in-memory vault with the key currently held in memory.
    pub fn persist_current(&self) -> AppResult<()> {
        let (plaintext, key) = {
            let guard = self
                .unlocked
                .lock()
                .map_err(|_| AppError::Msg("保险库状态不可用".to_string()))?;
            let unlocked = guard.as_ref().ok_or(AppError::Locked)?;
            (serde_json::to_vec(&unlocked.vault)?, unlocked.key)
        };
        let (nonce, ciphertext) = crate::crypto::encrypt(&key, &plaintext)?;

        let mut envelope_guard = self
            .envelope
            .lock()
            .map_err(|_| AppError::Msg("保险库状态不可用".to_string()))?;
        let envelope = envelope_guard.as_mut().ok_or(AppError::NoVault)?;
        envelope.nonce = nonce;
        envelope.ciphertext = ciphertext;
        envelope.updated_at = now_string();
        store::save_envelope(envelope)
    }

    /// Switches the vault to a new master password. The KDF parameters and the
    /// ciphertext are replaced in the same write, so a crash in between cannot
    /// leave a vault whose salt no longer matches its key.
    pub fn rekey_with_password(&self, key: &[u8; KEY_LEN], params: KdfParams) -> AppResult<()> {
        let plaintext = {
            let mut guard = self
                .unlocked
                .lock()
                .map_err(|_| AppError::Msg("保险库状态不可用".to_string()))?;
            let unlocked = guard.as_mut().ok_or(AppError::Locked)?;
            unlocked.key = *key;
            serde_json::to_vec(&unlocked.vault)?
        };
        let (nonce, ciphertext) = crate::crypto::encrypt(key, &plaintext)?;

        let mut envelope_guard = self
            .envelope
            .lock()
            .map_err(|_| AppError::Msg("保险库状态不可用".to_string()))?;
        let envelope = envelope_guard.as_mut().ok_or(AppError::NoVault)?;
        envelope.kdf = Some(params);
        envelope.mode = VaultMode::Password;
        envelope.sealed_key = None;
        envelope.nonce = nonce;
        envelope.ciphertext = ciphertext;
        envelope.updated_at = now_string();
        store::save_envelope(envelope)
    }

    pub fn knox_id(&self) -> String {
        self.with_vault(|vault| Ok(vault.knox_id.clone()))
            .unwrap_or_default()
    }

    pub fn auto_lock_due(&self) -> bool {
        let minutes = self.settings_snapshot().auto_lock_minutes;
        if minutes == 0 || !self.is_unlocked() {
            return false;
        }
        self.idle_seconds() >= u64::from(minutes) * 60
    }
}

// ---------------------------------------------------------------------------
// Windows session state
// ---------------------------------------------------------------------------

/// `true` when the interactive session is locked (Win+L, screen-saver lock, or
/// the UAC secure desktop).
///
/// While the workstation is locked the input desktop belongs to Winlogon, so
/// `OpenInputDesktop` fails for a normal process. That is the documented
/// side-effect this check relies on, and it needs no extra permissions.
#[cfg(windows)]
pub fn workstation_locked() -> bool {
    const DESKTOP_READOBJECTS: u32 = 0x0001;

    #[link(name = "user32")]
    extern "system" {
        fn OpenInputDesktop(dw_flags: u32, f_inherit: i32, dw_desired_access: u32) -> *mut core::ffi::c_void;
        fn CloseDesktop(h_desktop: *mut core::ffi::c_void) -> i32;
    }

    unsafe {
        let handle = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if handle.is_null() {
            return true;
        }
        CloseDesktop(handle);
        false
    }
}

#[cfg(not(windows))]
pub fn workstation_locked() -> bool {
    false
}
