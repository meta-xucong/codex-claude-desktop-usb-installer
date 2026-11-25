use crate::errors::AppError;
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Mutex, time::{Duration, Instant}};

// Only the model panel populates this cache. A removable account owns its directory.
static DIRECTORY: Mutex<Option<(String, Vec<Value>)>> = Mutex::new(None);
const PROFILE: &str = "00000000-0000-4000-8000-000000157210";

fn error(reason: &str) -> AppError { AppError::Engine(reason.to_owned()) }

fn read(path: &Path) -> Result<Value, AppError> {
    match fs::read(path) {
        Ok(raw) => serde_json::from_slice(raw.strip_prefix(&[0xef,0xbb,0xbf]).unwrap_or(&raw))
            .map_err(|_| error("Claude 本机模型配置无法解析。")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(_) => Err(error("无法读取桌面用户的 Claude 模型配置。")),
    }
}

fn entry_id(value: &Value) -> Option<&str> {
    value.as_str().or_else(|| value.get("name")?.as_str())
}

fn messages_transport_error(err: reqwest::Error) -> String {
    if err.is_timeout() {
        "Claude Messages 探测超时，请稍后重试。".into()
    } else if err.is_connect() {
        "无法连接 Claude Messages 网关，请检查网络后重试。".into()
    } else {
        "Claude Messages 网络传输失败，请稍后重试。".into()
    }
}

fn probe_messages(client: &reqwest::blocking::Client, endpoint: &str, api_key: &str, scheme: &Value, model: &str) -> Result<u16, String> {
    let req = client.post(endpoint).header("anthropic-version","2023-06-01")
        .header("content-type","application/json").body(json!({"model":model,"max_tokens":1,"messages":[{"role":"user","content":"Hi"}]}).to_string());
    let req = match scheme.as_str() {
        Some("x-api-key") => req.header("x-api-key",api_key),
        Some("bearer") | None => req.bearer_auth(api_key),
        _ => return Err("当前账号的鉴权方式无法用于 Claude Messages。".into()),
    };
    let response = req.send().map_err(messages_transport_error)?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let reason = match status {
            401 | 403 => "网关拒绝授权，请检查当前账号的模型权限",
            429 => "网关限流或额度受限，请检查额度或稍后重试",
            500..=599 => "网关或上游服务暂时出错，请稍后重试",
            _ => "网关未接受该模型的 Messages 请求",
        };
        return Err(format!("{reason}（HTTP {status}）。"));
    }
    let bytes = response.bytes().map_err(messages_transport_error)?;
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|_| format!("Claude Messages 返回了无效 JSON（HTTP {status}）。"))?;
    if body["type"] != "message" || body["role"] != "assistant" || !body["content"].is_array() {
        return Err(format!("响应不符合 Claude Messages 格式（HTTP {status}）。"));
    }
    Ok(status)
}

fn directory(api_key: &str, auth_scheme: &Value) -> Result<Vec<Value>, AppError> {
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| error("无法打开 Claude 模型目录。"))?;
    read_directory(|cursor| {
        let mut url = reqwest::Url::parse("https://404token.xyz/v1/models").expect("fixed gateway URL");
        url.query_pairs_mut().append_pair("limit", "1000");
        if let Some(after) = cursor { url.query_pairs_mut().append_pair("after_id", after); }
        let req = client.get(url).header("anthropic-version", "2023-06-01");
        let req = match auth_scheme.as_str() {
            Some("x-api-key") => req.header("x-api-key", api_key),
            Some("bearer") | None => req.bearer_auth(api_key),
            _ => return Err(error("当前 Claude 网关鉴权方式无法用于目录查询。")),
        };
        let resp = req.send().and_then(|r| r.error_for_status()).map_err(|_| error("无法读取当前账号的 Claude 模型目录。"))?;
        serde_json::from_reader(resp).map_err(|_| error("Claude 目录响应不完整。"))
    })
}

fn check_messages(key: &str, scheme: &Value, model: &str) -> Result<(), String> {
    let started = Instant::now();
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::none()).build()
        .map_err(|_| "无法初始化 Claude Messages 网关连接。".to_owned())?;
    let result = probe_messages(&client, "https://404token.xyz/v1/messages", key, scheme, model);
    let id = if crate::app::model_diagnostics::safe_identifier(model) { model } else { "<redacted>" };
    match &result {
        Ok(status) => log::info!("Claude model probe model={id} http={status} elapsed_ms={}", started.elapsed().as_millis()),
        Err(reason) => log::warn!("Claude model probe model={id} elapsed_ms={} reason={reason}", started.elapsed().as_millis()),
    }
    result.map(|_| ())
}

fn read_directory(mut page_at: impl FnMut(Option<&str>) -> Result<Value, AppError>) -> Result<Vec<Value>, AppError> {
    let mut result = Vec::new();
    let mut cursor = None::<String>;
    let mut seen = std::collections::HashSet::new();
    loop {
        let page = page_at(cursor.as_deref())?;
        let rows = page["data"].as_array().ok_or_else(|| error("Claude 目录缺少模型列表。"))?;
        for row in rows {
            let id = row["id"].as_str().filter(|s| !s.trim().is_empty()).ok_or_else(|| error("目录含无效型号。"))?;
            if !seen.insert(id.to_owned()) { return Err(error("目录包含重复条目，请重新刷新。")); }
            if row["type"] != "model" && row["object"] != "model" {
                return Err(error("无法识别网关目录条目，已保留现有配置。"));
            }
            let tiers = ["sonnet", "opus", "haiku", "fable", "mythos"];
            let tier = row["anthropic_family_tier"].as_str().map(str::to_ascii_lowercase).filter(|t| tiers.contains(&t.as_str()));
            let route = id.to_ascii_lowercase();
            let parts: Vec<_> = route.split(['/', '.', '-', '_', ':', '@', '[', ']']).collect();
            let family = parts.iter().any(|p| tiers.contains(p)) || parts.contains(&"claude") || parts.contains(&"anthropic");
            let mixed = ["gpt","grok","gemini","llama","deepseek","qwen","openai"].iter().any(|s| route.contains(s));
            if tier.is_none() && (!family || mixed) {
                result.push(json!({"name":id,"_candidate":true}));
                continue;
            }
            let mut entry = json!({"name":id});
            if let Some(label) = row["display_name"].as_str().filter(|s| !s.is_empty() && *s != id) {
                entry["labelOverride"] = json!(label);
            }
            if let Some(tier) = tier {
                entry["anthropicFamilyTier"] = json!(tier);
                if row["is_family_default"] == true { entry["isFamilyDefault"] = json!(true); }
            }
            // Desktop accepts the gateway spelling and normalizes paired [1m] rows itself.
            if route.ends_with("[1m]") || row["supports_1m"].as_bool().unwrap_or_else(|| row["max_input_tokens"].as_u64().is_some_and(|n| n >= 1_000_000)) {
                entry["supports1m"] = json!(true);
            }
            result.push(entry);
        }
        match page["has_more"].as_bool() {
            Some(false) => return Ok(result),
            Some(true) => {
                let last = page["last_id"].as_str().filter(|s| rows.last().and_then(|r| r["id"].as_str()) == Some(*s))
                    .ok_or_else(|| error("Claude 目录分页不完整。"))?;
                cursor = Some(last.to_owned());
            }
            None if page["object"] == "list" && rows.len() < 1000 && page.get("last_id").is_none()
                && page.get("has_more").is_none() => return Ok(result),
            None => return Err(error("无法确认 Claude 目录完整。")),
        }
    }
}

pub fn manage(operation: &str, model: Option<&str>, expected: Option<&str>, mut progress: impl FnMut(&'static str)) -> Result<Value, AppError> {
    use crate::app::{usb_guard, codex_entry_ipc};
    let (root, identity, key) = usb_guard::claude_account()?;
    if expected.is_some_and(|s| s != identity) { return Err(error("U 盘账号已切换，请重新打开模型页。")); }
    let local = usb_guard::local_data_paths()?.local_app_data;
    let base = local.join("CodexAppManager/claude-desktop");
    let lib = local.join("Claude-3p/configLibrary");
    let profile_path = lib.join(format!("{PROFILE}.json"));
    let mut cache = DIRECTORY.lock().unwrap_or_else(|e| e.into_inner());
    let profile = read(&profile_path)?;
    let binding = read(&base.join("connection.json"))?;
    let pipe = codex_entry_ipc::current_pipe_for(&root).map_err(AppError::Engine)?;
    let ready = binding["identity"] == identity.as_str() && binding["pipe"] == pipe.trim_start_matches(r"\\.\pipe\")
        && read(&lib.join("_meta.json"))?["appliedId"] == PROFILE
        && profile["inferenceProvider"] == "gateway" && profile["inferenceGatewayBaseUrl"] == "https://404token.xyz"
        && profile["inferenceCredentialHelper"].as_str().is_some_and(|p| Path::new(p) == base.join("Get-UsbClaudeCredential.ps1"));
    if !ready { return Ok(json!({"ready":false,"binding":identity,"configured":[],"directory":[]})); }
    if operation == "refresh" {
        *cache = None;
        *cache = Some((identity.clone(), directory(&key, &profile["inferenceGatewayAuthScheme"])?));
    }
    let available = cache.as_ref().filter(|(owner, _)| owner == &identity).map(|(_, rows)| rows.as_slice()).unwrap_or(&[]);
    let mut current = profile;
    if operation == "test" {
        let id = model.ok_or_else(|| error("请选择模型。"))?;
        if expected != Some(identity.as_str()) || !available.iter().any(|row| entry_id(row) == Some(id)) {
            return Err(error("当前账号的模型目录已变化，请刷新后重试。"));
        }
        return Ok(json!({"ready":true, "binding":identity, "probeError":check_messages(&key, &current["inferenceGatewayAuthScheme"], id).err()}));
    }
    if matches!(operation, "add" | "default" | "reset") {
        if expected != Some(identity.as_str()) { return Err(error("请重新选择当前 U 盘的模型。")); }
        let configured = current["inferenceModels"].as_array();
        let mut request = json!({"operation":operation});
        if operation != "reset" {
            let id = model.ok_or_else(|| error("请选择模型。"))?;
            let entry = available.iter().find(|row| entry_id(row) == Some(id));
            if entry.is_none() && !configured.is_some_and(|rows| rows.iter().any(|r| entry_id(r) == Some(id))) {
                return Err(error("当前账号的 Claude 目录中未找到该模型。"));
            }
            let explicit = configured.is_some_and(|rows| rows.iter().any(|r| entry_id(r) == Some(id)));
            let automatic = configured.is_none_or(|rows| rows.is_empty()) && current["modelDiscoveryEnabled"] != false;
            let auto_member = automatic && entry.is_some_and(|row| row["_candidate"] != true);
            if operation == "add" && (explicit || auto_member) {
                return Ok(view(&identity, &current, available));
            }
            request["model"] = json!(id);
            if let Some(row) = entry {
                if row["_candidate"] == true {
                    request["entry"] = json!({"name":id});
                } else {
                    request["entry"] = row.clone();
                }
            }
            if configured.is_none_or(|rows| rows.is_empty()) {
                if available.is_empty() { return Err(error("请先刷新 Claude 原生目录。")); }
                request["directory"] = json!(available.iter().filter(|row| automatic && row["_candidate"] != true).collect::<Vec<_>>());
            }
            if operation == "add" {
                progress("probing");
                check_messages(&key, &current["inferenceGatewayAuthScheme"], id).map_err(|reason| error(&reason))?;
            }
        }
        progress("saving");
        super::worker_for("models", |_| {}, Some((&identity, request.to_string())))?;
        current = read(&profile_path)?;
        if operation == "add" && !current["inferenceModels"].as_array()
            .is_some_and(|rows| rows.iter().any(|row| entry_id(row) == model)) {
            return Err(error("保存后未在当前 Claude 配置中读到该模型，请刷新列表后重试。"));
        }
    } else if !matches!(operation, "state" | "refresh") { return Err(error("未知 Claude 模型操作。")); }
    Ok(view(&identity, &current, available))
}

fn view(identity: &str, current: &Value, available: &[Value]) -> Value {
    let configured: Vec<_> = current["inferenceModels"].as_array().into_iter().flatten().filter_map(entry_id).collect();
    let automatic = configured.is_empty() && current["modelDiscoveryEnabled"] != false;
    let native: Vec<_> = available.iter().filter(|row| automatic && row["_candidate"] != true).filter_map(entry_id).collect();
    json!({"ready":true,"binding":identity,"configured":configured,"native":native,"directory":available.iter().filter_map(entry_id).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_probe_distinguishes_gateway_failures_without_exposing_the_body() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpListener;

        let client = reqwest::blocking::Client::builder().no_proxy()
            .timeout(Duration::from_secs(5)).build().unwrap();
        for (status, body, expected) in [
            (200, r#"{"type":"message","role":"assistant","content":[]}"#, ""),
            (403, "private upstream error", "授权"),
            (429, "private upstream error", "限流"),
            (503, "private upstream error", "上游服务"),
            (400, "private upstream error", "未接受"),
            (200, "private upstream error", "无效 JSON"),
            (200, r#"{"choices":[]}"#, "格式"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/v1/messages", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut reader = BufReader::new(&mut socket);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                assert!(line.starts_with("POST /v1/messages "));
                let mut length = 0;
                loop {
                    line.clear();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" { break; }
                    if let Some(s) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = s.trim().parse().unwrap();
                    }
                }
                let mut payload = vec![0; length];
                reader.read_exact(&mut payload).unwrap();
                assert_eq!(serde_json::from_slice::<Value>(&payload).unwrap()["model"], "gemini-fixture");
                write!(socket, "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let result = probe_messages(&client, &url, "fixture-key", &json!("bearer"), "gemini-fixture");
            server.join().unwrap();
            if expected.is_empty() {
                assert_eq!(result, Ok(200));
            } else {
                let message = result.unwrap_err();
                assert!(message.contains(expected) && message.contains(&format!("HTTP {status}")));
                assert!(!message.contains("private") && !message.contains("fixture-key"));
            }
        }
    }

    #[test]
    fn messages_probe_reports_timeout_separately_from_connection_failure() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/messages", listener.local_addr().unwrap());
        let client = reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_millis(250)).build().unwrap();
        let probe = || probe_messages(&client, &url, "fixture-key", &json!("x-api-key"), "fixture");
        assert!(probe().unwrap_err().contains("超时"));
        drop(listener);
        // On Windows a refused TCP connection can take longer than the short timeout above.
        let client = reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(10)).build().unwrap();
        assert!(probe_messages(&client, &url, "fixture-key", &json!("x-api-key"), "fixture").unwrap_err().contains("无法连接"));
    }

    #[test]
    fn complete_claude_directory_preserves_order_attributes_and_follows_cursor() {
        let mut calls = 0;
        let result = read_directory(|cursor| {
            calls += 1;
            Ok(match cursor {
                None => json!({"data":[{"type":"model","id":"gateway/claude-haiku-5","display_name":"First","supports_1m":true}],"has_more":true,"last_id":"gateway/claude-haiku-5"}),
                Some("gateway/claude-haiku-5") => json!({"data":[{"type":"model","id":"gpt-test"},{"type":"model","id":"b","anthropic_family_tier":"sonnet"}],"has_more":false}),
                _ => panic!("unexpected cursor")
            })
        }).unwrap();
        assert_eq!(calls,2);
        assert_eq!(result,vec![json!({"name":"gateway/claude-haiku-5","labelOverride":"First","supports1m":true}),json!({"name":"gpt-test","_candidate":true}),json!({"name":"b","anthropicFamilyTier":"sonnet"})]);
    }

    #[test]
    fn openai_list_from_the_gateway_retains_routed_ids_and_native_attributes() {
        let rows = read_directory(|_| Ok(json!({"object":"list","data":[
            {"object":"model","id":"gpt-6.1-terra"},
            {"object":"model","id":"bedrock/us.anthropic.claude-opus-5","max_input_tokens":1000000,"supports_1m":false},
            {"object":"model","id":"team-route","anthropic_family_tier":"sonnet","is_family_default":true,"description":"A note"}
        ]}))).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], json!({"name":"gpt-6.1-terra","_candidate":true}));
        assert_eq!(rows[1], json!({"name":"bedrock/us.anthropic.claude-opus-5"}));
        assert_eq!(rows[2], json!({"name":"team-route","anthropicFamilyTier":"sonnet","isFamilyDefault":true}));
    }

    #[test]
    fn context_variants_survive_conversion_to_a_managed_list() {
        let rows = read_directory(|_| Ok(json!({"object":"list","data":[
            {"object":"model","id":"claude-sonnet"},
            {"object":"model","id":"claude-sonnet[1m]","display_name":"Long context"},
            {"object":"model","id":"gpt-extra"}
        ]}))).unwrap();
        assert_eq!(rows[1], json!({"name":"claude-sonnet[1m]","labelOverride":"Long context","supports1m":true}));
        let automatic = view("account", &json!({}), &rows);
        assert_eq!(automatic["native"], json!(["claude-sonnet","claude-sonnet[1m]"]));
        assert_eq!(automatic["directory"][2], "gpt-extra");
    }

    #[test]
    fn partial_or_untyped_gateway_lists_cannot_replace_discovery() {
        for page in [json!({"data":[{"id":"a","type":"model"}]}),
                     json!({"data":[{"id":"a","type":"model"}],"has_more":true}),
                     json!({"data":[{"id":"a"}],"has_more":false})] {
            assert!(read_directory(|_| Ok(page.clone())).is_err());
        }
    }
}
