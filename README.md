# 文案提取

Mac 和 Windows 本地字幕提取软件。导入音视频，或粘贴抖音、TikTok 的单个视频链接，即可在本机生成文案与字幕。

## 功能

- 本地导入 MP4、MOV、MKV、WebM、AVI、M4V、MPEG、MPG、WMV、MP3、M4A、WAV、AAC、FLAC、OGG、Opus 等常见格式
- 下载在浏览器里不登录也能正常播放的抖音和 TikTok 单个视频
- 使用内置 Whisper Small Q5_1 模型离线识别中文、英文和中英混合语音
- 实时显示下载、音频提取、识别和导出进度
- 支持取消任务、编辑识别结果、复制文案
- 自动生成 UTF-8 编码的 TXT、SRT 和 VTT
- 音视频和识别结果不上传到服务器

不保证支持私密视频、登录后视频、直播、图集或平台临时限制的链接。

## 架构

- Tauri 2 + Rust：桌面壳、任务队列、本地文件与进程管理
- React + TypeScript：Mac/Windows 共用界面
- FFmpeg 8.1.2：提取 16 kHz 单声道 PCM 音频
- whisper-rs 0.16.0 / whisper.cpp：本地语音识别
- reqwest + rustls：在本机解析抖音官方移动分享页中的视频地址
- yt-dlp 2026.07.04：下载已解析的抖音视频，并解析、下载 TikTok 单视频

软件不需要云端后端。链接下载需要联网，字幕识别和导出均在本机完成。当前 Apple Silicon 构建的 App 为 274 MiB，DMG 安装包为 238 MiB，其中离线模型约 181 MiB；Windows 安装包大小以 Windows 实际构建产物为准。

## 本地开发

要求：

- Node.js 24+
- pnpm 11+
- Rust 1.88+
- CMake
- macOS 13+，或 Windows 10/11 x64

安装依赖：

```bash
pnpm install --frozen-lockfile
```

准备 Apple Silicon Mac 运行资源：

```bash
pnpm runtime:fetch --target aarch64-apple-darwin
pnpm runtime:ffmpeg aarch64-apple-darwin
```

启动桌面应用：

```bash
pnpm tauri dev
```

## 验证

```bash
pnpm lint
pnpm test
pnpm build

cd src-tauri
cargo fmt -- --check
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
```

## 打包

Apple Silicon Mac：

```bash
pnpm package:macos -- aarch64-apple-darwin
```

Intel Mac：

```bash
rustup target add x86_64-apple-darwin
pnpm runtime:fetch --target x86_64-apple-darwin
pnpm runtime:ffmpeg x86_64-apple-darwin
pnpm package:macos -- x86_64-apple-darwin
```

Windows x64 必须在 Windows + MSYS2 UCRT64 环境构建：

```powershell
pnpm runtime:fetch --target x86_64-pc-windows-msvc
C:\msys64\usr\bin\bash.exe -lc "export PATH=/ucrt64/bin:/usr/bin:\$PATH; cd /c/path/to/project; bash scripts/build-ffmpeg-windows.sh x86_64-pc-windows-msvc"
pnpm runtime:verify:windows
pnpm tauri build --target x86_64-pc-windows-msvc --bundles nsis,msi
pnpm runtime:verify:windows:installers
```

仓库内的 GitHub Actions 工作流会分别构建 Mac arm64 和 Windows x64 安装包。当前 Mac 本地包使用 ad-hoc 签名；公开分发前仍需配置 Apple Developer ID 公证和 Windows Authenticode 证书。

## 固定资源与许可证

模型、yt-dlp 和 FFmpeg 源码版本及 SHA-256 固定在 `src-tauri/resources/checksums.json`。第三方许可证和构建策略见 `src-tauri/resources/THIRD_PARTY_NOTICES.md`。
