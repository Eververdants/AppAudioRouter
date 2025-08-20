# App Audio Router

## Introduction

App Audio Router is a Windows audio routing tool that allows users to route specific application audio output to designated audio devices. This tool is developed based on PyQt5 and uses SoundVolumeView as the backend to implement audio routing functionality.

## Features

- Route specified application audio output to designated audio devices
- Automatically refresh process and device lists
- Automatically remember and apply routing settings
- Clean and intuitive graphical user interface

## System Requirements

- Windows 10/11
- Python 3.10/3.12 (if running from source code)
- SoundVolumeView.exe (included in the packaged version)

## Installation and Running

### Method 1: Using Packaged Version (Recommended)

1. Download the packaged `AppAudioRouter.exe` file
2. Ensure `SoundVolumeView.exe` is in the same directory as `AppAudioRouter.exe` (included in the packaged version)
3. Double-click to run `AppAudioRouter.exe`

### Method 2: Running from Source Code

1. Install Python 3.10 or higher
2. Install dependencies:
   ```
   pip install PyQt5 pycaw psutil
   ```
3. Download SoundVolumeView.exe and place it in the same directory as `app_audio_router.py`
4. Run the program:
   ```
   python app_audio_router.py
   ```

## Usage

### Basic Operations

1. **Launch the Program**: Double-click `AppAudioRouter.exe` to start the program
2. **Refresh Process List**:
   - Click the "刷新进程" (Refresh Processes) button to manually refresh
   - The program automatically refreshes the process list every 3 seconds
   - Note: The target application must be running and producing sound to be detected
3. **Refresh Device List**:
   - Click the "刷新设备" (Refresh Devices) button to manually refresh
   - The program automatically loads the device list on startup
4. **Route Audio**:
   - Select the process to route from the "选择进程" (Select Process) dropdown
   - Select the target audio device from the "选择输出设备" (Select Output Device) dropdown
   - Choose the appropriate default type (usually "全部(all)")
   - Click the "路由到此设备 ▶" (Route to This Device) button to apply settings

### Auto Memory Function

1. Check the "自动记忆并套用给该进程（按可执行名）" (Automatically Remember and Apply to This Process (by Executable Name)) checkbox
2. When enabled, the program will automatically apply previously set routing rules to processes with the same name
3. Routing settings are saved in the `app_audio_router.config.json` file

### View Logs

The log area at the bottom of the program displays operation results and status information, including:
- Process and device list refresh status
- Success or failure information of routing settings
- Configuration file save status

## Additional Tools

### Video to MP3 Converter

The toolkit also includes a standalone video to MP3 converter that can easily extract audio from video files and save it in MP3 format.

#### Features

- Support for single video file conversion
- Support for folder batch conversion
- Support for multiple video formats (MP4, AVI, MOV, MKV, FLV, WMV, etc.)
- Graphical user interface with simple operation
- Conversion progress display

#### Usage

1. Run the `video_to_mp3_converter.py` script (requires Python environment) or use the packaged version
2. Select conversion mode:
   - Single file conversion: Click the "选择单个视频文件" (Select Single Video File) button and choose the video file to convert
   - Folder batch conversion: Click the "选择文件夹批量转换" (Select Folder for Batch Conversion) button and choose the folder containing video files
3. The program will automatically start the conversion process, with the progress bar showing conversion progress
4. After conversion is complete, MP3 files will be saved in the same directory as the original video files

#### System Requirements

- Python 3.10 or higher (if running from source code)
- moviepy library: `pip install moviepy`

### Audio Tag Editor

The toolkit also includes a standalone audio tag editor that can add tag information such as artist name and album name to audio files.

#### Features

- Support for batch adding tags to multiple audio files in a folder
- Support for multiple audio formats (MP3, WAV, FLAC, M4A, OGG, etc.)
- Graphical user interface with simple operation
- Tag editing progress display

#### Usage

1. Run the `audio_tag_editor.py` script (requires Python environment)
2. Click the "浏览" (Browse) button and select the folder containing audio files
3. Fill in the corresponding tag information in the "艺术家名称" (Artist Name) and "专辑名称" (Album Name) input fields
4. Click the "应用标签" (Apply Tags) button to start adding tags to audio files
5. The program will automatically process all audio files and display the results when finished

#### System Requirements

- Python 3.10 or higher (if running from source code)
- mutagen library: `pip install mutagen`

## Technical Information

### Dependencies

- **PyQt5**: For building the graphical user interface
- **pycaw**: For accessing Windows audio sessions
- **psutil**: For process management
- **SoundVolumeView**: For actual audio routing operations

### Working Principle

1. The program uses the `pycaw` library to detect audio sessions and processes in the current system
2. Uses the command-line interface of `SoundVolumeView.exe` to set audio routing
3. Routing settings are based on process PID and audio device ID
4. The auto memory function saves the mapping relationship between process names and device IDs in a configuration file

## File Descriptions

- `AppAudioRouter.exe`: Main program executable file
- `SoundVolumeView.exe`: Audio routing tool
- `app_audio_router.config.json`: Configuration file that saves automatically remembered routing settings
- `favicon.ico`: Program icon file

## Notes

- Some operations may require administrator privileges
- Routing settings made by the program may be lost after the program exits
- Audio routing is not supported for system critical processes
- The auto memory function is based on process executable name, not PID