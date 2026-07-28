use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[cfg(test)]
use regex::Regex;
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use crate::domain::{ExportFormat, OutputFiles, TranscriptSegment};

const RESERVATION_PREFIX: &str = ".subtitle-extractor-reservation-";

#[derive(Debug)]
pub struct OutputReservation {
    _file: File,
}

pub fn reserve_export(
    lock_root: &Path,
    output_dir: &Path,
    output_stem: &str,
    export_format: ExportFormat,
) -> Result<OutputReservation, String> {
    ensure_export_available(output_dir, output_stem, export_format)?;

    let path = reservation_path(lock_root, output_dir, output_stem, export_format)?;
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|error| format!("无法打开字幕输出锁：{error}"))?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|error| {
        if error.kind() == fs2::lock_contended_error().kind() {
            "同名字幕任务正在处理中，请等待该任务结束".to_string()
        } else {
            format!("无法锁定字幕输出位置：{error}")
        }
    })?;

    ensure_export_available(output_dir, output_stem, export_format)?;

    Ok(OutputReservation { _file: file })
}

fn reservation_path(
    lock_root: &Path,
    output_dir: &Path,
    output_stem: &str,
    export_format: ExportFormat,
) -> Result<PathBuf, String> {
    fs::create_dir_all(lock_root).map_err(|error| format!("无法创建字幕输出锁目录：{error}"))?;
    let canonical_output =
        fs::canonicalize(output_dir).map_err(|error| format!("无法验证字幕输出目录：{error}"))?;
    let output_key = canonical_output.to_string_lossy();
    #[cfg(windows)]
    let output_key = output_key.to_lowercase();

    let mut hasher = Sha256::new();
    hasher.update(output_key.as_bytes());
    hasher.update([0]);
    hasher.update(output_stem.as_bytes());
    hasher.update([0]);
    hasher.update(export_format.extension().as_bytes());
    let digest = hasher.finalize();
    Ok(lock_root.join(format!("{RESERVATION_PREFIX}{digest:x}.lock")))
}

#[cfg(test)]
fn parse_srt(content: &str) -> Result<Vec<TranscriptSegment>, String> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let timestamp = Regex::new(
        r"(?m)^\s*(\d{2,}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2,}):(\d{2}):(\d{2}),(\d{3})\s*$",
    )
    .map_err(|error| error.to_string())?;

    let mut segments = Vec::new();
    let mut lines = normalized.lines().peekable();
    while let Some(line) = lines.next() {
        if line.trim().is_empty() {
            continue;
        }

        let index = line.trim().parse::<usize>().unwrap_or(segments.len() + 1);
        let timing = lines
            .next()
            .ok_or_else(|| "字幕文件缺少时间轴".to_string())?;
        let captures = timestamp
            .captures(timing)
            .ok_or_else(|| format!("无法解析字幕时间轴：{timing}"))?;

        let start_ms = timestamp_parts_to_ms(&captures, 1)?;
        let end_ms = timestamp_parts_to_ms(&captures, 5)?;
        if end_ms <= start_ms {
            return Err("字幕结束时间必须晚于开始时间".into());
        }

        let mut text_lines = Vec::new();
        while let Some(next) = lines.peek() {
            if next.trim().is_empty() {
                lines.next();
                break;
            }
            text_lines.push(lines.next().unwrap_or_default().trim().to_string());
        }

        let text = text_lines.join("\n").trim().to_string();
        if !text.is_empty() {
            segments.push(TranscriptSegment {
                index,
                start_ms,
                end_ms,
                text,
            });
        }
    }

    normalize_segments(segments)
}

#[cfg(test)]
fn timestamp_parts_to_ms(captures: &regex::Captures<'_>, offset: usize) -> Result<u64, String> {
    let parse = |index: usize| {
        captures[index]
            .parse::<u64>()
            .map_err(|_| "字幕时间轴包含无效数字".to_string())
    };
    Ok(parse(offset)? * 3_600_000
        + parse(offset + 1)? * 60_000
        + parse(offset + 2)? * 1_000
        + parse(offset + 3)?)
}

pub fn normalize_segments(
    mut segments: Vec<TranscriptSegment>,
) -> Result<Vec<TranscriptSegment>, String> {
    if segments.is_empty() {
        return Err("没有识别到可导出的语音内容".into());
    }

    segments.sort_by_key(|segment| (segment.start_ms, segment.end_ms));
    let mut previous_start_ms = None;
    for (index, segment) in segments.iter_mut().enumerate() {
        if segment.end_ms <= segment.start_ms {
            return Err("字幕结束时间必须晚于开始时间".into());
        }
        if previous_start_ms.is_some_and(|start_ms| segment.start_ms < start_ms) {
            return Err("字幕时间轴必须递增".into());
        }
        let text = normalize_cue_text(&segment.text);
        if text.is_empty() {
            return Err("字幕内容不能为空".into());
        }
        previous_start_ms = Some(segment.start_ms);
        segment.index = index + 1;
        segment.text = text;
    }
    Ok(segments)
}

fn normalize_cue_text(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn render_txt(segments: &[TranscriptSegment], include_timestamps: bool) -> String {
    let mut output = segments
        .iter()
        .map(|segment| {
            if include_timestamps {
                format!(
                    "[{} --> {}] {}",
                    format_srt_timestamp(segment.start_ms),
                    format_srt_timestamp(segment.end_ms),
                    segment.text.trim()
                )
            } else {
                segment.text.trim().to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    output.push('\n');
    output
}

pub fn render_srt(segments: &[TranscriptSegment]) -> String {
    let mut output = String::new();
    for (index, segment) in segments.iter().enumerate() {
        output.push_str(&(index + 1).to_string());
        output.push('\n');
        output.push_str(&format_srt_timestamp(segment.start_ms));
        output.push_str(" --> ");
        output.push_str(&format_srt_timestamp(segment.end_ms));
        output.push('\n');
        output.push_str(segment.text.trim());
        output.push_str("\n\n");
    }
    output
}

pub fn render_vtt(segments: &[TranscriptSegment]) -> String {
    let mut output = String::from("WEBVTT\n\n");
    for segment in segments {
        output.push_str(&format_vtt_timestamp(segment.start_ms));
        output.push_str(" --> ");
        output.push_str(&format_vtt_timestamp(segment.end_ms));
        output.push('\n');
        output.push_str(segment.text.trim());
        output.push_str("\n\n");
    }
    output
}

pub fn write_export(
    output_dir: &Path,
    output_stem: &str,
    segments: Vec<TranscriptSegment>,
    export_format: ExportFormat,
    include_timestamps: bool,
) -> Result<OutputFiles, String> {
    let segments = normalize_segments(segments)?;
    let content = match export_format {
        ExportFormat::Txt => render_txt(&segments, include_timestamps),
        ExportFormat::Srt => render_srt(&segments),
        ExportFormat::Vtt => render_vtt(&segments),
    };
    let destination = export_path(output_dir, output_stem, export_format);
    ensure_export_available(output_dir, output_stem, export_format)?;

    let mut file = NamedTempFile::new_in(output_dir)
        .map_err(|error| format!("创建字幕临时文件失败：{error}"))?;
    file.write_all(content.as_bytes())
        .and_then(|_| file.as_file().sync_all())
        .map_err(|error| format!("写入字幕文件失败：{error}"))?;
    file.persist_noclobber(&destination)
        .map_err(|error| format!("保存字幕文件失败，且未覆盖已有文件：{}", error.error))?;

    let exported_path = path_to_string(&destination)?;

    Ok(OutputFiles {
        txt: (export_format == ExportFormat::Txt).then(|| exported_path.clone()),
        srt: (export_format == ExportFormat::Srt).then(|| exported_path.clone()),
        vtt: (export_format == ExportFormat::Vtt).then_some(exported_path),
    })
}

pub fn ensure_export_available(
    output_dir: &Path,
    output_stem: &str,
    export_format: ExportFormat,
) -> Result<(), String> {
    let existing = export_path(output_dir, output_stem, export_format);
    if existing.exists() {
        return Err(format!(
            "输出文件已存在：{}。请更换输出文件夹或移走同名文件",
            existing
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("字幕文件")
        ));
    }
    Ok(())
}

pub fn next_available_export_stem(
    output_dir: &Path,
    base_stem: &str,
    export_format: ExportFormat,
) -> Result<String, String> {
    for index in 1..=9_999 {
        let candidate = if index == 1 {
            base_stem.to_string()
        } else {
            format!("{base_stem}-{index}")
        };
        if !export_path(output_dir, &candidate, export_format).exists() {
            return Ok(candidate);
        }
    }

    Err("同一任务的编辑版导出文件过多，请整理输出文件夹后重试".into())
}

pub fn remove_exports(outputs: &OutputFiles) {
    for path in [&outputs.txt, &outputs.srt, &outputs.vtt]
        .into_iter()
        .flatten()
    {
        let _ = fs::remove_file(path);
    }
}

fn export_path(output_dir: &Path, output_stem: &str, export_format: ExportFormat) -> PathBuf {
    output_dir.join(format!("{output_stem}.{}", export_format.extension()))
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "输出路径不是有效 UTF-8".to_string())
}

fn format_srt_timestamp(ms: u64) -> String {
    format_timestamp(ms, ',')
}

fn format_vtt_timestamp(ms: u64) -> String {
    format_timestamp(ms, '.')
}

fn format_timestamp(ms: u64, separator: char) -> String {
    let hours = ms / 3_600_000;
    let minutes = (ms / 60_000) % 60;
    let seconds = (ms / 1_000) % 60;
    let milliseconds = ms % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02}{separator}{milliseconds:03}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn example_segments() -> Vec<TranscriptSegment> {
        vec![
            TranscriptSegment {
                index: 1,
                start_ms: 0,
                end_ms: 1_250,
                text: "第一句。".into(),
            },
            TranscriptSegment {
                index: 2,
                start_ms: 1_500,
                end_ms: 3_050,
                text: "Second line.".into(),
            },
        ]
    }

    #[test]
    fn parses_srt_and_preserves_utf8() {
        let parsed = parse_srt(
            "1\n00:00:00,000 --> 00:00:01,250\n第一句。\n\n2\n00:00:01,500 --> 00:00:03,050\nSecond line.\n",
        )
        .unwrap();
        assert_eq!(parsed, example_segments());
    }

    #[test]
    fn renders_valid_srt_and_vtt() {
        let segments = example_segments();
        assert!(render_srt(&segments).contains("00:00:00,000 --> 00:00:01,250"));
        let vtt = render_vtt(&segments);
        assert!(vtt.starts_with("WEBVTT\n\n"));
        assert!(vtt.contains("00:00:01.500 --> 00:00:03.050"));
    }

    #[test]
    fn renders_txt_with_timestamps() {
        assert_eq!(
            render_txt(&example_segments(), true),
            "[00:00:00,000 --> 00:00:01,250] 第一句。\n\
[00:00:01,500 --> 00:00:03,050] Second line.\n"
        );
    }

    #[test]
    fn renders_txt_without_timestamps() {
        assert_eq!(
            render_txt(&example_segments(), false),
            "第一句。\nSecond line.\n"
        );
    }

    #[test]
    fn rejects_invalid_timestamps() {
        assert!(parse_srt("1\n00:00:02,000 --> 00:00:01,000\n错误\n").is_err());
    }

    #[test]
    fn normalizes_blank_lines_inside_cues() {
        let segments = normalize_segments(vec![TranscriptSegment {
            index: 7,
            start_ms: 0,
            end_ms: 1_000,
            text: "第一行\r\n\r\n  第二行  \n".into(),
        }])
        .unwrap();

        assert_eq!(segments[0].index, 1);
        assert_eq!(segments[0].text, "第一行\n第二行");
        assert_eq!(
            render_srt(&segments),
            "1\n00:00:00,000 --> 00:00:01,000\n第一行\n第二行\n\n"
        );
    }

    #[test]
    fn writes_utf8_exports_without_overwriting_existing_files() {
        let output = tempdir().unwrap();
        let files = write_export(
            output.path(),
            "访谈",
            example_segments(),
            ExportFormat::Srt,
            true,
        )
        .unwrap();

        assert!(fs::read_to_string(files.srt.as_ref().unwrap())
            .unwrap()
            .contains("00:00:01,500 --> 00:00:03,050"));
        assert!(files.txt.is_none());
        assert!(files.vtt.is_none());

        let error = write_export(
            output.path(),
            "访谈",
            example_segments(),
            ExportFormat::Srt,
            true,
        )
        .unwrap_err();
        assert!(error.contains("输出文件已存在"));

        remove_exports(&files);
        assert!(!Path::new(files.srt.as_ref().unwrap()).exists());
    }

    #[test]
    fn allocates_numbered_stems_for_repeated_edited_exports() {
        let output = tempdir().unwrap();
        fs::write(output.path().join("访谈-编辑.srt"), "existing").unwrap();
        fs::write(output.path().join("访谈-编辑-2.srt"), "existing").unwrap();

        assert_eq!(
            next_available_export_stem(output.path(), "访谈-编辑", ExportFormat::Srt).unwrap(),
            "访谈-编辑-3"
        );
        assert_eq!(
            next_available_export_stem(output.path(), "访谈-编辑", ExportFormat::Txt).unwrap(),
            "访谈-编辑"
        );
    }

    #[test]
    fn reserves_output_names_across_jobs_and_releases_on_drop() {
        let output = tempdir().unwrap();
        let locks = tempdir().unwrap();
        let first =
            reserve_export(locks.path(), output.path(), "同名视频", ExportFormat::Txt).unwrap();

        let conflict =
            reserve_export(locks.path(), output.path(), "同名视频", ExportFormat::Txt).unwrap_err();
        assert!(conflict.contains("正在处理"));

        drop(first);
        let second =
            reserve_export(locks.path(), output.path(), "同名视频", ExportFormat::Txt).unwrap();
        drop(second);

        fs::write(output.path().join("同名视频.txt"), "existing").unwrap();
        let existing =
            reserve_export(locks.path(), output.path(), "同名视频", ExportFormat::Txt).unwrap_err();
        assert!(existing.contains("输出文件已存在"));
    }

    #[test]
    fn reuses_persistent_lock_files_after_previous_owner_exits() {
        let output = tempdir().unwrap();
        let locks = tempdir().unwrap();
        let path =
            reservation_path(locks.path(), output.path(), "访谈", ExportFormat::Txt).unwrap();
        fs::write(&path, "stale metadata").unwrap();

        let reservation =
            reserve_export(locks.path(), output.path(), "访谈", ExportFormat::Txt).unwrap();
        assert!(path.is_file());
        drop(reservation);

        assert!(reserve_export(locks.path(), output.path(), "访谈", ExportFormat::Txt).is_ok());
    }

    #[test]
    fn same_stem_in_different_output_directories_does_not_conflict() {
        let first_output = tempdir().unwrap();
        let second_output = tempdir().unwrap();
        let locks = tempdir().unwrap();

        let first = reserve_export(
            locks.path(),
            first_output.path(),
            "video",
            ExportFormat::Txt,
        )
        .unwrap();
        let second = reserve_export(
            locks.path(),
            second_output.path(),
            "video",
            ExportFormat::Txt,
        )
        .unwrap();

        drop((first, second));
    }

    #[test]
    fn same_stem_with_different_formats_does_not_conflict() {
        let output = tempdir().unwrap();
        let locks = tempdir().unwrap();

        let txt = reserve_export(locks.path(), output.path(), "video", ExportFormat::Txt).unwrap();
        let srt = reserve_export(locks.path(), output.path(), "video", ExportFormat::Srt).unwrap();

        drop((txt, srt));
    }
}
