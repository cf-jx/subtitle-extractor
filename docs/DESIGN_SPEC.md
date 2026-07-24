# 文案提取：桌面应用设计规格

## Reference screens

- `primary-empty.png`: new task and empty transcript state.
- `primary-processing.png`: URL processing, transcript editing, and task progress state.

These two images are the visual source of truth for the desktop UI.

## Visible copy

- 文案提取
- 新建任务
- 任务记录
- 设置
- 提取视频文案
- 本地视频
- 视频链接
- 拖入视频，或点击选择
- 支持常见视频与音频格式
- 输出位置
- 选择
- 开始提取
- 正在处理
- 字幕预览
- 完成后，字幕会显示在这里
- 复制文案
- 导出字幕
- 任务队列
- 下载视频
- 提取音频
- 识别字幕
- 生成文件
- 取消
- 仅在本机处理
- Whisper Small

## Design tokens

- Background: `#f6f7f9`
- Surface: `#ffffff`
- Navigation: `#162333`
- Navigation hover: `#203248`
- Primary: `#1769e8`
- Primary hover: `#0f5dcc`
- Success: `#15a45d`
- Danger: `#db3b3b`
- Text: `#171a1f`
- Muted text: `#6c7480`
- Border: `#d9dde4`
- Focus ring: `#1769e8`
- Radius: 6px controls, 8px panels
- Shadow: only for menus and dialogs
- Spacing scale: 4, 8, 12, 16, 24, 32
- Motion: 160ms for controls, 240ms for panels

## Typography

- UI family: system sans-serif.
- Page title: 26px / 34px / 700.
- Panel title: 16px / 24px / 650.
- Body and controls: 14px / 20px / 500.
- Caption: 12px / 18px / 500.
- Transcript text: 15px / 24px / 400.

## Component families

- App shell: compact left navigation and a two-row workspace.
- Source form: segmented local/URL input, output folder selector, primary action.
- Transcript panel: empty state or editable timestamped segments.
- Task table: stage, progress, status, and task actions.
- Dialogs: errors, overwrite confirmation, and settings.
- Buttons: primary, secondary, quiet, and danger.
- Status: queued, active, completed, failed, and cancelled.

## Interaction requirements

- Local file picker and drag/drop both select the same source.
- URL input accepts only supported Douyin and TikTok HTTPS links.
- Output directory must be selected before starting.
- Only one processing job runs at a time; queued jobs remain visible.
- Active jobs can be cancelled.
- Progress is stage-aware and never fabricated when total work is unknown.
- Completed transcript segments are editable before export.
- Copy exports plain text. Export writes TXT, SRT, and VTT.
- Keyboard focus is always visible.
- The layout remains usable at 1024×680 and scales cleanly above 1440×900.

## Intentional platform behavior

- The same UI and feature set ships on macOS and Windows.
- macOS uses the native system window frame.
- Windows uses the native system window frame.
- Platform-specific filesystem paths are never hard-coded in visible UI.
