# BC Listen Together - UI 架构文档

## 系统架构概览

```
┌─────────────────────────────────────────────────────┐
│              BC Listen Together                       │
├─────────────────────────────────────────────────────┤
│                    UI 层 (ui.js)                     │
│  ┌──────────────────────────────────────────────┐   │
│  │    DraggableWindow (窗口管理)                 │   │
│  │  ┌─────────────────────────────────────────┐│   │
│  │  │  房间列表模式  │  播放器模式             ││   │
│  │  │               │  (分为左右面板)         ││   │
│  │  └─────────────────────────────────────────┘│   │
│  └──────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────┤
│              事件同步层 (sync.js)                    │
│  • Supabase Realtime 连接                           │
│  • 事件发送/接收 (video_shared, sync)               │
├─────────────────────────────────────────────────────┤
│              状态管理层 (state.js)                   │
│  • 全局状态对象 (state)                             │
│  • 设置持久化 (localStorage)                        │
│  • 回调管理 (onRemoteVideoShared)                  │
├─────────────────────────────────────────────────────┤
│           媒体处理层 (bilibili.js)                   │
│  • Bilibili URL 解析                                │
│  • 播放器 URL 构建                                  │
└─────────────────────────────────────────────────────┘
```

## 组件设计

### 1. DraggableWindow 类

**职责**：管理可拖动的浮窗

**属性**：
```javascript
{
    title: string,               // 窗口标题
    width: number,              // 宽度
    height: number,             // 高度
    x: number, y: number,       // 位置
    isDragging: boolean,        // 是否正在拖动
    container: HTMLElement,     // DOM 容器
    content: HTMLElement,       // 内容区域
    headerEl: HTMLElement       // 头部区域
}
```

**方法**：
```javascript
create()          // 创建 DOM 元素
show()           // 显示窗口
close()          // 关闭窗口
setContent()     // 设置内容
onDragStart()    // 拖动事件处理
onDragMove()
onDragEnd()
```

**生命周期**：
```
new DraggableWindow() → create() → show() ← 用户操作
                        ↓
                    setContent()
                        ↓
                      close()
```

### 2. UI 模式管理

#### 模式状态图

```
        ┌─────────────────┐
        │  应用启动        │
        └────────┬────────┘
                 │
        ┌────────▼────────┐
        │  隐藏(仅按钮)    │
        └────────┬────────┘
                 │ 点击♫按钮
        ┌────────▼────────┐
        │  房间列表模式    │ ◄────┐
        └────────┬────────┘      │
                 │ 选择房间并加入 │
        ┌────────▼────────┐      │
        │  播放器模式      │      │
        │ (左播放/右列表)  │      │
        └────────┬────────┘      │
                 │ 离开房间      │
                 └──────────────┘
```

### 3. 房间列表模式 (`showRoomListMode`)

**显示内容**：
- Supabase 配置表单
- 房间列表（可滚动）
- 刷新按钮
- 状态提示

**数据流**：
```
用户点击刷新
    ↓
loadAndDisplayRooms()
    ↓
fetchRooms (目前硬编码)
    ↓
renderRoomItems()
    ↓
绑定点击事件
```

**事件处理**：
```javascript
点击房间 → promptForPasscodeAndJoin()
或点击刷新 → loadAndDisplayRooms()
```

### 4. 播放器模式 (`showPlayerMode`)

**布局**：
```
┌──────────────────────────────────────┐
│  BC Listen Together - Player         │ × 关闭
├──────────────────────────────────────┤
│                                      │
│  ┌────────────────┐  ┌────────────┐ │
│  │                │  │  视频列表   │ │
│  │  播放器        │  │            │ │
│  │  (iframe)      │  │ video-1    │ │
│  │                │  │ video-2    │ │
│  ├────────────────┤  │ video-3    │ │
│  │ + Add 视频     │  │            │ │
│  │ Leave Room  │  │            │ │
│  └────────────────┘  └────────────┘ │
│                                      │
│ Room: room-1 (状态栏)                │
└──────────────────────────────────────┘
```

**HTML 结构**：
```html
<div class="player-container">
  <div class="player-panel">
    <div id="bclt-player-container"></div>
    <div class="player-controls">
      <button>+ Add Video</button>
      <button>Leave Room</button>
    </div>
    <div id="bclt-player-status"></div>
  </div>
  <div class="video-list">
    <div class="video-list-title">Shared Videos</div>
    <div class="video-list-content"></div>
  </div>
</div>
```

### 5. 视频管理

**数据结构**：
```javascript
const activeVideos = [
    {
        sender: "Alice",
        bvid: "BV1xx11xx1x",
        url: "https://www.bilibili.com/video/BV1xx11xx1x",
        timestamp: 1712700000000
    },
    // ...
]
```

**操作流程**：

```
添加视频流程：
┌──────────────────────────────────┐
│ 点击 "+ Add Video (Bilibili)"    │
└──────────────┬───────────────────┘
               │
    ┌──────────▼─────────────┐
    │ prompt 输入视频 URL    │
    └──────────┬─────────────┘
               │
    ┌──────────▼─────────────────────────┐
    │ addVideoToRoom(userInput)           │
    │  ├─ 解析 URL/BV ID                  │
    │  ├─ 验证格式                        │
    │  ├─ 添加到 activeVideos 本地       │
    │  └─ publish('video_shared') → 广播 │
    └──────────┬─────────────────────────┘
               │
    ┌──────────▼──────────────┐
    │ updateVideoList()        │
    │ 渲染视频到列表          │
    └──────────────────────────┘

播放视频流程：
┌──────────────────────┐
│ 点击列表中的视频     │
└──────────┬───────────┘
           │
┌──────────▼─────────────────────┐
│ playVideo(bvid)                 │
│  ├─ buildBilibiliPlayerUrl()    │
│  └─ 设置 iframe.src             │
└─────────────────────────────────┘
```

## 事件系统

### Supabase Realtime 事件

**发送的事件**：

1. **video_shared** - 视频共享
   ```javascript
   {
       type: 'broadcast',
       event: 'video_shared',
       payload: {
           bvid: "BV1xx11xx1x",
           url: "https://www.bilibili.com/video/BV1xx11xx1x",
           senderName: "Alice"
       }
   }
   ```

2. **sync** - 媒体状态同步（现有）
   ```javascript
   {
       type: 'broadcast',
       event: 'sync',
       payload: {
           // 媒体状态信息
       }
   }
   ```

**接收的事件**：

```javascript
// 在 sync.js joinRoom() 中
channel.on('broadcast', { event: 'video_shared' }, async ({ payload }) => {
    if (state.onRemoteVideoShared) {
        await state.onRemoteVideoShared(payload);
    }
});
```

### UI 状态回调

```javascript
// 在 state.js 中
state.onRemoteVideoShared = async (payload) => {
    // payload = { bvid, url, senderName }
    // 处理远程视频共享
}
```

## 数据流

### 本地视频添加

```
用户输入
  ↓
addVideoToRoom()
  ├─ 解析输入
  ├─ 验证格式
  ├─ localActiveVideos.push()
  ├─ publish('video_shared', payload)
  └─ updateVideoList()
      └─ 渲染到 DOM
```

### 远程视频接收

```
Supabase Realtime 事件
  ↓
sync.js 事件监听器
  ↓
state.onRemoteVideoShared 回调
  ↓
addVideoToRoom (UI)
  ├─ activeVideos.push()
  └─ updateVideoList()
      └─ 更新 DOM
```

## 状态管理

### 全局状态对象 (state)

```javascript
state = {
    settings: {
        supabaseUrl,
        supabaseAnonKey,
        roomId,
        roomPasscode,
        displayName,
        mediaUrl,
        isHost,
        driftThresholdMs
    },
    
    // 连接状态
    supabase: null,
    channel: null,
    connected: false,
    
    // 媒体状态
    bilibili: { ... },
    embedFrame: null,
    
    // UI 回调
    onRemoteVideoShared: null,
    
    // 其他
    // ...
}
```

### 本地 UI 状态

```javascript
// ui.js
let windowInstance = null;           // 当前窗口
let buttonElement = null;            // 打开按钮
let activeVideos = [];               // 房间视频列表
```

## CSS 架构

### 命名约定

```
#bclt-*           - 全局 ID
.bclt-*           - 全局类
.form-group       - 表单组
.btn-*            - 按钮变体
.video-item       - 列表项
```

### 布局系统

```css
/* 浮窗 */
position: fixed
display: flex
flex-direction: column

/* 播放器容器 */
display: grid
grid-template-columns: 1fr 1fr
gap: 12px

/* 视频列表 */
display: flex
flex-direction: column
overflow-y: auto
```

## 扩展点

### 添加新模式

```javascript
function showNewMode() {
    if (!windowInstance) {
        windowInstance = new DraggableWindow({
            title: 'New Mode',
            width: 800,
            height: 600,
        });
        windowInstance.create();
    }
    
    windowInstance.setContent(`
        <!-- HTML 内容 -->
    `);
    
    // 事件绑定
    windowInstance.content.querySelector('#element').addEventListener('click', () => {
        // 处理
    });
    
    windowInstance.show();
}
```

### 添加新事件

```javascript
// sync.js
channel.on('broadcast', { event: 'new_event' }, async ({ payload }) => {
    if (state.onNewEvent) {
        await state.onNewEvent(payload);
    }
});

// state.js
state.onNewEvent = null;

// ui.js
state.onNewEvent = async (payload) => {
    // 处理逻辑
};
```

## 性能考虑

### 内存管理

- 窗口关闭时清理回调：`state.onRemoteVideoShared = null`
- 离开房间时清空视频列表：`activeVideos = []`

### DOM 性能

- 视频列表项使用事件委托（当前未实现）
- 考虑虚拟滚动（对于大列表）

### 网络优化

- Supabase 事件过滤已在频道配置中设置
- 广播事件不包含 self

## 安全考虑

- Supabase 密钥应使用匿名密钥（已完成）
- URL 验证防止注入（基本实现完成）
- HTML 内容使用 innerHTML（需要审查）

## 测试建议

### 单元测试

```javascript
describe('DraggableWindow', () => {
    test('should create window', () => {});
    test('should handle drag events', () => {});
    test('should update position', () => {});
});

describe('addVideoToRoom', () => {
    test('should parse BV ID', () => {});
    test('should validate format', () => {});
    test('should publish event', () => {});
});
```

### 集成测试

```javascript
describe('Video Sharing Flow', () => {
    test('add local video and receive remote', async () => {});
    test('update video list on remote event', async () => {});
});
```

## 故障排除指南

### 窗口不显示

1. 检查 z-index 冲突
2. 验证 DOM 已添加到 body
3. 检查 CSS 是否加载

### 视频未播放

1. 验证 BV ID 格式
2. 检查 iframe 权限
3. 查看控制台错误

### 实时同步失败

1. 检查 Supabase 连接
2. 验证房间 ID 和 passcode
3. 查看网络连接状态

