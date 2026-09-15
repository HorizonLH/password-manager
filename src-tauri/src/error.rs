use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Every fallible backend operation funnels through this type so the frontend
/// always receives something it can show.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("文件读写失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("数据序列化失败：{0}")]
    Serde(#[from] serde_json::Error),
    #[error("XML 解析失败：{0}")]
    Xml(String),
    #[error("加密操作失败：{0}")]
    Crypto(String),
    #[error("保险库尚未解锁")]
    Locked,
    #[error("尚未创建保险库")]
    NoVault,
    #[error("保险库已存在")]
    VaultExists,
    #[error("主密码不正确")]
    InvalidPassword,
    #[error("未找到：{0}")]
    NotFound(String),
    /// A rejectable-but-overridable problem, e.g. a password that violates its
    /// rule or repeats one the target system still remembers. The frontend shows
    /// `details` and can retry with `force`.
    #[error("{message}")]
    Validation {
        kind: String,
        message: String,
        details: Vec<String>,
    },
    #[error("{0}")]
    Msg(String),
}

impl AppError {
    pub fn validation(
        kind: &str,
        message: impl Into<String>,
        details: Vec<String>,
    ) -> Self {
        AppError::Validation {
            kind: kind.to_string(),
            message: message.into(),
            details,
        }
    }
}

impl From<quick_xml::Error> for AppError {
    fn from(value: quick_xml::Error) -> Self {
        AppError::Xml(value.to_string())
    }
}

impl From<quick_xml::events::attributes::AttrError> for AppError {
    fn from(value: quick_xml::events::attributes::AttrError) -> Self {
        AppError::Xml(value.to_string())
    }
}

/// Plain problems are serialized as a string; validation problems carry a
/// structured payload the UI can act on.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            AppError::Validation {
                kind,
                message,
                details,
            } => {
                let mut state = serializer.serialize_struct("AppError", 3)?;
                state.serialize_field("kind", kind)?;
                state.serialize_field("message", message)?;
                state.serialize_field("details", details)?;
                state.end()
            }
            other => serializer.serialize_str(&other.to_string()),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;
