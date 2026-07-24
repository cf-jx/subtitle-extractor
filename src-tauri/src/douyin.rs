use std::{io, sync::OnceLock, time::Duration};

use regex::Regex;
use reqwest::{
    header::{ACCEPT, ACCEPT_LANGUAGE, CONTENT_TYPE},
    redirect::Policy,
    Client, Response, StatusCode,
};
use serde_json::Value;
use url::Url;

const MOBILE_SAFARI_USER_AGENT: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: usize = 5;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const PAGE_HOSTS: &[&str] = &[
    "douyin.com",
    "www.douyin.com",
    "m.douyin.com",
    "v.douyin.com",
    "iesdouyin.com",
    "www.iesdouyin.com",
];
const MEDIA_DOMAIN_SUFFIXES: &[&str] = &["snssdk.com", "douyinvod.com", "zjcdn.com", "douyin.com"];

#[derive(Debug, Clone, PartialEq, Eq)]
enum DouyinInput {
    Video { aweme_id: String },
    Short { url: Url },
}

pub fn is_douyin_host(url: &Url) -> bool {
    normalized_host(url).is_some_and(|host| PAGE_HOSTS.contains(&host.as_str()))
}

pub fn is_supported_url(url: &Url) -> bool {
    parse_input_url(url).is_ok()
}

pub async fn resolve_video_url(raw: &str) -> Result<Url, String> {
    let input_url = Url::parse(raw.trim()).map_err(|_| "请输入有效的抖音视频链接")?;
    let input = parse_input_url(&input_url)?;
    let client = build_client()?;
    let aweme_id = match input {
        DouyinInput::Video { aweme_id } => aweme_id,
        DouyinInput::Short { url } => {
            let redirected = request_share_page(&client, url).await?;
            validate_page_url(redirected.url())?;
            extract_aweme_id(redirected.url())
                .ok_or_else(|| "抖音短链没有跳转到有效的单视频页面".to_string())?
        }
    };
    let response = request_share_page(&client, canonical_share_url(&aweme_id)?).await?;
    validate_page_url(response.url())?;
    let html = read_limited_html(response).await?;
    parse_router_video_url(&html, &aweme_id)
}

fn build_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(MOBILE_SAFARI_USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .https_only(true)
        .redirect(Policy::custom(|attempt| {
            match validate_redirect_target(attempt.url(), attempt.previous().len()) {
                Ok(()) => attempt.follow(),
                Err(error) => attempt.error(io::Error::other(error)),
            }
        }))
        .build()
        .map_err(|error| format!("无法初始化抖音网络请求：{error}"))
}

async fn request_share_page(client: &Client, url: Url) -> Result<Response, String> {
    validate_page_url(&url)?;
    let response = client
        .get(url)
        .header(
            ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "请求抖音分享页超时，请检查当前网络或代理".to_string()
            } else if error.is_redirect() {
                "抖音短链跳转次数过多，或跳转到了不受信任的地址".to_string()
            } else {
                format!("无法连接抖音分享页：{error}")
            }
        })?;

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .map(|value| value.to_str())
        .transpose()
        .map_err(|_| "抖音分享页返回了无效的内容类型")?;
    validate_response_metadata(response.status(), content_type, response.content_length())?;
    Ok(response)
}

fn validate_response_metadata(
    status: StatusCode,
    content_type: Option<&str>,
    content_length: Option<u64>,
) -> Result<(), String> {
    if !status.is_success() {
        return Err(match status.as_u16() {
            403 => "抖音拒绝访问该视频页面".into(),
            404 => "抖音视频页面不存在或已经失效".into(),
            _ => format!("抖音分享页请求失败（HTTP {}）", status.as_u16()),
        });
    }
    if content_type.is_some_and(|value| {
        !value.starts_with("text/html") && !value.starts_with("application/xhtml+xml")
    }) {
        return Err("抖音分享页返回的不是 HTML 页面".into());
    }
    if content_length.is_some_and(|length| length > MAX_RESPONSE_BYTES as u64) {
        return Err("抖音分享页数据过大，已停止解析".into());
    }
    Ok(())
}

async fn read_limited_html(mut response: Response) -> Result<String, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取抖音分享页失败：{error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("抖音分享页数据过大，已停止解析".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "抖音分享页不是有效的 UTF-8 文本".into())
}

fn parse_input_url(url: &Url) -> Result<DouyinInput, String> {
    validate_page_url(url)?;
    let host = normalized_host(url).ok_or_else(|| "抖音链接缺少有效域名".to_string())?;

    if host == "v.douyin.com" {
        let segments = strict_path_segments(url.path())
            .filter(|segments| segments.len() == 1 && is_safe_code(segments[0]))
            .ok_or_else(|| "抖音短链格式无效".to_string())?;
        let _ = segments;
        return Ok(DouyinInput::Short { url: url.clone() });
    }

    extract_aweme_id(url)
        .map(|aweme_id| DouyinInput::Video { aweme_id })
        .ok_or_else(|| "只支持抖音单视频链接".to_string())
}

fn extract_aweme_id(url: &Url) -> Option<String> {
    let host = normalized_host(url)?;
    let segments = strict_path_segments(url.path())?;
    let id = match (host.as_str(), segments.as_slice()) {
        ("www.douyin.com", ["video", id] | ["share", "video", id]) => *id,
        ("www.iesdouyin.com" | "iesdouyin.com" | "m.douyin.com", ["share", "video", id]) => *id,
        _ => return None,
    };
    is_safe_aweme_id(id).then(|| id.to_string())
}

fn canonical_share_url(aweme_id: &str) -> Result<Url, String> {
    Url::parse(&format!(
        "https://www.iesdouyin.com/share/video/{aweme_id}/"
    ))
    .map_err(|_| "无法生成抖音移动分享页地址".into())
}

fn validate_page_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err("抖音页面只允许 HTTPS 地址".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("抖音页面地址不能包含账号信息".into());
    }
    if url.port().is_some() {
        return Err("抖音页面地址不能包含自定义端口".into());
    }
    let host = normalized_host(url).ok_or_else(|| "抖音页面地址缺少有效域名".to_string())?;
    if !PAGE_HOSTS.contains(&host.as_str()) {
        return Err("抖音短链跳转到了不受信任的地址".into());
    }
    Ok(())
}

fn validate_redirect_target(url: &Url, previous_count: usize) -> Result<(), String> {
    if previous_count >= MAX_REDIRECTS {
        return Err("抖音短链重定向次数过多".into());
    }
    validate_page_url(url)
}

fn normalized_host(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    if host.ends_with('.') {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

fn strict_path_segments(path: &str) -> Option<Vec<&str>> {
    let path = path.strip_prefix('/')?;
    let path = path.strip_suffix('/').unwrap_or(path);
    if path.is_empty() || path.contains("//") {
        return None;
    }
    let segments = path.split('/').collect::<Vec<_>>();
    segments
        .iter()
        .all(|segment| !segment.is_empty())
        .then_some(segments)
}

fn is_safe_aweme_id(value: &str) -> bool {
    (1..=32).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_safe_code(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn parse_router_video_url(html: &str, aweme_id: &str) -> Result<Url, String> {
    let captures = router_data_regex()
        .captures(html)
        .ok_or_else(|| "抖音分享页中找不到视频数据".to_string())?;
    let json = captures
        .name("data")
        .ok_or_else(|| "抖音分享页中的视频数据不完整".to_string())?
        .as_str();
    let root: Value = serde_json::from_str(json).map_err(|_| "抖音分享页中的视频数据格式异常")?;

    let mut stack = vec![&root];
    let mut matched_item = false;
    while let Some(value) = stack.pop() {
        match value {
            Value::Object(object) => {
                if object.get("aweme_id").and_then(Value::as_str) == Some(aweme_id) {
                    matched_item = true;
                    if let Some(urls) = value
                        .pointer("/video/play_addr/url_list")
                        .and_then(Value::as_array)
                    {
                        for raw_url in urls.iter().filter_map(Value::as_str) {
                            if let Ok(url) = validate_media_url(raw_url) {
                                return Ok(url);
                            }
                        }
                    }
                }
                stack.extend(object.values());
            }
            Value::Array(values) => stack.extend(values),
            _ => {}
        }
    }

    if matched_item {
        Err("抖音返回的视频地址不安全或不可用".into())
    } else {
        Err("抖音页面中找不到对应的视频数据".into())
    }
}

fn router_data_regex() -> &'static Regex {
    static ROUTER_DATA_REGEX: OnceLock<Regex> = OnceLock::new();
    ROUTER_DATA_REGEX.get_or_init(|| {
        Regex::new(
            r#"(?s)<script(?:\s[^>]*)?>\s*window\._ROUTER_DATA\s*=\s*(?P<data>\{.*?\})\s*;?\s*</script>"#,
        )
        .expect("router data regex must be valid")
    })
}

fn validate_media_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "抖音返回了无效的视频地址")?;
    if url.scheme() != "https" {
        return Err("抖音视频地址不是 HTTPS".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return Err("抖音视频地址包含不安全的连接信息".into());
    }
    let host = normalized_host(&url).ok_or_else(|| "抖音视频地址缺少有效域名".to_string())?;
    if !MEDIA_DOMAIN_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        return Err("抖音视频地址来自不受信任的域名".into());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AWEME_ID: &str = "7381234567890123456";

    #[test]
    fn accepts_supported_douyin_single_video_shapes() {
        for raw in [
            "https://www.douyin.com/video/7381234567890123456",
            "https://www.douyin.com/share/video/7381234567890123456?previous_page=app",
            "https://www.iesdouyin.com/share/video/7381234567890123456/",
            "https://iesdouyin.com/share/video/7381234567890123456?from_ssr=1",
            "https://m.douyin.com/share/video/7381234567890123456/",
            "https://v.douyin.com/iAQ8brvP/",
        ] {
            let url = Url::parse(raw).unwrap();
            assert!(is_supported_url(&url), "{raw}");
        }
    }

    #[test]
    fn rejects_unsafe_douyin_hosts_paths_and_ids() {
        for raw in [
            "http://www.douyin.com/video/7381234567890123456",
            "https://www.douyin.com/",
            "https://www.douyin.com/live/7381234567890123456",
            "https://www.douyin.com/video/not-a-number",
            "https://www.douyin.com/video/7381234567890123456/extra",
            "https://evil.douyin.com/video/7381234567890123456",
            "https://douyin.com.evil.example/video/7381234567890123456",
            "https://www.iesdouyin.com/video/7381234567890123456",
            "https://v.douyin.com/unsafe%2Fcode/",
            "https://v.douyin.com:8443/iAQ8brvP/",
            "https://user@v.douyin.com/iAQ8brvP/",
        ] {
            let url = Url::parse(raw).unwrap();
            assert!(!is_supported_url(&url), "{raw}");
        }
    }

    #[test]
    fn redirect_policy_rejects_untrusted_targets_and_excessive_hops() {
        let trusted = Url::parse(&format!("https://www.douyin.com/video/{AWEME_ID}")).unwrap();
        assert!(validate_redirect_target(&trusted, MAX_REDIRECTS - 1).is_ok());
        assert!(validate_redirect_target(&trusted, MAX_REDIRECTS).is_err());

        for raw in [
            "http://www.douyin.com/video/7381234567890123456",
            "https://evil.example/video/7381234567890123456",
            "https://www.douyin.com:8443/video/7381234567890123456",
            "https://user@www.douyin.com/video/7381234567890123456",
        ] {
            assert!(
                validate_redirect_target(&Url::parse(raw).unwrap(), 0).is_err(),
                "{raw}"
            );
        }
    }

    #[test]
    fn enforces_share_page_response_limits() {
        assert!(validate_response_metadata(
            StatusCode::OK,
            Some("text/html; charset=UTF-8"),
            Some(MAX_RESPONSE_BYTES as u64),
        )
        .is_ok());
        assert!(
            validate_response_metadata(StatusCode::OK, Some("application/xhtml+xml"), None,)
                .is_ok()
        );

        assert!(
            validate_response_metadata(StatusCode::OK, Some("application/json"), None,).is_err()
        );
        assert!(validate_response_metadata(
            StatusCode::OK,
            Some("text/html"),
            Some(MAX_RESPONSE_BYTES as u64 + 1),
        )
        .is_err());
        assert!(validate_response_metadata(StatusCode::FORBIDDEN, None, None).is_err());
    }

    #[test]
    fn extracts_only_the_matching_router_data_item() {
        let html = r#"
            <script>window.__OTHER_DATA = {"aweme_id":"7381234567890123456","video":{"play_addr":{"url_list":["https://evil.example/outside.mp4"]}}}</script>
            <script id="router-data">window._ROUTER_DATA = {
                "loaderData": {
                    "video": {
                        "item_list": [
                            {
                                "aweme_id": "1111111111111111111",
                                "video": {
                                    "play_addr": {
                                        "url_list": ["https://v3.douyinvod.com/wrong.mp4"]
                                    }
                                }
                            },
                            {
                                "aweme_id": "7381234567890123456",
                                "video": {
                                    "play_addr": {
                                        "url_list": [
                                            "http://v3.douyinvod.com/insecure.mp4",
                                            "https://v26-web.douyinvod.com/right.mp4"
                                        ]
                                    }
                                }
                            }
                        ]
                    }
                }
            };</script>
        "#;

        let url = parse_router_video_url(html, AWEME_ID).unwrap();
        assert_eq!(url.as_str(), "https://v26-web.douyinvod.com/right.mp4");
    }

    #[test]
    fn parses_current_mobile_share_page_fixture() {
        let html = include_str!("douyin_router_data_fixture.html");
        let url = parse_router_video_url(html, "6961737553342991651").unwrap();

        assert_eq!(url.host_str(), Some("aweme.snssdk.com"));
        assert_eq!(url.path(), "/aweme/v1/playwm/");
    }

    #[tokio::test]
    #[ignore = "requires live Douyin access"]
    async fn resolves_current_live_share_page() {
        let url = resolve_video_url("https://www.douyin.com/video/6961737553342991651")
            .await
            .unwrap();

        assert_eq!(url.host_str(), Some("aweme.snssdk.com"));
        assert_eq!(url.path(), "/aweme/v1/playwm/");
    }

    #[test]
    fn rejects_mismatched_ids_and_untrusted_media_hosts() {
        let mismatched = r#"
            <script>window._ROUTER_DATA = {
                "item_list": [{
                    "aweme_id": "1111111111111111111",
                    "video": {"play_addr": {"url_list": ["https://v3.douyinvod.com/video.mp4"]}}
                }]
            }</script>
        "#;
        assert!(parse_router_video_url(mismatched, AWEME_ID).is_err());

        for host in [
            "evil-snssdk.com",
            "douyinvod.com.evil.example",
            "evilzjcdn.com",
            "notdouyin.com",
        ] {
            let html = format!(
                r#"<script>window._ROUTER_DATA = {{
                    "item_list": [{{
                        "aweme_id": "{AWEME_ID}",
                        "video": {{"play_addr": {{"url_list": ["https://{host}/video.mp4"]}}}}
                    }}]
                }}</script>"#
            );
            assert!(parse_router_video_url(&html, AWEME_ID).is_err(), "{host}");
        }
    }

    #[test]
    fn accepts_only_known_https_media_domains() {
        for raw in [
            "https://aweme.snssdk.com/aweme/v1/play/",
            "https://v26-web.douyinvod.com/video.mp4",
            "https://v3-dy-o.zjcdn.com/video.mp4",
            "https://www.douyin.com/aweme/v1/play/",
        ] {
            assert!(validate_media_url(raw).is_ok(), "{raw}");
        }
        for raw in [
            "http://v26-web.douyinvod.com/video.mp4",
            "https://evil-snssdk.com/video.mp4",
            "https://douyinvod.com.evil.example/video.mp4",
            "https://v3-dy-o.zjcdn.com:8443/video.mp4",
        ] {
            assert!(validate_media_url(raw).is_err(), "{raw}");
        }
    }
}
