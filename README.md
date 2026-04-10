# BC Watch Together 🎵

**与朋友实时共同观看 Bilibili 视频的 Bondage Club 用户脚本。**

[English](#english-readme) | 中文

---

## 主要功能

✨ **实时视频共享** – 在房间中与朋友共享 Bilibili 视频  
🎮 **多人协作** – 同一房间内的所有成员可添加和切换视频  
💾 **云端存储** – 基于 Supabase 的安全数据同步  
🖱️ **拖动式浮窗** – 非侵入式的可拖动窗口界面  
🌍 **实时同步** – 使用 Supabase Realtime 获得无延迟更新  

---

## 安装步骤

### 前置条件

- 浏览器：Chrome、Firefox、Edge、Safari（带扩展支持）
- 用户脚本管理器：[Violentmonkey](https://violentmonkey.github.io/) 或 [Tampermonkey](https://www.tampermonkey.net/)

### 安装脚本（推荐使用 Loader）

1. **安装用户脚本管理器**  
   从上面的链接选择您的浏览器并安装扩展程序

2. **安装 Loader 脚本**  
   点击下方按钮在新标签页安装 loader：

   📦 **[安装 BC Watch Together Loader](https://raw.githubusercontent.com/VivianMoonlight/BC-Watch-Together/main/loader.user.js)**

   或手动复制 loader URL 到管理器中：
   ```
   https://raw.githubusercontent.com/VivianMoonlight/BC-Watch-Together/main/loader.user.js
   ```

3. **打开 Bondage Club**  
   访问 https://www.bondageprojects.com 并开始使用！

---

## 使用说明

### 启动脚本

1. 在 Bondage Club 页面加载后，点击屏幕右下角的绿色圆形 **♫** 按钮

### 首次配置

在房间列表模式中，填写以下信息：

| 字段 | 说明 | 示例 |
|------|------|------|
| **Room Name** | 房间名称（必填） | `MyRoom` |
| **Room Passcode** | 房间密码（可选） | `secret123` |

### 加入房间

1. 点击 **Refresh Rooms** 加载可用房间列表
2. 点击要加入的房间
3. 输入房间密码（如需要）
4. 确认加入

### 添加视频

1. 在播放器模式中，点击 **+ Add Video (Bilibili)**
2. 支持以下格式输入：
   - 完整 Bilibili URL：`https://www.bilibili.com/video/BV1xx11xx1x`
   - B23 短链接：`https://b23.tv/xxxxx`
   - 直接 BV ID：`BV1xx11xx1x`
3. 确认添加，视频将立即与房间中的所有成员共享

### 观看视频

- **左侧播放器**：当前播放的 Bilibili 视频
- **右侧列表**：房间内所有成员共享的视频列表
  - 点击列表中的任何视频即可在播放器中播放
  - 显示每个视频来自哪个成员

### 窗口操作

- **拖动**：点住窗口顶部标题栏可拖动窗口位置
- **关闭**：点击窗口右上角的 **×** 按钮
- **重新打开**：点击右下角的 **♫** 按钮

---

## 常见问题

**Q: 我需要房间 URL 和密码吗？**  
A: 是的。房间创建者需要生成这些凭据。您应该从房间创建者处获得 Supabase URL 和匿名密钥。

**Q: 可以添加其他视频网站的视频吗？**  
A: 当前仅支持 Bilibili。未来可能支持其他平台。

**Q: 脚本在我的浏览器上不工作？**  
A: 请确保：
- 用户脚本管理器已正确安装并启用
- 脚本在管理器中处于启用状态
- 您访问的是 https://www.bondageprojects.com
- 浏览器控制台中没有错误（按 F12 打开开发者工具）

**Q: 我的视频列表不更新怎么办？**  
A: 尝试：
1. 点击 **Refresh Rooms** 刷新房间列表
2. 检查网络连接
3. 确保 Supabase 凭据正确
4. 在浏览器控制台查看是否有错误消息

---

## 开发者信息

有兴趣为项目做贡献或运行开发版本？请查看 [DEVELOPER.md](DEVELOPER.md)。

---

## 变更日志

查看完整的版本历史和更新日志：[CHANGELOG_UI.md](CHANGELOG_UI.md)

---

## 许可证

本项目根据 [LICENSE](LICENSE) 中的条款进行许可。

---

## 常用链接

- 🏠 [Bondage Club](https://www.bondageprojects.com)
- 💻 [Violentmonkey](https://violentmonkey.github.io/)
- 🔑 [Supabase](https://supabase.com)

---

## 支持

如遇到问题，请：
1. 检查浏览器控制台是否有错误信息
2. 查阅本 README 中的常见问题
3. 提交问题到 [GitHub Issues](https://github.com/VivianMoonlight/BC-Watch-Together/issues)

---

# English README

# BC Watch Together 🎵

**A Bondage Club userscript to watch Bilibili videos together with friends in real-time.**

## Key Features

✨ **Real-time Video Sharing** – Share Bilibili videos with friends in a room  
🎮 **Multi-user Collaboration** – All room members can add and switch videos  
💾 **Cloud Storage** – Secure data sync powered by Supabase  
🖱️ **Draggable Window** – Non-intrusive, moveable window interface  
🌍 **Real-time Sync** – Zero-latency updates using Supabase Realtime  

## Installation

### Prerequisites

- Browser: Chrome, Firefox, Edge, Safari (with extension support)
- Userscript Manager: [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/)

### Install Script (Loader Recommended)

1. **Install Userscript Manager**  
   Choose your browser from the links above and install the extension

2. **Install Loader Script**  
   Click the button below to install the loader in a new tab:

   📦 **[Install BC Watch Together Loader](https://raw.githubusercontent.com/VivianMoonlight/BC-Watch-Together/main/loader.user.js)**

   Or manually copy the loader URL into your manager:
   ```
   https://raw.githubusercontent.com/VivianMoonlight/BC-Watch-Together/main/loader.user.js
   ```

3. **Open Bondage Club**  
   Visit https://www.bondageprojects.com and start using it!

## Usage

### Start the Script

Click the green circle **♫** button in the bottom-right corner of the page after Bondage Club loads

### Initial Setup

Fill in the following fields in room list mode:

| Field | Description | Example |
|-------|-------------|---------|
| **Room Name** | Room name (required) | `MyRoom` |
| **Room Passcode** | Room password (optional) | `secret123` |

### Join a Room

1. Click **Refresh Rooms** to load available rooms
2. Click the room you want to join
3. Enter the room passcode if required
4. Confirm to join

### Add Videos

1. In player mode, click **+ Add Video (Bilibili)**
2. Enter any of these formats:
   - Full Bilibili URL: `https://www.bilibili.com/video/BV1xx11xx1x`
   - B23 short link: `https://b23.tv/xxxxx`
   - Direct BV ID: `BV1xx11xx1x`
3. Confirm, and the video will be shared with all room members

### Watch Videos

- **Left Player**: Currently playing Bilibili video
- **Right List**: All videos shared in the room
  - Click any video in the list to play it
  - See which member shared each video

### Window Controls

- **Drag**: Click and hold the title bar to move the window
- **Close**: Click the **×** button in the top-right corner
- **Reopen**: Click the **♫** button in the bottom-right corner

## FAQ

**Q: Do I need room URL and password?**  
A: Yes. Contact the room creator to get the Supabase URL and anonymous key.

**Q: Can I add videos from other platforms?**  
A: Currently only Bilibili is supported. Other platforms may be added in the future.

**Q: The script doesn't work on my browser**  
A: Make sure:
- Your userscript manager is installed and enabled
- The script is enabled in the manager
- You're visiting https://www.bondageprojects.com
- There are no errors in the browser console (press F12)

**Q: My video list doesn't update**  
A: Try:
1. Click **Refresh Rooms** to refresh the room list
2. Check your internet connection
3. Verify your Supabase credentials are correct
4. Check the browser console for error messages

## For Developers

Interested in contributing or running the development version? See [DEVELOPER.md](DEVELOPER.md).

## Changelog

View the full release history: [CHANGELOG_UI.md](CHANGELOG_UI.md)

## License

This project is licensed under the [LICENSE](LICENSE).

## Useful Links

- 🏠 [Bondage Club](https://www.bondageprojects.com)
- 💻 [Violentmonkey](https://violentmonkey.github.io/)
- 🔑 [Supabase](https://supabase.com)
- 📂 [GitHub Repository](https://github.com/VivianMoonlight/BC-Watch-Together)
