use serde::{Serialize, Serializer};

/// Every fallible backend operation funnels through this type so the frontend
/// always receives a plain, human-readable string it can show in a toast.
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
    #[error("{0}")]
    Msg(String),
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

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
