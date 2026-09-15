use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// One entry of the SAP GUI logon list, with every host name we managed to
/// resolve for it.
///
/// This type is deliberately one *service*, not one system: a single `systemid`
/// routinely appears several times in a real `SAPUILandscape.xml` (different
/// clients, load balancers, sandboxes), and all of them have to be scanned.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SapSystem {
    pub service_id: String,
    pub name: String,
    pub service_type: String,
    pub system_id: String,
    pub client: String,
    pub language: String,
    pub description: String,
    /// Raw `server` attribute exactly as written in the file.
    pub server: String,
    /// Host names / IPs resolved from `server`, message server, router or URL.
    pub hosts: Vec<String>,
    /// Host plus its parent domains, used for substring matching while scanning.
    pub domains: Vec<String>,
    pub router: String,
    pub message_server: String,
    pub url: String,
    pub workspace: String,
    pub source_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateSystemId {
    pub system_id: String,
    pub count: usize,
    pub hosts: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandscapeReport {
    pub files: Vec<String>,
    pub systems: Vec<SapSystem>,
    pub warnings: Vec<String>,
    pub duplicates: Vec<DuplicateSystemId>,
    pub parsed_at: String,
}

impl LandscapeReport {
    pub fn resolve(&self, system_id: &str) -> Vec<SapSystem> {
        let needle = system_id.trim().to_ascii_uppercase();
        if needle.is_empty() {
            return Vec::new();
        }
        self.systems
            .iter()
            .filter(|system| system.system_id.to_ascii_uppercase() == needle)
            .cloned()
            .collect()
    }

    /// Every host name and parent domain of every connection sharing this
    /// system id, de-duplicated and in discovery order.
    pub fn hosts_for(&self, system_id: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for system in self.resolve(system_id) {
            for host in system.domains.iter().chain(system.hosts.iter()) {
                if !out.contains(host) {
                    out.push(host.clone());
                }
            }
        }
        out
    }
}

#[derive(Debug, Default)]
struct RawService {
    attrs: HashMap<String, String>,
    workspace: String,
    source_file: String,
}

#[derive(Debug, Default)]
struct RawLandscape {
    services: Vec<RawService>,
    routers: HashMap<String, String>,
    msg_servers: HashMap<String, String>,
    includes: Vec<String>,
}

/// Where SAP GUI keeps its logon configuration. Both files exist in a default
/// installation; the "Global" one is included from the local one, but it is
/// listed explicitly so a machine that only has the global file still works.
pub fn default_landscape_paths() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let common = PathBuf::from(appdata).join("SAP").join("Common");
        out.push(
            common
                .join("SAPUILandscape.xml")
                .to_string_lossy()
                .to_string(),
        );
        out.push(
            common
                .join("SAPUILandscapeGlobal.xml")
                .to_string_lossy()
                .to_string(),
        );
    }
    if let Some(program_data) = std::env::var_os("PROGRAMDATA") {
        out.push(
            PathBuf::from(program_data)
                .join("SAP")
                .join("SAP GUI")
                .join("SAPUILandscape.xml")
                .to_string_lossy()
                .to_string(),
        );
    }
    out
}

pub fn parse_files(paths: &[String]) -> AppResult<LandscapeReport> {
    let mut report = LandscapeReport {
        parsed_at: crate::model::now_string(),
        ..Default::default()
    };

    let mut seen_files: Vec<PathBuf> = Vec::new();
    let mut merged = RawLandscape::default();
    let mut warnings: Vec<String> = Vec::new();

    let explicit: Vec<PathBuf> = paths
        .iter()
        .map(|path| PathBuf::from(path.trim()))
        .filter(|path| !path.as_os_str().is_empty())
        .collect();

    let candidates = if explicit.is_empty() {
        default_landscape_paths()
            .iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>()
    } else {
        explicit
    };

    for path in candidates {
        if !path.exists() {
            continue;
        }
        collect_file(&path, 0, &mut seen_files, &mut merged, &mut warnings);
    }

    for file in &seen_files {
        report.files.push(file.to_string_lossy().to_string());
    }
    report.warnings = warnings;

    // Destructuring avoids borrowing one field of `merged` while another is
    // moved out of it.
    let RawLandscape {
        services,
        routers,
        msg_servers,
        ..
    } = merged;
    let mut systems: Vec<SapSystem> = services
        .into_iter()
        .map(|raw| build_system(raw, &routers, &msg_servers))
        .collect();
    systems.sort_by(|a, b| {
        a.system_id
            .cmp(&b.system_id)
            .then_with(|| a.name.cmp(&b.name))
    });
    report.duplicates = duplicate_system_ids(&systems);
    report.systems = systems;
    Ok(report)
}

fn collect_file(
    path: &Path,
    depth: usize,
    seen: &mut Vec<PathBuf>,
    merged: &mut RawLandscape,
    warnings: &mut Vec<String>,
) {
    if depth > 6 {
        warnings.push(format!("包含层级过深，已跳过：{}", path.display()));
        return;
    }
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if seen.iter().any(|known| known == &canonical) {
        return;
    }
    seen.push(canonical);

    match parse_file(path) {
        Ok(raw) => {
            merged.services.extend(raw.services);
            merged.routers.extend(raw.routers);
            merged.msg_servers.extend(raw.msg_servers);
            let base = path.parent().map(|parent| parent.to_path_buf());
            for include in raw.includes {
                if let Some(include_path) = include_to_path(&include, base.as_deref()) {
                    if include_path.exists() {
                        collect_file(&include_path, depth + 1, seen, merged, warnings);
                    }
                }
            }
        }
        Err(err) => warnings.push(format!("{} 解析失败：{err}", path.display())),
    }
}

fn parse_file(path: &Path) -> AppResult<RawLandscape> {
    let bytes = std::fs::read(path)?;
    // SAP writes these files as UTF-8, sometimes with a BOM; strip it rather
    // than failing the whole parse on the first element.
    let text = String::from_utf8_lossy(&bytes)
        .trim_start_matches('\u{feff}')
        .to_string();

    let mut reader = Reader::from_str(&text);
    reader.config_mut().trim_text(true);

    let mut raw = RawLandscape::default();
    let source = path.to_string_lossy().to_string();
    let mut stack: Vec<String> = Vec::new();
    let mut workspace: Vec<String> = Vec::new();
    let mut nodes: Vec<String> = Vec::new();
    let mut item_map: Vec<(String, String)> = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let tag = tag_name(&element);
                handle_element(
                    &tag,
                    &element,
                    &source,
                    &stack,
                    &workspace,
                    &nodes,
                    &mut raw,
                    &mut item_map,
                )?;
                push_scope(&tag, &element, &mut workspace, &mut nodes)?;
                stack.push(tag);
            }
            Ok(Event::Empty(element)) => {
                let tag = tag_name(&element);
                handle_element(
                    &tag,
                    &element,
                    &source,
                    &stack,
                    &workspace,
                    &nodes,
                    &mut raw,
                    &mut item_map,
                )?;
            }
            Ok(Event::End(element)) => {
                let tag = String::from_utf8_lossy(element.local_name().as_ref()).to_ascii_lowercase();
                stack.pop();
                pop_scope(&tag, &mut workspace, &mut nodes);
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(AppError::Xml(format!("{}: {err}", path.display()))),
            _ => {}
        }
    }

    // Attach workspace locations now that the whole document is known.
    for (service_id, location) in item_map {
        for service in raw.services.iter_mut() {
            if service.attrs.get("uuid").map(String::as_str) == Some(service_id.as_str()) {
                service.workspace = location.clone();
            }
        }
    }

    Ok(raw)
}

fn tag_name(element: &BytesStart<'_>) -> String {
    String::from_utf8_lossy(element.local_name().as_ref()).to_ascii_lowercase()
}

fn push_scope(
    tag: &str,
    element: &BytesStart<'_>,
    workspace: &mut Vec<String>,
    nodes: &mut Vec<String>,
) -> AppResult<()> {
    match tag {
        "workspace" => workspace.push(attr(element, "name")?.unwrap_or_default()),
        "node" => nodes.push(attr(element, "name")?.unwrap_or_default()),
        _ => {}
    }
    Ok(())
}

fn pop_scope(tag: &str, workspace: &mut Vec<String>, nodes: &mut Vec<String>) {
    match tag {
        "workspace" => {
            workspace.pop();
            nodes.clear();
        }
        "node" => {
            nodes.pop();
        }
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_element(
    tag: &str,
    element: &BytesStart<'_>,
    source: &str,
    stack: &[String],
    workspace: &[String],
    nodes: &[String],
    raw: &mut RawLandscape,
    item_map: &mut Vec<(String, String)>,
) -> AppResult<()> {
    match tag {
        "service" => {
            raw.services.push(RawService {
                attrs: read_attrs(element)?,
                workspace: join_location(workspace, nodes),
                source_file: source.to_string(),
            });
        }
        "router" => {
            if let Some(uuid) = attr(element, "uuid")? {
                let router = attr(element, "router")?
                    .filter(|value| !value.is_empty())
                    .or(attr(element, "name")?);
                if let Some(router) = router {
                    raw.routers.insert(uuid, router);
                }
            }
        }
        "messageserver" => {
            if let (Some(uuid), Some(host)) = (attr(element, "uuid")?, attr(element, "host")?) {
                raw.msg_servers.insert(uuid, host);
            }
        }
        "include" => {
            let url = attr(element, "url")?.or(attr(element, "filename")?);
            if let Some(url) = url.filter(|value| !value.is_empty()) {
                raw.includes.push(url);
            }
        }
        "item" => {
            // In the newer (RSLSMT) format `<Item serviceid="..."/>` links a
            // service into the logon tree; it gives us the folder path.
            if stack.iter().any(|open| open == "workspaces") {
                if let Some(service_id) = attr(element, "serviceid")? {
                    item_map.push((service_id, join_location(workspace, nodes)));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn join_location(workspace: &[String], nodes: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.extend(workspace.iter().cloned());
    parts.extend(nodes.iter().cloned());
    parts.retain(|part| !part.is_empty());
    parts.join(" / ")
}

fn read_attrs(element: &BytesStart<'_>) -> AppResult<HashMap<String, String>> {
    let mut attrs = HashMap::new();
    for attribute in element.attributes() {
        let attribute = attribute?;
        let key = String::from_utf8_lossy(attribute.key.local_name().as_ref()).to_ascii_lowercase();
        let value = attribute
            .unescape_value()
            .map(|value| value.into_owned())
            .unwrap_or_default();
        attrs.insert(key, value);
    }
    Ok(attrs)
}

fn attr(element: &BytesStart<'_>, key: &str) -> AppResult<Option<String>> {
    for attribute in element.attributes() {
        let attribute = attribute?;
        let name = String::from_utf8_lossy(attribute.key.local_name().as_ref()).to_ascii_lowercase();
        if name == key {
            return Ok(Some(
                attribute
                    .unescape_value()
                    .map(|value| value.into_owned())
                    .unwrap_or_default(),
            ));
        }
    }
    Ok(None)
}

fn build_system(
    raw: RawService,
    routers: &HashMap<String, String>,
    msg_servers: &HashMap<String, String>,
) -> SapSystem {
    // Destructuring keeps the borrow of `attrs` independent from the later moves
    // of `workspace` / `source_file`.
    let RawService {
        attrs,
        workspace,
        source_file,
    } = raw;

    let get = |key: &str| attrs.get(key).cloned().unwrap_or_default();
    let server = get("server");
    let url = get("url");
    let router = attrs
        .get("routerid")
        .and_then(|id| routers.get(id))
        .cloned()
        .unwrap_or_default();
    let message_server = attrs
        .get("msid")
        .and_then(|id| msg_servers.get(id))
        .cloned()
        .unwrap_or_default();

    let mut hosts: Vec<String> = Vec::new();
    for candidate in [
        host_from_server(&server),
        host_from_router(&router),
        Some(message_server.clone()).filter(|value| !value.is_empty()),
        host_from_url(&url),
    ]
    .into_iter()
    .flatten()
    {
        let host = candidate.trim().trim_end_matches('.').to_ascii_lowercase();
        if !host.is_empty() && !hosts.contains(&host) {
            hosts.push(host);
        }
    }

    let mut domains: Vec<String> = Vec::new();
    for host in &hosts {
        for candidate in domain_suffixes(host) {
            if !domains.contains(&candidate) {
                domains.push(candidate);
            }
        }
    }

    SapSystem {
        service_id: get("uuid"),
        name: get("name"),
        service_type: get("type"),
        system_id: get("systemid").trim().to_ascii_uppercase(),
        client: get("client"),
        language: get("language"),
        description: get("description"),
        server,
        hosts,
        domains,
        router,
        message_server,
        url,
        workspace,
        source_file,
    }
}

/// `server` is either `host:port`, `sapms<SYS>` for message-server logon, or a
/// placeholder such as `SPACE` that only exists to keep the logon tree grouped.
fn host_from_server(server: &str) -> Option<String> {
    let value = server.trim();
    if value.is_empty() {
        return None;
    }
    let upper = value.to_ascii_uppercase();
    if matches!(upper.as_str(), "SPACE" | "LOADBALANCING" | "MS") || upper.starts_with("SAPMS") {
        return None;
    }
    let host = value
        .split([':', ','])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// Router strings look like `/H/router.host.com/S/3299` or `/H/host/H/...`.
fn host_from_router(router: &str) -> Option<String> {
    let mut parts = router.split('/').peekable();
    while let Some(part) = parts.next() {
        if part.eq_ignore_ascii_case("H") {
            if let Some(next) = parts.peek() {
                let host = next.trim();
                if !host.is_empty() {
                    return Some(host.to_string());
                }
            }
        }
    }
    None
}

fn host_from_url(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    if authority.is_empty() {
        return None;
    }
    let host = if authority.starts_with('[') {
        authority
            .trim_start_matches('[')
            .split(']')
            .next()
            .unwrap_or("")
            .to_string()
    } else {
        authority.split(':').next().unwrap_or("").to_string()
    };
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// Full host plus every parent domain, longest first, so a scan can also match
/// files that only mention the corporate domain suffix.
pub fn domain_suffixes(host: &str) -> Vec<String> {
    if is_ip(host) {
        return vec![host.to_string()];
    }
    let labels: Vec<&str> = host.split('.').filter(|label| !label.is_empty()).collect();
    if labels.len() < 2 {
        return vec![host.to_string()];
    }
    let mut out = Vec::new();
    for start in 0..=(labels.len() - 2) {
        out.push(labels[start..].join("."));
    }
    out
}

pub fn is_ip(host: &str) -> bool {
    if host.contains(':') {
        return true;
    }
    let value = host.trim_matches(|c: char| c == '.' || c == ' ');
    !value.is_empty()
        && value.contains('.')
        && value.chars().all(|c| c.is_ascii_digit() || c == '.')
}

fn duplicate_system_ids(systems: &[SapSystem]) -> Vec<DuplicateSystemId> {
    let mut buckets: BTreeMap<String, (usize, Vec<String>)> = BTreeMap::new();
    for system in systems {
        if system.system_id.is_empty() {
            continue;
        }
        let entry = buckets
            .entry(system.system_id.clone())
            .or_insert_with(|| (0, Vec::new()));
        entry.0 += 1;
        for host in &system.hosts {
            if !entry.1.contains(host) {
                entry.1.push(host.clone());
            }
        }
    }
    buckets
        .into_iter()
        .filter(|(_, (count, _))| *count > 1)
        .map(|(system_id, (count, hosts))| DuplicateSystemId {
            system_id,
            count,
            hosts,
        })
        .collect()
}

fn include_to_path(url: &str, base: Option<&Path>) -> Option<PathBuf> {
    let value = url.trim();
    if value.is_empty() {
        return None;
    }
    if let Some(rest) = value.strip_prefix("file:///") {
        return Some(PathBuf::from(percent_decode(rest).replace('/', "\\")));
    }
    if let Some(rest) = value.strip_prefix("file://") {
        return Some(PathBuf::from(percent_decode(rest).replace('/', "\\")));
    }
    let candidate = PathBuf::from(value);
    if candidate.is_absolute() {
        Some(candidate)
    } else {
        base.map(|directory| directory.join(candidate))
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
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
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<Landscape version="1" updated="2023-07-26T14:14:41" generator="RSLSMT">
  <Workspaces>
    <Workspace name="生产" uuid="w1" expanded="0">
      <Node uuid="n1" name="财务" expanded="0" hidden="0">
        <Item uuid="i1" serviceid="s-prod"/>
      </Node>
    </Workspace>
  </Workspaces>
  <Services>
    <Service uuid="s-prod" name="PRD 生产机" server="prd.sap.corp.example:3200" type="SAPGUI"
             sncop="-1" mode="1" systemid="PRD" client="100" language="ZH" dcpg="2"/>
    <Service uuid="s-prod2" name="PRD 备用" server="10.20.30.40:3200" type="SAPGUI"
             systemid="PRD" client="200"/>
    <Service uuid="s-dev" name="DEV" msid="ms-dev" server="SPACE" type="SAPGUI"
             systemid="DEV" routerid="r1" client="100"/>
    <Service uuid="s-fio" name="Fiori" type="FIORI" url="https://fiori.corp.example:8443/sap/bc/ui2/flp"/>
    <Service uuid="s-nwbc" name="NWBC" type="NWBC" url="http://nwbc.corp.example:8010/nwbc"/>
  </Services>
  <Routers>
    <Router name="/H/router.corp.example" uuid="r1" router="/H/router.corp.example/S/3299" description="r"/>
  </Routers>
  <Messageservers>
    <Messageserver name="DEV" uuid="ms-dev" host="msdev.corp.example" port="3601"/>
  </Messageservers>
</Landscape>"#;

    fn temp_file(tag: &str, name: &str, content: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("sapvault-{tag}-{}", crate::model::new_id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(name);
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(content.as_bytes()).unwrap();
        path
    }

    #[test]
    fn parses_and_resolves_hosts() {
        let path = temp_file("sap", "SAPUILandscape.xml", SAMPLE);
        let report = parse_files(&[path.to_string_lossy().to_string()]).unwrap();
        assert_eq!(report.systems.len(), 5);

        let prd = report.resolve("PRD");
        assert_eq!(prd.len(), 2, "duplicate system ids must all be returned");
        assert!(prd.iter().any(|system| system
            .hosts
            .contains(&"prd.sap.corp.example".to_string())));
        assert!(prd
            .iter()
            .any(|system| system.hosts.contains(&"10.20.30.40".to_string())));

        let dev = report.resolve("dev");
        assert_eq!(dev.len(), 1);
        assert!(dev[0].hosts.contains(&"msdev.corp.example".to_string()));
        assert!(dev[0].hosts.contains(&"router.corp.example".to_string()));

        let fiori = report
            .systems
            .iter()
            .find(|system| system.service_type == "FIORI")
            .unwrap();
        assert_eq!(fiori.hosts, vec!["fiori.corp.example".to_string()]);

        assert_eq!(prd.iter().find(|system| system.service_id == "s-prod").unwrap().workspace, "生产 / 财务");
        assert!(report
            .hosts_for("PRD")
            .contains(&"corp.example".to_string()));
    }

    #[test]
    fn duplicate_system_ids_are_reported_with_all_hosts() {
        let path = temp_file("sap-dup", "SAPUILandscape.xml", SAMPLE);
        let report = parse_files(&[path.to_string_lossy().to_string()]).unwrap();
        let duplicate = report
            .duplicates
            .iter()
            .find(|item| item.system_id == "PRD")
            .unwrap();
        assert_eq!(duplicate.count, 2);
        assert!(duplicate.hosts.contains(&"10.20.30.40".to_string()));
        assert!(duplicate
            .hosts
            .contains(&"prd.sap.corp.example".to_string()));
    }

    #[test]
    fn domain_suffixes_expand_left_to_right() {
        assert_eq!(
            domain_suffixes("de1saps331.euip.devcorp.net"),
            vec![
                "de1saps331.euip.devcorp.net",
                "euip.devcorp.net",
                "devcorp.net"
            ]
        );
        assert_eq!(domain_suffixes("10.1.2.3"), vec!["10.1.2.3"]);
        assert_eq!(domain_suffixes("intranet"), vec!["intranet"]);
    }

    #[test]
    fn follows_include_files() {
        let global = temp_file(
            "sap-inc",
            "SAPUILandscapeGlobal.xml",
            r#"<Landscape version="1"><Services>
                 <Service uuid="g1" name="G" server="g.corp.example:3200" type="SAPGUI" systemid="G1"/>
               </Services></Landscape>"#,
        );
        let directory = global.parent().unwrap();
        let local = directory.join("SAPUILandscape.xml");
        std::fs::write(
            &local,
            format!(
                r#"<Landscape version="1"><Services>
                     <Service uuid="l1" name="L" server="l.corp.example:3200" type="SAPGUI" systemid="L1"/>
                   </Services>
                   <Includes><Include url="file:///{}" index="0"/></Includes></Landscape>"#,
                global.to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();

        let report = parse_files(&[local.to_string_lossy().to_string()]).unwrap();
        assert_eq!(report.files.len(), 2);
        assert_eq!(report.resolve("G1").len(), 1);
        assert_eq!(report.resolve("L1").len(), 1);
    }

    #[test]
    fn missing_paths_are_ignored() {
        let report = parse_files(&["C:\\definitely\\not\\here.xml".to_string()]).unwrap();
        assert!(report.systems.is_empty());
        assert!(report.files.is_empty());
    }

    #[test]
    fn server_placeholders_do_not_become_hosts() {
        assert_eq!(host_from_server("SPACE"), None);
        assert_eq!(host_from_server("sapmsP20"), None);
        assert_eq!(host_from_server(""), None);
        assert_eq!(
            host_from_server("prd.sap.corp.example:3200"),
            Some("prd.sap.corp.example".to_string())
        );
    }
}
