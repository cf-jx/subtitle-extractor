use std::{
    fs,
    path::{Path, PathBuf},
};

use tempfile::NamedTempFile;
use url::Url;

use crate::douyin;

const SUPPORTED_LOCAL_EXTENSIONS: &[&str] = &[
    "aac", "avi", "flac", "m4a", "m4v", "mkv", "mov", "mp3", "mp4", "mpeg", "mpg", "ogg", "opus",
    "wav", "webm", "wmv",
];

pub fn validate_video_url(raw: &str) -> Result<Url, String> {
    if raw.len() > 4_096 {
        return Err("视频链接过长".into());
    }

    let parsed = Url::parse(raw.trim()).map_err(|_| "请输入有效的视频链接")?;
    if parsed.scheme() != "https" {
        return Err("只支持 HTTPS 抖音或 TikTok 链接".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("视频链接不能包含账号信息".into());
    }
    if parsed.port().is_some() {
        return Err("视频链接不能包含自定义端口".into());
    }

    let supported = if douyin::is_douyin_host(&parsed) {
        douyin::is_supported_url(&parsed)
    } else {
        is_supported_tiktok_url(&parsed)
    };
    if !supported {
        return Err("只支持抖音或 TikTok 的单个视频链接".into());
    }

    Ok(parsed)
}

fn is_supported_tiktok_url(url: &Url) -> bool {
    let Some(host) = normalized_host(url) else {
        return false;
    };
    let Some(segments) = strict_path_segments(url.path()) else {
        return false;
    };

    match (host.as_str(), segments.as_slice()) {
        ("www.tiktok.com" | "tiktok.com", [user, "video", id]) => {
            user.strip_prefix('@').is_some_and(is_safe_tiktok_user) && is_safe_numeric_id(id)
        }
        ("www.tiktok.com", ["t", code]) | ("vm.tiktok.com" | "vt.tiktok.com", [code]) => {
            is_safe_share_code(code)
        }
        _ => false,
    }
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

fn is_safe_numeric_id(value: &str) -> bool {
    (1..=32).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_safe_share_code(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_safe_tiktok_user(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

pub fn validate_local_file(raw: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(raw).map_err(|_| "找不到所选视频文件")?;
    if !path.is_file() {
        return Err("所选路径不是文件".into());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "无法识别文件格式".to_string())?;

    if !SUPPORTED_LOCAL_EXTENSIONS.contains(&extension.as_str()) {
        return Err("暂不支持这个音视频格式".into());
    }

    Ok(path)
}

pub fn validate_output_dir(raw: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(raw).map_err(|_| "找不到输出文件夹")?;
    if !path.is_dir() {
        return Err("输出位置必须是文件夹".into());
    }

    let probe = NamedTempFile::new_in(&path).map_err(|_| "输出文件夹不可写")?;
    probe.close().map_err(|_| "无法清理输出文件夹写入测试")?;

    Ok(path)
}

pub fn safe_output_stem(path: &Path) -> String {
    let candidate = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("字幕");
    sanitize_stem(candidate)
}

pub fn sanitize_stem(candidate: &str) -> String {
    let mut value = String::with_capacity(candidate.len().min(80));
    for character in candidate.chars().take(80) {
        if character.is_alphanumeric()
            || matches!(character, ' ' | '-' | '_' | '（' | '）' | '(' | ')')
        {
            value.push(character);
        } else {
            value.push('_');
        }
    }
    let trimmed = value.trim_matches([' ', '.', '_']).trim();
    if trimmed.is_empty() {
        return "字幕".to_string();
    }

    let reserved = matches!(
        trimmed.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    if reserved {
        format!("{trimmed}_")
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_video_urls() {
        for url in [
            "https://www.douyin.com/video/7381234567890123456",
            "https://www.douyin.com/share/video/7381234567890123456?previous_page=app",
            "https://www.iesdouyin.com/share/video/7381234567890123456/",
            "https://iesdouyin.com/share/video/7381234567890123456?from_ssr=1",
            "https://m.douyin.com/share/video/7381234567890123456/",
            "https://v.douyin.com/iAQ8brvP/?region=CN",
            "https://www.tiktok.com/@user.name/video/7381234567890123456?lang=en",
            "https://tiktok.com/@user_name/video/7381234567890123456",
            "https://vm.tiktok.com/ZM12345/",
            "https://vt.tiktok.com/ZS12345/",
            "https://www.tiktok.com/t/ZM12345/",
        ] {
            assert!(validate_video_url(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn rejects_unsafe_or_unsupported_urls() {
        for url in [
            "http://www.douyin.com/video/123",
            "file:///etc/passwd",
            "https://tiktok.com.evil.example/video/123",
            "https://127.0.0.1/video/123",
            "https://www.youtube.com/watch?v=123",
            "https://user:pass@tiktok.com/video/123",
            "https://tiktok.com:8443/video/123",
            "https://www.douyin.com/",
            "https://www.douyin.com/live/7381234567890123456",
            "https://www.douyin.com/video/not-a-number",
            "https://www.douyin.com/video/7381234567890123456/extra",
            "https://evil.douyin.com/video/7381234567890123456",
            "https://www.iesdouyin.com/video/7381234567890123456",
            "https://www.tiktok.com/",
            "https://www.tiktok.com/@user",
            "https://www.tiktok.com/live/7381234567890123456",
            "https://www.tiktok.com/@user/video/not-a-number",
            "https://m.tiktok.com/@user/video/7381234567890123456",
            "https://evil.vm.tiktok.com/ZM12345/",
        ] {
            assert!(validate_video_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn sanitizes_output_stems() {
        assert_eq!(sanitize_stem("../访谈：第一期.mp4"), "访谈_第一期_mp4");
        assert_eq!(sanitize_stem("..."), "字幕");
        assert_eq!(sanitize_stem("CON"), "CON_");
        assert_eq!(sanitize_stem("lpt9"), "lpt9_");
    }
}
