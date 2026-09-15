use aes_gcm::aead::{rand_core::RngCore, Aead, OsRng};
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};

use crate::b64;
use crate::error::{AppError, AppResult};

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;
pub const SALT_LEN: usize = 16;

/// Argon2id parameters. Tuned to stay interactive (~0.3s) on a typical laptop
/// while keeping a real memory-hard cost for offline guessing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub algo: String,
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    pub salt: String,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            algo: "argon2id".to_string(),
            m_cost: 19_456,
            t_cost: 2,
            p_cost: 1,
            salt: String::new(),
        }
    }
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buffer = [0u8; N];
    OsRng.fill_bytes(&mut buffer);
    buffer
}

pub fn new_salt() -> String {
    b64::encode(&random_bytes::<SALT_LEN>())
}

pub fn derive_key(password: &str, params: &KdfParams) -> AppResult<[u8; KEY_LEN]> {
    let salt =
        b64::decode(&params.salt).map_err(|err| AppError::Crypto(format!("盐值解码失败：{err}")))?;
    let parsed = Params::new(params.m_cost, params.t_cost, params.p_cost, Some(KEY_LEN))
        .map_err(|err| AppError::Crypto(format!("KDF 参数无效：{err}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, parsed);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(password.as_bytes(), &salt, &mut out)
        .map_err(|err| AppError::Crypto(format!("密钥派生失败：{err}")))?;
    Ok(out)
}

pub fn encrypt(key: &[u8; KEY_LEN], plaintext: &[u8]) -> AppResult<(String, String)> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce_bytes = random_bytes::<NONCE_LEN>();
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|err| AppError::Crypto(format!("加密失败：{err}")))?;
    Ok((b64::encode(&nonce_bytes), b64::encode(&ciphertext)))
}

pub fn decrypt(key: &[u8; KEY_LEN], nonce: &str, ciphertext: &str) -> AppResult<Vec<u8>> {
    let nonce_bytes =
        b64::decode(nonce).map_err(|err| AppError::Crypto(format!("随机数解码失败：{err}")))?;
    let data =
        b64::decode(ciphertext).map_err(|err| AppError::Crypto(format!("密文解码失败：{err}")))?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(AppError::Crypto("随机数长度不正确".to_string()));
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), data.as_slice())
        // A failed authentication means a wrong password or a tampered file;
        // both are reported the same way on purpose.
        .map_err(|_| AppError::InvalidPassword)
}

/// Windows DPAPI wrapper. Lets the app offer a "no master password" mode where
/// the vault key is sealed to the current Windows user account.
#[cfg(windows)]
mod dpapi {
    use std::ffi::c_void;
    use std::ptr;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let mut input = DataBlob {
                cb_data: data.len() as u32,
                pb_data: data.as_ptr() as *mut u8,
            };
            let mut output = DataBlob {
                cb_data: 0,
                pb_data: ptr::null_mut(),
            };
            let ok = CryptProtectData(
                &mut input,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                &mut output,
            );
            if ok == 0 {
                return Err(format!(
                    "CryptProtectData 失败：{}",
                    std::io::Error::last_os_error()
                ));
            }
            let slice = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize);
            let out = slice.to_vec();
            LocalFree(output.pb_data as *mut c_void);
            Ok(out)
        }
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let mut input = DataBlob {
                cb_data: data.len() as u32,
                pb_data: data.as_ptr() as *mut u8,
            };
            let mut output = DataBlob {
                cb_data: 0,
                pb_data: ptr::null_mut(),
            };
            let ok = CryptUnprotectData(
                &mut input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                &mut output,
            );
            if ok == 0 {
                return Err(format!(
                    "CryptUnprotectData 失败：{}",
                    std::io::Error::last_os_error()
                ));
            }
            let slice = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize);
            let out = slice.to_vec();
            LocalFree(output.pb_data as *mut c_void);
            Ok(out)
        }
    }
}

pub fn seal_for_windows(key: &[u8; KEY_LEN]) -> AppResult<String> {
    #[cfg(windows)]
    {
        let sealed = dpapi::protect(key).map_err(AppError::Crypto)?;
        Ok(b64::encode(&sealed))
    }
    #[cfg(not(windows))]
    {
        let _ = key;
        Err(AppError::Crypto(
            "当前平台不支持 Windows DPAPI，请使用主密码模式".to_string(),
        ))
    }
}

pub fn unseal_for_windows(sealed: &str) -> AppResult<[u8; KEY_LEN]> {
    #[cfg(windows)]
    {
        let raw = b64::decode(sealed)
            .map_err(|err| AppError::Crypto(format!("DPAPI 数据解码失败：{err}")))?;
        let opened = dpapi::unprotect(&raw).map_err(AppError::Crypto)?;
        if opened.len() != KEY_LEN {
            return Err(AppError::Crypto("DPAPI 返回的密钥长度不正确".to_string()));
        }
        let mut key = [0u8; KEY_LEN];
        key.copy_from_slice(&opened);
        Ok(key)
    }
    #[cfg(not(windows))]
    {
        let _ = sealed;
        Err(AppError::Crypto(
            "当前平台不支持 Windows DPAPI".to_string(),
        ))
    }
}

// ---------------------------------------------------------------------------
// Password generation & strength
// ---------------------------------------------------------------------------

const UPPER: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
const DIGITS: &[u8] = b"0123456789";
const SYMBOLS: &[u8] = b"!@#$%^&*()-_=+[]{};:,.?";
const AMBIGUOUS: &[u8] = b"O0oIl1|`'\"";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorOptions {
    #[serde(default = "default_length")]
    pub length: usize,
    #[serde(default = "yes")]
    pub upper: bool,
    #[serde(default = "yes")]
    pub lower: bool,
    #[serde(default = "yes")]
    pub digits: bool,
    #[serde(default = "yes")]
    pub symbols: bool,
    #[serde(default)]
    pub avoid_ambiguous: bool,
    /// SAP passwords historically cap out at 40 characters, so the UI exposes
    /// this as a soft guard rail.
    #[serde(default)]
    pub max_length: Option<usize>,
}

fn default_length() -> usize {
    20
}

fn yes() -> bool {
    true
}

impl Default for GeneratorOptions {
    fn default() -> Self {
        Self {
            length: default_length(),
            upper: true,
            lower: true,
            digits: true,
            symbols: true,
            avoid_ambiguous: false,
            max_length: Some(40),
        }
    }
}

pub fn generate_password(options: &GeneratorOptions) -> AppResult<String> {
    let mut pools: Vec<Vec<u8>> = Vec::new();
    if options.upper {
        pools.push(UPPER.to_vec());
    }
    if options.lower {
        pools.push(LOWER.to_vec());
    }
    if options.digits {
        pools.push(DIGITS.to_vec());
    }
    if options.symbols {
        pools.push(SYMBOLS.to_vec());
    }
    if options.avoid_ambiguous {
        for pool in pools.iter_mut() {
            pool.retain(|candidate| !AMBIGUOUS.contains(candidate));
        }
    }
    pools.retain(|pool| !pool.is_empty());
    if pools.is_empty() {
        return Err(AppError::Msg("至少需要选择一种字符类型".to_string()));
    }

    let mut length = options.length.clamp(4, 128);
    if let Some(max) = options.max_length {
        if max >= 4 {
            length = length.min(max);
        }
    }

    let combined: Vec<u8> = pools.iter().flatten().copied().collect();
    let mut out: Vec<u8> = Vec::with_capacity(length);
    // Guarantee one character from each selected pool so the result satisfies
    // the usual "must contain" password policies.
    for pool in &pools {
        out.push(pool[random_bytes::<4>()[0] as usize % pool.len()]);
    }
    while out.len() < length {
        out.push(combined[random_bytes::<4>()[0] as usize % combined.len()]);
    }
    // Fisher-Yates shuffle so the guaranteed characters are not always first.
    for index in (1..out.len()).rev() {
        let swap = random_bytes::<4>()[0] as usize % (index + 1);
        out.swap(index, swap);
    }
    Ok(String::from_utf8_lossy(&out).to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordStrength {
    pub score: u8,
    pub label: String,
    pub entropy_bits: f64,
    pub suggestions: Vec<String>,
}

pub fn password_strength(password: &str) -> PasswordStrength {
    let mut classes = 0;
    if password.chars().any(|c| c.is_ascii_lowercase()) {
        classes += 1;
    }
    if password.chars().any(|c| c.is_ascii_uppercase()) {
        classes += 1;
    }
    if password.chars().any(|c| c.is_ascii_digit()) {
        classes += 1;
    }
    if password.chars().any(|c| !c.is_alphanumeric()) {
        classes += 1;
    }

    let length = password.chars().count() as f64;
    let alphabet = match classes {
        0 | 1 => 26.0_f64,
        2 => 52.0,
        3 => 62.0,
        _ => 94.0,
    };
    let entropy = if password.is_empty() {
        0.0
    } else {
        length * alphabet.log2()
    };

    let mut suggestions = Vec::new();
    if password.chars().count() < 12 {
        suggestions.push("长度建议至少 12 位".to_string());
    }
    if classes < 3 {
        suggestions.push("混用大小写、数字和符号".to_string());
    }
    if !password.is_empty() && password.chars().all(|c| c.is_alphanumeric()) {
        suggestions.push("加入符号可显著提升强度".to_string());
    }

    let score = match entropy {
        value if value <= 0.0 => 0,
        value if value < 36.0 => 1,
        value if value < 60.0 => 2,
        value if value < 90.0 => 3,
        value if value < 120.0 => 4,
        _ => 5,
    };
    let label = match score {
        0 => "空",
        1 => "很弱",
        2 => "较弱",
        3 => "一般",
        4 => "强",
        _ => "很强",
    };

    PasswordStrength {
        score,
        label: label.to_string(),
        entropy_bits: (entropy * 10.0).round() / 10.0,
        suggestions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_encrypt_decrypt() {
        let key = random_bytes::<KEY_LEN>();
        let (nonce, ciphertext) = encrypt(&key, b"secret payload").unwrap();
        assert_eq!(
            decrypt(&key, &nonce, &ciphertext).unwrap(),
            b"secret payload"
        );
    }

    #[test]
    fn wrong_key_is_rejected() {
        let key = random_bytes::<KEY_LEN>();
        let other = random_bytes::<KEY_LEN>();
        let (nonce, ciphertext) = encrypt(&key, b"secret payload").unwrap();
        assert!(decrypt(&other, &nonce, &ciphertext).is_err());
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let key = random_bytes::<KEY_LEN>();
        let (nonce, ciphertext) = encrypt(&key, b"secret payload").unwrap();
        let mut bytes = b64::decode(&ciphertext).unwrap();
        bytes[0] ^= 0x01;
        assert!(decrypt(&key, &nonce, &b64::encode(&bytes)).is_err());
    }

    #[test]
    fn derived_key_is_stable() {
        let params = KdfParams {
            salt: new_salt(),
            m_cost: 8,
            t_cost: 1,
            p_cost: 1,
            ..Default::default()
        };
        let a = derive_key("hunter2", &params).unwrap();
        let b = derive_key("hunter2", &params).unwrap();
        let c = derive_key("hunter3", &params).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn generated_password_respects_pools() {
        let options = GeneratorOptions {
            length: 24,
            ..GeneratorOptions::default()
        };
        let password = generate_password(&options).unwrap();
        assert_eq!(password.chars().count(), 24);
        assert!(password.chars().any(|c| c.is_ascii_uppercase()));
        assert!(password.chars().any(|c| c.is_ascii_lowercase()));
        assert!(password.chars().any(|c| c.is_ascii_digit()));
        assert!(password.chars().any(|c| !c.is_alphanumeric()));
    }

    #[test]
    fn generated_password_respects_the_sap_length_cap() {
        let options = GeneratorOptions {
            length: 64,
            max_length: Some(40),
            ..GeneratorOptions::default()
        };
        assert_eq!(generate_password(&options).unwrap().chars().count(), 40);
    }

    #[test]
    fn rejects_an_empty_character_pool() {
        let options = GeneratorOptions {
            upper: false,
            lower: false,
            digits: false,
            symbols: false,
            ..GeneratorOptions::default()
        };
        assert!(generate_password(&options).is_err());
    }

    #[test]
    fn strongest_password_scores_higher() {
        assert!(password_strength("abc").score < password_strength("Tr0ub4dor&3xyZ").score);
        assert_eq!(password_strength("").score, 0);
    }

    #[test]
    fn strength_suggestions_cover_weak_input() {
        let report = password_strength("abcdef");
        assert!(!report.suggestions.is_empty());
        assert!(report.entropy_bits > 0.0);
    }
}
