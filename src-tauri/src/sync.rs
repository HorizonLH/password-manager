use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::model::{Entry, SyncTarget, Vault};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/// The values a linked file contributed for one account.
fn source_values(entry: &Entry, knox_id: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for link in &entry.links {
        let parse = link.parse.clone().unwrap_or_default();
        out.push(json!({
            "path": link.path,
            "label": link.label,
            "format": parse.format,
            "exists": link.exists,
            "size": link.size,
            "modifiedAt": link.modified_at,
            "url": parse.value_of("url"),
            "username": parse.value_of("username"),
            "password": parse.value_of("password"),
            "complete": parse.is_complete(),
            "missing": parse.missing,
            "keys": {
                "url": link.keys.url,
                "username": link.keys.username,
                "password": link.keys.password,
            },
            "systemId": entry.system_id(),
            "account": entry.title,
            "accountUsername": entry.effective_username(knox_id),
        }));
    }
    out
}

/// Builds the variable tree that sync templates render against. Keeping this in
/// one place means the UI preview and the written file can never disagree.
pub fn build_context(vault: &Vault, line_separator: &str) -> AppResult<Value> {
    let knox_id = vault.knox_id.clone();

    let mut accounts: Vec<Value> = Vec::new();
    let mut entries: Vec<Value> = Vec::new();
    let mut files: Vec<Value> = Vec::new();

    for entry in &vault.entries {
        let sap = entry.sap.clone().unwrap_or_default();
        let username = entry.effective_username(&knox_id);
        let sources = source_values(entry, &knox_id);
        for source in &sources {
            files.push(source.clone());
        }

        let first = |key: &str| -> String {
            sources
                .iter()
                .find_map(|source| {
                    source
                        .get(key)
                        .and_then(|value| value.as_str())
                        .filter(|value| !value.is_empty())
                        .map(|value| value.to_string())
                })
                .unwrap_or_default()
        };

        // A file that already holds the credentials is a perfectly good source,
        // so the effective value falls back to it when the entry field is empty.
        let effective_url = if entry.url.is_empty() {
            first("url")
        } else {
            entry.url.clone()
        };
        let effective_username = if username.is_empty() {
            first("username")
        } else {
            username.clone()
        };
        let effective_password = if entry.password.is_empty() {
            first("password")
        } else {
            entry.password.clone()
        };

        let value = json!({
            "id": entry.id,
            "title": entry.title,
            "categoryId": entry.category_id,
            "systemId": sap.system_id,
            "systemName": sap.system_name,
            "client": sap.client,
            "language": sap.language,
            "username": username,
            "useKnoxId": entry.use_knox_id,
            "password": entry.password,
            "url": effective_url,
            "ownUrl": entry.url,
            "ownPassword": entry.password,
            "notes": entry.notes,
            "hosts": sap.hosts,
            "domains": sap.hosts,
            "landscapeSource": sap.landscape_source,
            "linkCount": entry.links.len(),
            "sources": sources,
            "sourceUrl": first("url"),
            "sourceUsername": first("username"),
            "sourcePassword": first("password"),
            "effectiveUrl": effective_url,
            "effectiveUsername": effective_username,
            "effectivePassword": effective_password,
            "usernamePassword": format!("{effective_username}{line_separator}{effective_password}"),
            "ruleSummary": entry.rule.as_ref().map(|rule| rule.summary()).unwrap_or_default(),
            "historyCycle": entry.history_cycle,
            "updatedAt": entry.updated_at,
        });
        entries.push(value.clone());
        if entry.category_id == crate::model::SAP_CATEGORY_ID {
            accounts.push(value);
        }
    }

    let accounts_json = serde_json::to_string_pretty(&accounts)?;
    let files_json = serde_json::to_string_pretty(&files)?;

    Ok(json!({
        "app": "SapVault",
        "generatedAt": crate::model::now_string(),
        "knoxId": knox_id,
        "lineSeparator": line_separator,
        "accountCount": accounts.len(),
        "fileCount": files.len(),
        "accounts": accounts,
        "entries": entries,
        "files": files,
        "accountsJson": accounts_json,
        "filesJson": files_json,
    }))
}

// ---------------------------------------------------------------------------
// Minimal mustache-style renderer
//
// Both the UI preview and the file writer call this, so the template language
// exists exactly once. Supported syntax:
//   {{path.to.value}}          variable, rendered raw
//   {{value|json|trim}}        pipe filters: json, upper, lower, trim, raw
//   {{#items}}...{{/items}}    iterate an array, or render when truthy
//   {{^items}}...{{/items}}    render when the value is empty / falsy
// Inside an iteration scope: {{index}}, {{number}}, {{isFirst}}, {{isLast}}
// ---------------------------------------------------------------------------

pub fn render(template: &str, context: &Value) -> AppResult<String> {
    let mut out = String::with_capacity(template.len());
    render_into(template, context, &mut out)?;
    Ok(out)
}

fn render_into(template: &str, scope: &Value, out: &mut String) -> AppResult<()> {
    let mut cursor = 0usize;
    while let Some(relative) = template[cursor..].find("{{") {
        let open = cursor + relative;
        let close = match template[open..].find("}}") {
            Some(offset) => open + offset,
            None => break,
        };
        out.push_str(&template[cursor..open]);
        let token = template[open + 2..close].trim().to_string();
        let body_start = close + 2;

        if let Some(name) = token.strip_prefix('#') {
            let name = name.trim().to_string();
            let (body_end, after) = extract_section(template, body_start, &name)?;
            match resolve(scope, &name) {
                Value::Array(items) => {
                    let total = items.len();
                    for (index, item) in items.iter().enumerate() {
                        let child = with_loop_meta(item, index, total);
                        render_into(&template[body_start..body_end], &child, out)?;
                    }
                }
                ref value if truthy(value) => {
                    render_into(&template[body_start..body_end], scope, out)?;
                }
                _ => {}
            }
            cursor = after;
            continue;
        }

        if let Some(name) = token.strip_prefix('^') {
            let name = name.trim().to_string();
            let (body_end, after) = extract_section(template, body_start, &name)?;
            if !truthy(&resolve(scope, &name)) {
                render_into(&template[body_start..body_end], scope, out)?;
            }
            cursor = after;
            continue;
        }

        if token.starts_with('/') {
            // A stray closing tag is ignored rather than corrupting the output.
            cursor = body_start;
            continue;
        }

        out.push_str(&resolve_token(scope, &token));
        cursor = body_start;
    }
    out.push_str(&template[cursor..]);
    Ok(())
}

/// Returns where the section body ends and where it resumes after the closing
/// tag, honouring nested sections that share the same name.
fn extract_section(template: &str, from: usize, name: &str) -> AppResult<(usize, usize)> {
    let mut depth = 1usize;
    let mut cursor = from;
    while let Some(relative) = template[cursor..].find("{{") {
        let start = cursor + relative;
        let end = match template[start..].find("}}") {
            Some(offset) => start + offset + 2,
            None => break,
        };
        let inner = template[start + 2..end - 2].trim();
        if let Some(open) = inner.strip_prefix('#') {
            if open.trim() == name {
                depth += 1;
            }
        } else if let Some(close) = inner.strip_prefix('/') {
            if close.trim() == name {
                depth -= 1;
                if depth == 0 {
                    return Ok((start, end));
                }
            }
        }
        cursor = end;
    }
    Err(AppError::Msg(format!("模板区块 {{{{#{name}}}}} 缺少结束标签")))
}

fn with_loop_meta(item: &Value, index: usize, total: usize) -> Value {
    let mut object = match item {
        Value::Object(map) => map.clone(),
        other => {
            let mut map = serde_json::Map::new();
            map.insert("value".to_string(), other.clone());
            map.insert(".".to_string(), other.clone());
            map
        }
    };
    object.insert("index".to_string(), json!(index));
    object.insert("number".to_string(), json!(index + 1));
    object.insert("isFirst".to_string(), json!(index == 0));
    object.insert("isLast".to_string(), json!(index + 1 == total));
    Value::Object(object)
}

fn resolve_token(scope: &Value, token: &str) -> String {
    let mut parts = token.split('|');
    let path = parts.next().unwrap_or("").trim().to_string();
    let filters: Vec<String> = parts.map(|filter| filter.trim().to_ascii_lowercase()).collect();
    let value = resolve(scope, &path);
    let mut text = stringify(&value);
    for filter in filters {
        text = match filter.as_str() {
            "json" => serde_json::to_string(&value).unwrap_or_else(|_| "\"\"".to_string()),
            "upper" => text.to_uppercase(),
            "lower" => text.to_lowercase(),
            "trim" => text.trim().to_string(),
            "raw" => text,
            other => match other.strip_prefix("default:") {
                Some(fallback) if text.is_empty() => fallback.to_string(),
                _ => text,
            },
        };
    }
    text
}

pub fn resolve(scope: &Value, path: &str) -> Value {
    if path.is_empty() {
        return scope.clone();
    }
    if path == "." {
        // Scalars in a loop are parked under the "." key by `with_loop_meta`.
        if let Value::Object(map) = scope {
            if let Some(value) = map.get(".") {
                return value.clone();
            }
        }
        return scope.clone();
    }
    let mut current = scope;
    for segment in path.split('.') {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        current = match current {
            Value::Object(map) => match map.get(segment) {
                Some(value) => value,
                None => return Value::Null,
            },
            _ => return Value::Null,
        };
    }
    current.clone()
}

fn stringify(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(stringify)
            .collect::<Vec<_>>()
            .join(", "),
        Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|value| value != 0.0).unwrap_or(true),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

// ---------------------------------------------------------------------------
// Presets & execution
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatePreset {
    pub format: String,
    pub label: String,
    pub description: String,
    pub template: String,
}

pub fn presets() -> Vec<TemplatePreset> {
    vec![
        TemplatePreset {
            format: "mcpJson".to_string(),
            label: "MCP / JSON".to_string(),
            description: "标准 JSON：账号、凭据，以及每个关联文件解析出的字段".to_string(),
            template: r#"{
  "sapVault": {
    "generatedAt": {{generatedAt|json}},
    "knoxId": {{knoxId|json}},
    "accounts": {{accountsJson}},
    "contentFiles": {{filesJson}}
  }
}
"#
            .to_string(),
        },
        TemplatePreset {
            format: "credentialsJson".to_string(),
            label: "凭据清单 (JSON)".to_string(),
            description: "只输出「账号 → 来源文件 → URL/用户名/密码」的扁平清单".to_string(),
            template: r#"{
  "generatedAt": {{generatedAt|json}},
  "credentials": [
{{#accounts}}    {
      "account": {{title|json}},
      "systemId": {{systemId|json}},
      "client": {{client|json}},
      "url": {{effectiveUrl|json}},
      "username": {{effectiveUsername|json}},
      "password": {{effectivePassword|json}},
      "sources": [
{{#sources}}        { "path": {{path|json}}, "format": {{format|json}}, "url": {{url|json}}, "username": {{username|json}}, "password": {{password|json}} }{{^isLast}},{{/isLast}}
{{/sources}}      ]
    }{{^isLast}},{{/isLast}}
{{/accounts}}  ]
}
"#
            .to_string(),
        },
        TemplatePreset {
            format: "dotenv".to_string(),
            label: ".env".to_string(),
            description: "按系统 ID 展开的环境变量".to_string(),
            template: r#"# SapVault 自动生成于 {{generatedAt}}
SAP_KNOX_ID={{knoxId}}
{{#accounts}}SAP_{{systemId}}_URL={{effectiveUrl}}
SAP_{{systemId}}_USER={{effectiveUsername}}
SAP_{{systemId}}_PASSWORD={{effectivePassword}}
SAP_{{systemId}}_CLIENT={{client}}
{{/accounts}}"#
                .to_string(),
        },
        TemplatePreset {
            format: "toml".to_string(),
            label: "TOML".to_string(),
            description: "适合 config.toml 或 MCP 配置片段".to_string(),
            template: r#"knox_id = {{knoxId|json}}
generated_at = {{generatedAt|json}}

{{#accounts}}[[accounts]]
title = {{title|json}}
system_id = {{systemId|json}}
client = {{client|json}}
language = {{language|json}}
url = {{effectiveUrl|json}}
username = {{effectiveUsername|json}}
password = {{effectivePassword|json}}
sources = {{linkCount}}

{{/accounts}}"#
                .to_string(),
        },
        TemplatePreset {
            format: "yaml".to_string(),
            label: "YAML".to_string(),
            description: "适合命令行工具与 CI 配置文件".to_string(),
            template: r#"knoxId: {{knoxId|json}}
generatedAt: {{generatedAt|json}}
accounts:
{{#accounts}}  - title: {{title|json}}
    systemId: {{systemId|json}}
    url: {{effectiveUrl|json}}
    username: {{effectiveUsername|json}}
    password: {{effectivePassword|json}}
    sources:
{{#sources}}      - {{path|json}}
{{/sources}}{{/accounts}}"#
                .to_string(),
        },
        TemplatePreset {
            format: "csv".to_string(),
            label: "CSV".to_string(),
            description: "系统ID、URL、用户名、密码、关联文件数".to_string(),
            template: r#"系统ID,标题,URL,用户名,密码,客户端,关联文件数
{{#accounts}}{{systemId}},{{title}},{{effectiveUrl}},{{effectiveUsername}},{{effectivePassword}},{{client}},{{linkCount}}
{{/accounts}}"#
                .to_string(),
        },
        TemplatePreset {
            format: "plain".to_string(),
            label: "纯文本".to_string(),
            description: "人眼可读的账号清单（含来源文件）".to_string(),
            template: r#"SapVault 导出（{{generatedAt}}）
Knox ID：{{knoxId}}
账号数：{{accountCount}}    来源文件数：{{fileCount}}

{{#accounts}}【{{systemId}} / 客户端 {{client}}】{{title}}
  URL：{{effectiveUrl}}
  用户名：{{effectiveUsername}}
  密码：{{effectivePassword}}
  来源文件：
{{#sources}}    - {{path}}（{{format}}）
{{/sources}}
{{/accounts}}"#
                .to_string(),
        },
    ]
}

pub fn default_target(format: &str) -> SyncTarget {
    let all = presets();
    let preset = all
        .iter()
        .find(|preset| preset.format == format)
        .or_else(|| all.first())
        .cloned()
        .unwrap_or(TemplatePreset {
            format: "json".to_string(),
            label: "JSON".to_string(),
            description: String::new(),
            template: "{{accountsJson}}".to_string(),
        });
    SyncTarget {
        id: crate::model::new_id(),
        name: preset.label.clone(),
        kind: if preset.format.starts_with("mcp") {
            "mcp".to_string()
        } else {
            "custom".to_string()
        },
        path: String::new(),
        format: preset.format,
        enabled: true,
        template: preset.template,
        include_files: true,
        backup: true,
        last_sync_at: None,
        last_status: None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub target_id: String,
    pub path: String,
    pub bytes: usize,
    pub account_count: usize,
    pub file_count: usize,
    pub backup_path: Option<String>,
    pub changed: bool,
    pub content: String,
}

/// Renders the target without touching the disk.
pub fn preview(vault: &Vault, target: &SyncTarget, line_separator: &str) -> AppResult<SyncOutcome> {
    let context = build_context(vault, line_separator)?;
    let content = render(&target.template, &context)?;
    Ok(SyncOutcome {
        target_id: target.id.clone(),
        path: target.path.clone(),
        bytes: content.len(),
        account_count: resolve(&context, "accountCount").as_u64().unwrap_or(0) as usize,
        file_count: resolve(&context, "fileCount").as_u64().unwrap_or(0) as usize,
        backup_path: None,
        changed: true,
        content,
    })
}

/// Renders and writes. A timestamped backup is created unless the target opts
/// out, so a bad template can never silently destroy an existing MCP config.
pub fn execute(vault: &Vault, target: &SyncTarget, line_separator: &str) -> AppResult<SyncOutcome> {
    if target.path.trim().is_empty() {
        return Err(AppError::Msg("同步目标未设置文件路径".to_string()));
    }
    let mut outcome = preview(vault, target, line_separator)?;
    let path = std::path::PathBuf::from(target.path.trim());
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let existing = std::fs::read_to_string(&path).ok();
    outcome.changed = existing.as_deref() != Some(outcome.content.as_str());
    if !outcome.changed {
        return Ok(outcome);
    }

    if target.backup && existing.is_some() {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let extension = path
            .extension()
            .map(|value| format!("{}.", value.to_string_lossy()))
            .unwrap_or_default();
        let backup = path.with_extension(format!("{extension}bak-{stamp}"));
        if std::fs::copy(&path, &backup).is_ok() {
            outcome.backup_path = Some(backup.to_string_lossy().to_string());
        }
    }

    std::fs::write(&path, outcome.content.as_bytes())?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use crate::keys;
    use crate::model::{Category, ContentLink, KeyMapping, PasswordRule, SapAccount};

    fn sap_entry(id: &str, title: &str, sid: &str) -> Entry {
        Entry {
            id: id.to_string(),
            title: title.to_string(),
            category_id: crate::model::SAP_CATEGORY_ID.to_string(),
            username: "JDOE".to_string(),
            use_knox_id: false,
            password: "S3cret!".to_string(),
            url: String::new(),
            notes: String::new(),
            favorite: false,
            sap: Some(SapAccount {
                system_id: sid.to_string(),
                client: "100".to_string(),
                language: "ZH".to_string(),
                hosts: vec!["prd.sap.corp.example".to_string()],
                ..Default::default()
            }),
            rule: Some(PasswordRule::default()),
            history_cycle: 5,
            password_history: Vec::new(),
            links: Vec::new(),
            created_at: "2026-01-01T00:00:00+08:00".to_string(),
            updated_at: "2026-01-01T00:00:00+08:00".to_string(),
            last_used_at: None,
        }
    }

    fn analyzed_link(path: &str, text: &str, format: &str) -> ContentLink {
        let mapping = KeyMapping::default();
        let parse = keys::analyze_text(text, format, &mapping);
        ContentLink::from_path(path, mapping, Some(parse))
    }

    fn sample_vault() -> Vault {
        let mut vault = Vault {
            categories: vec![Category::sap(), Category::general()],
            knox_id: "KNOX01".to_string(),
            ..Vault::default()
        };
        let mut first = sap_entry("e1", "生产系统", "PRD");
        first.links.push(analyzed_link(
            "C:/demo/sap.json",
            "{\"url\":\"https://prd.corp.example\",\"username\":\"FILEUSER\",\"password\":\"FILEPASS\"}",
            "json",
        ));
        vault.entries.push(first);

        let mut second = sap_entry("e2", "Knox 账号", "DEV");
        second.use_knox_id = true;
        second.username = "ignored".to_string();
        second.url = String::new();
        second.password = String::new();
        second.links.push(analyzed_link(
            "C:/demo/.env",
            "SAP_URL=https://dev.corp.example\nSAP_USER=ENVUSER\nSAP_PASSWORD=ENVPASS\n",
            "env",
        ));
        vault.entries.push(second);
        vault
    }

    #[test]
    fn renders_variables_filters_and_sections() {
        let context = build_context(&sample_vault(), "\r\n").unwrap();
        assert_eq!(render("{{knoxId}}", &context).unwrap(), "KNOX01");
        assert_eq!(render("{{knoxId|lower}}", &context).unwrap(), "knox01");
        assert_eq!(render("{{knoxId|json}}", &context).unwrap(), "\"KNOX01\"");
        assert_eq!(
            render("{{#accounts}}{{systemId}};{{/accounts}}", &context).unwrap(),
            "PRD;DEV;"
        );
        assert_eq!(
            render("{{^missing}}none{{/missing}}", &context).unwrap(),
            "none"
        );
        assert_eq!(
            render("{{^accounts}}empty{{/accounts}}", &context).unwrap(),
            ""
        );
    }

    #[test]
    fn account_values_fall_back_to_the_parsed_files() {
        let context = build_context(&sample_vault(), "\r\n").unwrap();
        assert_eq!(
            render("{{#entries}}{{effectiveUrl}}|{{effectiveUsername}}|{{effectivePassword}};{{/entries}}", &context)
                .unwrap(),
            "https://prd.corp.example|JDOE|S3cret!;https://dev.corp.example|KNOX01|ENVPASS;"
        );
    }

    #[test]
    fn per_file_sources_are_exposed() {
        let context = build_context(&sample_vault(), "\r\n").unwrap();
        assert_eq!(
            render("{{#accounts}}{{#sources}}{{format}}:{{username}}/{{password}};{{/sources}}{{/accounts}}", &context)
                .unwrap(),
            "json:FILEUSER/FILEPASS;env:ENVUSER/ENVPASS;"
        );
    }

    #[test]
    fn knox_id_replaces_the_stored_username() {
        let context = build_context(&sample_vault(), "\r\n").unwrap();
        assert_eq!(
            render("{{#accounts}}{{username}},{{/accounts}}", &context).unwrap(),
            "JDOE,KNOX01,"
        );
    }

    #[test]
    fn every_preset_renders_and_json_presets_stay_valid() {
        let vault = sample_vault();
        let context = build_context(&vault, "\r\n").unwrap();
        for preset in presets() {
            let output = render(&preset.template, &context)
                .unwrap_or_else(|err| panic!("{} 渲染失败: {err}", preset.format));
            assert!(!output.is_empty(), "{} 输出为空", preset.format);
            if preset.format.ends_with("Json") {
                let parsed: Value = serde_json::from_str(&output)
                    .unwrap_or_else(|err| panic!("{} 不是合法 JSON: {err}\n{output}", preset.format));
                assert!(parsed.is_object());
            }
        }
    }

    #[test]
    fn nested_sections_are_balanced() {
        let context = json!({"items":[{"name":"a","subs":[1,2]},{"name":"b","subs":[]}]});
        let output = render(
            "{{#items}}{{name}}:{{#subs}}{{.}}{{/subs}};{{/items}}",
            &context,
        )
        .unwrap();
        assert_eq!(output, "a:12;b:;");
    }

    #[test]
    fn missing_section_close_is_reported() {
        assert!(render("{{#items}}oops", &json!({})).is_err());
    }

    #[test]
    fn execute_writes_the_file_and_keeps_a_backup() {
        let dir = std::env::temp_dir().join(format!("sapvault-sync-{}", crate::model::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mcp.json");
        std::fs::write(&path, "{\"old\":true}").unwrap();

        let vault = sample_vault();
        let mut target = default_target("mcpJson");
        target.path = path.to_string_lossy().to_string();
        target.backup = true;

        let outcome = execute(&vault, &target, "\r\n").unwrap();
        assert!(outcome.changed);
        assert!(outcome.backup_path.is_some());
        assert!(std::fs::read_to_string(&path).unwrap().contains("KNOX01"));

        let second = execute(&vault, &target, "\r\n").unwrap();
        assert!(!second.changed, "unchanged content should not be rewritten");
    }

    #[test]
    fn missing_path_is_rejected() {
        let vault = sample_vault();
        let target = default_target("plain");
        assert!(execute(&vault, &target, "\r\n").is_err());
    }

    #[test]
    fn resolve_handles_dot_paths() {
        let context = json!({"a":{"b":{"c":42}}});
        assert_eq!(stringify(&resolve(&context, "a.b.c")), "42");
        assert!(resolve(&context, "a.nope").is_null());
        assert_eq!(stringify(&resolve(&json!([1, 2]), ".")), "1, 2");
    }

    #[test]
    fn presets_are_discoverable_by_format() {
        let formats: HashMap<String, String> = presets()
            .into_iter()
            .map(|preset| (preset.format, preset.template))
            .collect();
        assert!(formats.contains_key("mcpJson"));
        assert!(formats.contains_key("credentialsJson"));
        assert_eq!(default_target("csv").format, "csv");
        assert_eq!(default_target("nope").kind, "mcp");
    }
}
