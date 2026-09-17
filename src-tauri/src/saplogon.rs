//! Reads the SAP GUI logon configuration so an account can be started with one
//! click.
//!
//! SAP GUI for Windows keeps every configured system in
//! `%APPDATA%\SAP\Common\SAPUILandscape.xml` (plus `SAPUILandscapeGlobal.xml`,
//! which is pulled in through an `<Includes>` entry). The layout written by
//! transaction RSLSMT / SAP GUI 7.70+ looks like this:
//!
//! ```xml
//! <Landscape version="1" updated="…" generator="RSLSMT">
//!   <Workspaces><Workspace name="生产"><Node name="财务">
//     <Item uuid="…" serviceid="<service uuid>"/>
//   </Node></Workspace></Workspaces>
//   <Services>
//     <!-- 方式 1：直接填应用服务器 -->
//     <Service uuid="…" name="PRD" server="sap-prd.example:3200" type="SAPGUI" systemid="PRD"/>
//     <!-- 方式 2：登录组（负载均衡），server 是组名，msid 指向消息服务器 -->
//     <Service uuid="…" name="P20 组" server="SPACE" msid="<messageserver uuid>"
//              type="SAPGUI" systemid="P20"/>
//   </Services>
//   <Routers><Router uuid="…" router="/H/saprouter.example"/></Routers>
//   <Messageservers><Messageserver uuid="…" host="sapms.example" port="3600"/></Messageservers>
// </Landscape>
//! ```
//!
//! Two things matter in practice and are handled below: a system ID is **not**
//! unique (the same SID can appear several times with different servers), and a
//! host can come from four different places (`server`, a message server via
//! `msid`, a router, or a URL for Fiori/NWBC entries).
//!
//! Field reference: SAP Help Portal → *SAP UI Landscape* → "SAP UI Landscape XML
//! Description"
//! (<https://help.sap.com/saphelp_tm92/helpdata/de/d5/66efdfdd0c47bab00b5031a4e1b580/content.htm>).
//! It documents `Messageservers`, `Routers`, `Services`, `Workspaces`/`Node`/
//! `Item`, `Includes`, the `server` attribute as "group or hostname:port", the
//! optional `sapguiid` back-reference of a saved SAP GUI shortcut, and router
//! strings such as `/H/sapgateway.mycorp.com/S/3456/H/`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::Serialize;

/// Guards against a landscape that includes itself in a loop.
const MAX_INCLUDE_DEPTH: usize = 4;
/// Default port of a saprouter; used only when the landscape omits one.
const DEFAULT_ROUTER_PORT: &str = "3299";

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SapSystem {
    /// `uuid` of the `<Service>`; lets the UI pin one entry when a SID repeats.
    pub service_uuid: String,
    /// Name shown in SAP Logon.
    pub name: String,
    pub system_id: String,
    /// `type` attribute: `SAPGUI`, `Reference`, `FIORI`, `NWBC`, …
    pub entry_type: String,
    /// `applicationServer` | `serverGroup` | `web` | `other`
    pub kind: String,
    /// Raw `server` attribute (`host:port`, or the logon group name).
    pub server: String,
    pub host: String,
    pub port: String,
    /// SAP instance number derived from the port (`3200` → `00`).
    pub instance: String,
    pub message_server: String,
    pub message_server_port: String,
    /// Logon group for `serverGroup` entries (SAP's default is `SPACE`).
    pub group: String,
    pub router: String,
    pub url: String,
    /// Connection string handed to `sapshcut -guiparm`.
    pub guiparm: String,
    /// Workspace / node path inside SAP Logon, when the file defines one.
    pub workspace: String,
    pub source_file: String,
    /// Only set on `Reference` entries (a saved shortcut).
    pub client: String,
    pub language: String,
    pub user: String,
    /// `sapguiid`: a saved shortcut points at the SAP GUI connection it copies.
    pub sapgui_id: String,
}

impl SapSystem {
    /// True when the entry can be started with `sapshcut.exe`.
    pub fn is_launchable(&self) -> bool {
        !self.system_id.trim().is_empty()
            && (self.kind == "applicationServer" || self.kind == "serverGroup")
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Landscape {
    /// Files that were read, in the order they were merged.
    pub files: Vec<String>,
    pub systems: Vec<SapSystem>,
    /// Files that were searched but missing, plus anything unreadable.
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Where the configuration lives
// ---------------------------------------------------------------------------

/// `%APPDATA%\SAP\Common\SAPUILandscape*.xml`, most specific file first.
pub fn default_landscape_paths() -> Vec<PathBuf> {
    let Some(app_data) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    let common = PathBuf::from(app_data).join("SAP").join("Common");
    vec![
        common.join("SAPUILandscape.xml"),
        common.join("SAPUILandscapeGlobal.xml"),
    ]
}

/// Loads every landscape file, following `<Includes>` links (SAP keeps
/// system-wide entries in `SAPUILandscapeGlobal.xml`).
pub fn load(extra_paths: &[String]) -> Landscape {
    let mut landscape = Landscape::default();
    let mut queue: Vec<(PathBuf, usize)> = default_landscape_paths()
        .into_iter()
        .map(|path| (path, 0))
        .collect();
    for extra in extra_paths {
        let trimmed = extra.trim();
        if !trimmed.is_empty() {
            queue.push((PathBuf::from(trimmed), 0));
        }
    }

    let mut seen: Vec<PathBuf> = Vec::new();
    let mut services: Vec<RawService> = Vec::new();
    let mut routers: HashMap<String, String> = HashMap::new();
    let mut messages: HashMap<String, MessageServer> = HashMap::new();
    let mut items: Vec<(String, String)> = Vec::new();

    while let Some((path, depth)) = queue.pop() {
        if depth > MAX_INCLUDE_DEPTH {
            continue;
        }
        if !path.exists() {
            // The default paths are allowed to be absent (SAP GUI not installed);
            // anything the user typed in is worth reporting.
            if depth == 0 && !is_default_path(&path) {
                landscape
                    .warnings
                    .push(format!("找不到文件：{}", path.display()));
            }
            continue;
        }
        let key = path.canonicalize().unwrap_or_else(|_| path.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);

        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) => {
                landscape
                    .warnings
                    .push(format!("无法读取 {}：{err}", path.display()));
                continue;
            }
        };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let source = path.to_string_lossy().to_string();
        landscape.files.push(source.clone());

        let mut collector = Collector::default();
        collector.run(&text, &source, &mut landscape.warnings);
        for include in collector.includes {
            match classify_include(&include) {
                IncludeSource::Local(path) => queue.push((path, depth + 1)),
                // SapVault never talks to the network, not even for an include.
                IncludeSource::Remote(url) => landscape
                    .warnings
                    .push(format!("已跳过远程 include（本程序不联网）：{url}")),
                IncludeSource::Ignored => {}
            }
        }
        services.extend(collector.services);
        routers.extend(collector.routers);
        messages.extend(collector.messages);
        items.extend(collector.items);
    }

    let mut systems: Vec<SapSystem> = services
        .iter()
        .map(|service| resolve(service, &routers, &messages, &items))
        .collect();
    resolve_shortcut_references(&mut systems);
    systems.sort_by(|left, right| {
        launch_rank(left)
            .cmp(&launch_rank(right))
            .then_with(|| left.system_id.to_lowercase().cmp(&right.system_id.to_lowercase()))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    landscape.systems = systems;
    landscape
}

fn is_default_path(path: &Path) -> bool {
    default_landscape_paths().iter().any(|known| known == path)
}

fn launch_rank(system: &SapSystem) -> u8 {
    if system.is_launchable() {
        0
    } else if system.entry_type.eq_ignore_ascii_case("SAPGUI") {
        1
    } else {
        2
    }
}

/// Picks the landscape entry that matches an account: an explicit service UUID
/// wins, otherwise a unique system ID is used.
pub fn find_system<'a>(
    systems: &'a [SapSystem],
    service_uuid: &str,
    system_id: &str,
) -> Option<&'a SapSystem> {
    if !service_uuid.trim().is_empty() {
        if let Some(found) = systems.iter().find(|system| system.service_uuid == service_uuid) {
            return Some(found);
        }
    }
    let wanted = system_id.trim();
    if wanted.is_empty() {
        return None;
    }
    let matches: Vec<&SapSystem> = systems
        .iter()
        .filter(|system| system.system_id.eq_ignore_ascii_case(wanted) && system.is_launchable())
        .collect();
    if matches.len() == 1 {
        matches.first().copied()
    } else {
        None
    }
}

/// How many landscape entries carry this system ID (a repeated SID means the
/// connection string has to be pinned explicitly).
pub fn count_system_id(systems: &[SapSystem], system_id: &str) -> usize {
    systems
        .iter()
        .filter(|system| system.system_id.eq_ignore_ascii_case(system_id.trim()))
        .count()
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
struct RawService {
    attrs: HashMap<String, String>,
    /// Values written as child elements (older landscape layouts).
    nested: HashMap<String, String>,
    source: String,
}

impl RawService {
    fn get(&self, key: &str) -> String {
        let key = key.to_ascii_lowercase();
        self.attrs
            .get(&key)
            .or_else(|| self.nested.get(&key))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_default()
    }

    fn get_any(&self, keys: &[&str]) -> String {
        keys.iter()
            .map(|key| self.get(key))
            .find(|value| !value.is_empty())
            .unwrap_or_default()
    }
}

#[derive(Debug, Default, Clone)]
struct MessageServer {
    host: String,
    port: String,
}

#[derive(Default)]
struct Collector {
    services: Vec<RawService>,
    routers: HashMap<String, String>,
    messages: HashMap<String, MessageServer>,
    includes: Vec<String>,
    /// serviceid → "workspace / node"
    items: Vec<(String, String)>,
    /// Open `<Workspace>` / `<Node>` names.
    location: Vec<String>,
    /// Set while a `<Service>` is open.
    current: Option<RawService>,
    /// Stack depth the current service started at.
    service_level: Option<usize>,
    /// Child element whose text belongs into `current.nested`.
    pending: Option<String>,
}

impl Collector {
    fn run(&mut self, text: &str, source: &str, warnings: &mut Vec<String>) {
        let mut reader = Reader::from_str(text);
        reader.config_mut().trim_text(true);
        let mut stack: Vec<String> = Vec::new();

        loop {
            match reader.read_event() {
                Ok(Event::Start(element)) => {
                    let name = local_name(element.local_name().as_ref());
                    self.on_open(&name, &element, source, stack.len(), false);
                    stack.push(name);
                }
                Ok(Event::Empty(element)) => {
                    let name = local_name(element.local_name().as_ref());
                    self.on_open(&name, &element, source, stack.len(), true);
                }
                Ok(Event::Text(chunk)) => {
                    if let Some(key) = self.pending.clone() {
                        let value = unescape_text(&chunk);
                        let value = value.trim().to_string();
                        if !value.is_empty() {
                            if let Some(service) = self.current.as_mut() {
                                service.nested.entry(key).or_insert(value);
                            }
                            self.pending = None;
                        }
                    }
                }
                Ok(Event::End(element)) => {
                    let name = local_name(element.local_name().as_ref());
                    stack.pop();
                    if name == "workspace" || name == "node" {
                        self.location.pop();
                    }
                    if let Some(level) = self.service_level {
                        // The `</Service>` that closes the open element brings the
                        // stack back to the depth the service started at.
                        if stack.len() <= level {
                            if let Some(service) = self.current.take() {
                                self.services.push(service);
                            }
                            self.service_level = None;
                        }
                    }
                }
                Ok(Event::Eof) => break,
                Err(err) => {
                    warnings.push(format!("XML 解析中断：{err}"));
                    break;
                }
                _ => {}
            }
        }
        if let Some(service) = self.current.take() {
            self.services.push(service);
        }
    }

    fn on_open(
        &mut self,
        name: &str,
        element: &BytesStart<'_>,
        source: &str,
        depth: usize,
        is_empty: bool,
    ) {
        let attrs = attributes(element);
        match name {
            "service" => {
                let service = RawService {
                    attrs,
                    nested: HashMap::new(),
                    source: source.to_string(),
                };
                if is_empty {
                    // `<Service …/>` carries everything in its attributes.
                    self.services.push(service);
                } else {
                    self.current = Some(service);
                    self.service_level = Some(depth);
                }
                return;
            }
            "router" => {
                let uuid = attr(&attrs, "uuid");
                let router = attr(&attrs, "router");
                if !uuid.is_empty() && !router.is_empty() {
                    self.routers.insert(uuid, router);
                }
            }
            "messageserver" => {
                let uuid = attr(&attrs, "uuid");
                if !uuid.is_empty() {
                    self.messages.insert(
                        uuid,
                        MessageServer {
                            host: attr(&attrs, "host"),
                            port: attr(&attrs, "port"),
                        },
                    );
                }
            }
            "include" => {
                let url = attr(&attrs, "url");
                if !url.is_empty() {
                    self.includes.push(url);
                }
            }
            "workspace" | "node" => {
                let label = attr(&attrs, "name");
                self.location.push(label);
            }
            "item" => {
                let service_id = attr(&attrs, "serviceid");
                if !service_id.is_empty() {
                    let location = self
                        .location
                        .iter()
                        .filter(|part| !part.is_empty())
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(" / ");
                    self.items.push((service_id, location));
                }
            }
            _ => {}
        }

        if let Some(service) = self.current.as_mut() {
            match name {
                "service" => {}
                // Older layouts nest the connection data as elements.
                "connection" => {
                    for (key, value) in attrs {
                        service.attrs.entry(key).or_insert(value);
                    }
                }
                "system" => {
                    let id = attr(&attrs, "id");
                    if !id.is_empty() {
                        service.attrs.entry("systemid".to_string()).or_insert(id);
                    }
                }
                "server" | "systemid" | "system_id" | "client" | "language" | "user" | "name"
                | "url" | "routerid" | "msid" | "description" => {
                    let inline = attr(&attrs, "value");
                    if !inline.is_empty() {
                        service
                            .attrs
                            .entry(name.to_string())
                            .or_insert(inline);
                    } else {
                        // The text of this element (if any) is captured on the
                        // next Text event.
                        self.pending = Some(name.to_string());
                    }
                }
                _ => {}
            }
        }
    }
}

/// Local (namespace-stripped, lower-case) element name.
fn local_name(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let local = text.rsplit(':').next().unwrap_or(&text);
    local.to_ascii_lowercase()
}

/// Element text with the five predefined XML entities resolved.
fn unescape_text(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    if !text.contains('&') {
        return text.into_owned();
    }
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn attributes(element: &BytesStart<'_>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for attribute in element.attributes().flatten() {
        let key = local_name(attribute.key.local_name().as_ref());
        let value = attribute
            .unescape_value()
            .map(|value| value.into_owned())
            .unwrap_or_default();
        out.insert(key, value);
    }
    out
}

fn attr(attrs: &HashMap<String, String>, key: &str) -> String {
    attrs
        .get(key)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

/// `file:///C:/Users/x/SAPUILandscapeGlobal.xml` → `C:\Users\x\...`
enum IncludeSource {
    Local(PathBuf),
    Remote(String),
    Ignored,
}

/// Splits includes into local files we can read and anything we must not follow
/// (an `http(s)://` include would mean a network request).
fn classify_include(url: &str) -> IncludeSource {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return IncludeSource::Ignored;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return IncludeSource::Remote(trimmed.to_string());
    }
    match include_to_path(trimmed) {
        Some(path) => IncludeSource::Local(path),
        None => IncludeSource::Ignored,
    }
}

fn include_to_path(url: &str) -> Option<PathBuf> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_scheme = trimmed
        .strip_prefix("file:///")
        .or_else(|| trimmed.strip_prefix("file://"))
        .unwrap_or(trimmed);
    let decoded = percent_decode(without_scheme);
    if decoded.is_empty() {
        return None;
    }
    Some(PathBuf::from(decoded.replace('/', "\\")))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// Resolving a service into something we can launch
// ---------------------------------------------------------------------------

fn resolve(
    service: &RawService,
    routers: &HashMap<String, String>,
    messages: &HashMap<String, MessageServer>,
    items: &[(String, String)],
) -> SapSystem {
    let uuid = service.get("uuid");
    let server = service.get("server");
    let msid = service.get("msid");
    let router_id = service.get("routerid");
    let url = service.get("url");

    let mut system = SapSystem {
        service_uuid: uuid.clone(),
        name: service.get_any(&["name", "description"]),
        system_id: service.get_any(&["systemid", "system_id", "sid"]),
        entry_type: service.get("type"),
        server: server.clone(),
        url: url.clone(),
        client: service.get("client"),
        language: service.get("language"),
        user: service.get("user"),
        sapgui_id: service.get("sapguiid"),
        source_file: service.source.clone(),
        ..Default::default()
    };
    if system.name.is_empty() {
        system.name = system.system_id.clone();
    }
    system.workspace = items
        .iter()
        .find(|(service_id, _)| service_id == &uuid)
        .map(|(_, location)| location.clone())
        .unwrap_or_default();

    let (mut host, mut port) = split_host_port(&server);
    if !msid.is_empty() {
        // Logon group: the `server` attribute is the group name (SAP's default
        // group is literally called SPACE) and the host comes from the message
        // server this entry points at.
        system.kind = "serverGroup".to_string();
        system.group = if server.trim().is_empty() {
            "SPACE".to_string()
        } else {
            server.trim().to_string()
        };
        if let Some(message) = messages.get(&msid) {
            system.message_server = message.host.clone();
            system.message_server_port = message.port.clone();
            host = message.host.clone();
            port = message.port.clone();
        }
    } else if !host.is_empty() {
        system.kind = "applicationServer".to_string();
    } else if !url.trim().is_empty() {
        system.kind = "web".to_string();
        host = host_from_url(&url);
    } else {
        system.kind = "other".to_string();
    }

    system.host = host.clone();
    system.port = port.clone();
    system.instance = instance_from_port(&port);

    if let Some(router) = routers.get(&router_id) {
        system.router = router.clone();
    }
    system.guiparm = connection_string(&system, &host, &port);
    system
}

/// A saved SAP GUI shortcut (`type="SAPGUI"` with `sapguiid`, or `Reference`)
/// stores no server of its own — it points at the connection it was created
/// from. Copy that connection's target so the shortcut is launchable too.
fn resolve_shortcut_references(systems: &mut [SapSystem]) {
    let snapshot: Vec<SapSystem> = systems.to_vec();
    // Bounded passes: a shortcut may reference another shortcut.
    for _ in 0..3 {
        let mut changed = false;
        for system in systems.iter_mut() {
            if !system.guiparm.trim().is_empty() || system.sapgui_id.trim().is_empty() {
                continue;
            }
            let Some(source) = snapshot
                .iter()
                .find(|candidate| candidate.service_uuid == system.sapgui_id)
            else {
                continue;
            };
            if source.kind != "applicationServer" && source.kind != "serverGroup" {
                continue;
            }
            if source.guiparm.trim().is_empty() {
                continue;
            }
            system.kind = source.kind.clone();
            system.server = source.server.clone();
            system.host = source.host.clone();
            system.port = source.port.clone();
            system.instance = source.instance.clone();
            system.message_server = source.message_server.clone();
            system.message_server_port = source.message_server_port.clone();
            system.group = source.group.clone();
            system.router = source.router.clone();
            system.guiparm = source.guiparm.clone();
            changed = true;
        }
        if !changed {
            break;
        }
    }
}

/// `sap-prd.example:3200` → `("sap-prd.example", "3200")`.
fn split_host_port(value: &str) -> (String, String) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return (String::new(), String::new());
    }
    match trimmed.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (host.to_string(), port.to_string())
        }
        _ => (trimmed.to_string(), String::new()),
    }
}

/// `3300` → `01`; anything that is not `<3200 + 100n>` yields an empty string.
fn instance_from_port(port: &str) -> String {
    let Ok(port) = port.trim().parse::<u32>() else {
        return String::new();
    };
    if port < 3200 {
        return String::new();
    }
    let offset = port - 3200;
    if offset % 100 != 0 {
        return String::new();
    }
    format!("{:02}", offset / 100)
}

fn host_from_url(url: &str) -> String {
    let trimmed = url.trim();
    let rest = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    host_port.split(':').next().unwrap_or("").to_string()
}

/// Builds the `/H/…/S/…` connection string SAP GUI accepts as `-guiparm`.
///
/// * application server → `/H/<host>/S/<port>`
/// * logon group → `/H/<message server>/S/<port>/G/<group>`
/// * with a saprouter the router hop is prepended.
fn connection_string(system: &SapSystem, host: &str, port: &str) -> String {
    let host = host.trim();
    let port = port.trim();
    let mut out = router_prefix(&system.router);
    if host.is_empty() {
        return out;
    }
    if out.is_empty() {
        out.push_str("/H/");
    }
    // `router_prefix` always ends with `/H/`, so the target hop follows directly.
    out.push_str(host);
    if !port.is_empty() {
        out.push_str(&format!("/S/{port}"));
    }
    if system.kind == "serverGroup" && !system.group.trim().is_empty() {
        out.push_str(&format!("/G/{}", system.group.trim()));
    }
    out
}

/// `Router@router` comes in three shapes: `/H/gateway.example`,
/// `/H/gateway.example/S/3456` and the prefix form
/// `/H/gateway.example/S/3456/H/` (the last one is what SAP's own documentation
/// shows). All three end up as a prefix the target hop appends to.
fn router_prefix(router: &str) -> String {
    let trimmed = router.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if !trimmed.starts_with("/H/") {
        return format!("/H/{trimmed}/S/{DEFAULT_ROUTER_PORT}/H/");
    }
    if trimmed.ends_with("/H/") {
        return trimmed.to_string();
    }
    if trimmed.contains("/S/") {
        return format!("{trimmed}/H/");
    }
    format!("{trimmed}/S/{DEFAULT_ROUTER_PORT}/H/")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<Landscape version="1" updated="20260101000000" origin="" generator="RSLSMT">
  <Workspaces>
    <Workspace name="生产系统" uuid="w-1" expanded="1">
      <Node name="财务" uuid="n-1">
        <Item uuid="i-1" serviceid="s-prd"/>
      </Node>
    </Workspace>
  </Workspaces>
  <Services>
    <Service uuid="s-prd" name="PRD 生产机" server="sap-prd.example.com:3200" type="SAPGUI"
             sncop="-1" mode="1" systemid="PRD" dcpg="2" sapcpg="1100"/>
    <Service uuid="s-p20" name="P20 登录组" server="SPACE" msid="m-1" type="SAPGUI" systemid="P20"/>
    <Service uuid="s-iqb" name="IQB 直接连接" server="10.1.101.82:3300" type="SAPGUI" systemid="IQB"/>
    <Service uuid="s-dev" name="DEV 开发机" server="dev.example.com:3200" type="SAPGUI" systemid="DEV"/>
    <Service uuid="s-dev-sc" name="DEV 快捷方式" type="SAPGUI" systemid="DEV" sapguiid="s-dev"
             client="300" language="EN" user="SHORTCUTUSER"/>
    <Service uuid="s-web" name="Fiori" type="FIORI" url="https://fiori.example.com/sap/bc/ui5_ui5"/>
    <Service uuid="s-ref" name="PRD 快捷方式" type="Reference" systemid="PRD" client="100"
             user="TESTUSER" language="ZH"/>
  </Services>
  <Routers>
    <Router name="/H/saprouter.example" uuid="r-1" router="/H/saprouter.example"/>
    <Router name="/H/sapgateway.example/S/3456/H/" uuid="r-2" router="/H/sapgateway.example/S/3456/H/"/>
  </Routers>
  <Messageservers>
    <Messageserver name="P20" uuid="m-1" host="sapms.example.com" port="3600"/>
  </Messageservers>
</Landscape>"#;

    fn collect(xml: &str) -> Vec<SapSystem> {
        let mut collector = Collector::default();
        let mut warnings = Vec::new();
        collector.run(xml, "sample.xml", &mut warnings);
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        let routers = collector.routers.clone();
        let messages = collector.messages.clone();
        let items = collector.items.clone();
        let mut systems: Vec<SapSystem> = collector
            .services
            .iter()
            .map(|service| resolve(service, &routers, &messages, &items))
            .collect();
        resolve_shortcut_references(&mut systems);
        systems
    }

    fn system<'a>(systems: &'a [SapSystem], id: &str) -> &'a SapSystem {
        systems
            .iter()
            .find(|system| system.system_id == id)
            .unwrap_or_else(|| panic!("system {id} missing"))
    }

    #[test]
    fn parses_an_application_server_entry() {
        let systems = collect(SAMPLE);
        let prd = system(&systems, "PRD");
        assert_eq!(prd.kind, "applicationServer");
        assert_eq!(prd.host, "sap-prd.example.com");
        assert_eq!(prd.port, "3200");
        assert_eq!(prd.instance, "00");
        assert_eq!(prd.guiparm, "/H/sap-prd.example.com/S/3200");
        assert_eq!(prd.workspace, "生产系统 / 财务");
        assert!(prd.is_launchable());
    }

    #[test]
    fn parses_a_logon_group_entry_through_the_message_server() {
        let systems = collect(SAMPLE);
        let p20 = system(&systems, "P20");
        assert_eq!(p20.kind, "serverGroup");
        assert_eq!(p20.group, "SPACE");
        assert_eq!(p20.message_server, "sapms.example.com");
        assert_eq!(p20.message_server_port, "3600");
        assert_eq!(p20.host, "sapms.example.com");
        assert_eq!(p20.guiparm, "/H/sapms.example.com/S/3600/G/SPACE");
    }

    #[test]
    fn derives_the_instance_number_from_the_port() {
        let systems = collect(SAMPLE);
        let iqb = system(&systems, "IQB");
        assert_eq!(iqb.instance, "01");
        assert_eq!(iqb.port, "3300");
    }

    #[test]
    fn reads_web_entries_and_saved_shortcuts() {
        let systems = collect(SAMPLE);
        let web = systems
            .iter()
            .find(|system| system.entry_type == "FIORI")
            .expect("fiori entry");
        assert_eq!(web.kind, "web");
        assert_eq!(web.host, "fiori.example.com");
        assert!(!web.is_launchable());

        let reference = systems
            .iter()
            .find(|system| system.entry_type == "Reference")
            .expect("reference entry");
        assert_eq!(reference.client, "100");
        assert_eq!(reference.user, "TESTUSER");
        assert_eq!(reference.language, "ZH");
    }

    #[test]
    fn repeated_system_ids_stay_separate() {
        let systems = collect(SAMPLE);
        assert_eq!(count_system_id(&systems, "PRD"), 2);
        // Only one of the two PRD entries is a real connection, so the SID alone
        // still resolves — but pinning the UUID must win.
        let by_sid = find_system(&systems, "", "PRD").expect("unique launchable entry");
        assert_eq!(by_sid.kind, "applicationServer");
        let pinned = find_system(&systems, "s-ref", "PRD").expect("pinned by uuid");
        assert_eq!(pinned.entry_type, "Reference");
        // A unique SID resolves without help.
        assert_eq!(find_system(&systems, "", "P20").unwrap().service_uuid, "s-p20");
    }

    #[test]
    fn ambiguous_system_ids_are_reported_as_such() {
        let ambiguous = r#"<Landscape>
  <Services>
    <Service uuid="a" name="A" server="a.example.com:3200" type="SAPGUI" systemid="LMS"/>
    <Service uuid="b" name="B" server="b.example.com:3200" type="SAPGUI" systemid="LMS"/>
  </Services>
</Landscape>"#;
        let systems = collect(ambiguous);
        assert_eq!(count_system_id(&systems, "LMS"), 2);
        assert!(find_system(&systems, "", "LMS").is_none());
        assert_eq!(find_system(&systems, "b", "LMS").unwrap().host, "b.example.com");
    }

    #[test]
    fn routers_are_prepended_to_the_connection_string() {
        let router = SapSystem {
            router: "/H/router.example".to_string(),
            ..Default::default()
        };
        assert_eq!(
            connection_string(&router, "sap.example.com", "3200"),
            "/H/router.example/S/3299/H/sap.example.com/S/3200"
        );
        let with_port = SapSystem {
            router: "/H/router.example/S/3298".to_string(),
            ..Default::default()
        };
        assert_eq!(
            connection_string(&with_port, "sap.example.com", "3200"),
            "/H/router.example/S/3298/H/sap.example.com/S/3200"
        );
        // The prefix form from SAP's own documentation example.
        let documented = SapSystem {
            router: "/H/sapgateway.mycorp.com/S/3456/H/".to_string(),
            ..Default::default()
        };
        assert_eq!(
            connection_string(&documented, "sap.example.com", "3200"),
            "/H/sapgateway.mycorp.com/S/3456/H/sap.example.com/S/3200"
        );
    }

    #[test]
    fn saved_shortcuts_inherit_the_connection_they_point_at() {
        let systems = collect(SAMPLE);
        let shortcut = systems
            .iter()
            .find(|system| system.service_uuid == "s-dev-sc")
            .expect("shortcut entry");
        // The shortcut itself has no server, only a `sapguiid` back-reference.
        assert_eq!(shortcut.sapgui_id, "s-dev");
        assert_eq!(shortcut.host, "dev.example.com");
        assert_eq!(shortcut.guiparm, "/H/dev.example.com/S/3200");
        assert!(shortcut.is_launchable());
        // Its own user/client/language survive the merge.
        assert_eq!(shortcut.client, "300");
        assert_eq!(shortcut.user, "SHORTCUTUSER");
        assert_eq!(shortcut.system_id, "DEV");
        assert_eq!(shortcut.name, "DEV 快捷方式");
    }

    #[test]
    fn a_system_reachable_through_a_router_gets_the_full_chain() {
        let xml = r#"<Landscape>
  <Routers>
    <Router uuid="r-9" name="gateway" router="/H/sapgateway.mycorp.com/S/3456/H/"/>
  </Routers>
  <Services>
    <Service uuid="s-1" name="CD2" type="SAPGUI" systemid="CD2" server="cd2.example.com:3200" routerid="r-9"/>
  </Services>
</Landscape>"#;
        let systems = collect(xml);
        assert_eq!(
            systems[0].guiparm,
            "/H/sapgateway.mycorp.com/S/3456/H/cd2.example.com/S/3200"
        );
    }

    #[test]
    fn remote_includes_are_reported_and_never_fetched() {
        let path = std::env::temp_dir().join(format!(
            "sapvault-landscape-test-{}.xml",
            std::process::id()
        ));
        let xml = r#"<Landscape>
  <Services>
    <Service uuid="s-1" name="AB1" type="SAPGUI" systemid="AB1" server="ab1.example.com:3200"/>
  </Services>
  <Includes>
    <include index="1" url="https://corp.example.com/saplandscapes/AdditionalSAPUILandscape_1.xml"/>
    <include index="2" url="file:///C:/definitely-missing/SAPUILandscapeGlobal.xml"/>
  </Includes>
</Landscape>"#;
        std::fs::write(&path, xml).expect("write fixture");
        let landscape = load(&[path.to_string_lossy().to_string()]);
        let _ = std::fs::remove_file(&path);

        assert!(landscape.files.iter().any(|file| file.ends_with(".xml")));
        assert_eq!(landscape.systems.len(), 1);
        let warnings = landscape.warnings.join(" | ");
        assert!(
            warnings.contains("AdditionalSAPUILandscape_1.xml"),
            "remote include should be reported: {warnings}"
        );
        // A missing local include is not worth a warning (SAP GUI often ships
        // without the global file on a client-only install).
        assert!(
            !warnings.contains("definitely-missing"),
            "missing local include should stay silent: {warnings}"
        );
    }

    #[test]
    fn parses_child_element_layouts() {
        // SAP GUI 7.4x wrote the connection data as child elements.
        let legacy = r#"<Landscape>
  <Services>
    <Service uuid="x" name="DEV" type="SAPGUI">
      <System id="DEV"/>
      <Connection>
        <Server>dev.example.com:3200</Server>
        <Client>200</Client>
        <Language>EN</Language>
      </Connection>
    </Service>
  </Services>
</Landscape>"#;
        let systems = collect(legacy);
        assert_eq!(systems.len(), 1);
        let dev = &systems[0];
        assert_eq!(dev.system_id, "DEV");
        assert_eq!(dev.host, "dev.example.com");
        assert_eq!(dev.client, "200");
        assert_eq!(dev.language, "EN");
    }

    #[test]
    fn include_urls_become_windows_paths() {
        assert_eq!(
            include_to_path("file:///C:/Users/lhm49/AppData/Roaming/SAP/Common/SAPUILandscapeGlobal.xml"),
            Some(PathBuf::from(r"C:\Users\lhm49\AppData\Roaming\SAP\Common\SAPUILandscapeGlobal.xml"))
        );
        assert_eq!(include_to_path(""), None);
    }

    #[test]
    fn json_field_names_match_the_frontend() {
        // The UI reads these names straight out of the IPC payload; a rename in
        // Rust without touching the frontend would break the SAP views silently.
        let landscape = Landscape {
            files: vec!["C:\\x\\SAPUILandscape.xml".to_string()],
            systems: collect(SAMPLE),
            warnings: Vec::new(),
        };
        let json = serde_json::to_value(&landscape).expect("serialize");
        assert!(json["files"].is_array());
        let system = &json["systems"][0];
        for key in [
            "serviceUuid",
            "systemId",
            "entryType",
            "kind",
            "host",
            "port",
            "instance",
            "messageServer",
            "messageServerPort",
            "group",
            "router",
            "url",
            "guiparm",
            "workspace",
            "sourceFile",
            "client",
            "language",
            "user",
        ] {
            assert!(system.get(key).is_some(), "missing field {key} in {system}");
        }
    }
}
