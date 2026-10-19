# DeepChat for macOS

一个原生 macOS 窗口，专门用来打开本机 DeepSeek Harness 里的 **DeepChat** 页面：
大鲸鱼图标、名字叫 DeepChat、启动后自动切到 DeepChat，并把 Harness 左侧的导航栏收起来，
看起来就是一个独立的 Codex 式应用。

## 它怎么工作

DeepChat 目前是 DSH 的客户端插件，页面由本机 DeepSeek Harness 在**启动时选择的回环端口**提供（例如 53254，不是固定端口）。这个 App 是一个约 1 MB 的 Swift / WKWebView 外壳：

1. 从 `~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies` 读取所有本地 Cookie，
   解码签名 payload 里的 `authority`（形如 `127.0.0.1:53254`），按签发时间从新到旧探测；
2. 用一个本地 302 引导页把匹配的 Cookie 交给 WKWebView（WKWebView 对 `HTTPCookie` 的 IP 主机有兼容问题，
   服务端 `Set-Cookie` 才可靠）；
3. 打开发现到的 authority，等页面启动后自动点「DeepChat」入口；
4. 把 Harness 的全局侧栏折叠为 0，让 DeepChat 占满窗口；
5. DeepSeek Harness 没有运行时，自动启动它，连接成功后把它自己的窗口隐藏；
6. 文件上传（PDF / 图片 / 笔记本）、外链、⌘R 重载、全屏、编辑快捷键都可以用。
   菜单「生成图片…」（⌘⇧I）打开 DeepChat 的文生图模态；免费在线通道立即可用，
   Harness 生图通道在配置 provider 并重启 Harness 后可用。
7. **与 Harness 同步**：每 20 秒静默检查一次 Harness 页面 revision 和登录 Cookie；空闲时自动重载，
   插件/页面/Harness 升级不用重装 App，也不用手动刷新；回答流式输出或输入框有草稿时会推迟重载。
8. **模型同步**：Harness 新增、删除或修改模型后，DeepChat 顶栏的同步按钮或窗口重新获得焦点
   （以及每 90 秒）会重新读取模型目录，无需重启 App。

聊天记录存在 **DeepChat.app 自己的 WebKit localStorage** 里。换一个应用/端口后，
DeepChat 的 Superman 记忆体会把会话恢复回来（页面底部会提示「已从记忆体恢复 N 个会话」）。

当前外壳版本 **1.3.0**：Harness 重启后换端口、换 Cookie、换模型（例如
`DeepSeek-V41-Flash` → `DeepSeek-V4.1-Flash`）都不需要改配置；外壳从签名 Cookie 里
发现新 authority 并自动重载。1.1.1 起启动点击只作用于 Harness 侧栏，不会误开模型菜单。

## 构建与安装

需要：macOS 13+、Xcode Command Line Tools（`swiftc`）、已安装 DeepSeek Harness。

```sh
cd deepchat-app
./build.sh --install      # 构建并安装到 /Applications
open /Applications/DeepChat.app
```

只构建不安装：`./build.sh`；图标已预生成在 `assets/DeepChat.icns`，
需要重画图标时用 `./build.sh --icons`（依赖 Python 的 Pillow / numpy）。

## 自动同步

- Harness 端（插件、页面、模型目录、重启后的登录 Cookie）更新后，App 在 20 秒内发现变化；
  没有正在生成的回答、输入框也没有草稿时自动重新载入。
- 输入框有草稿或正在生成时，同步会延后到下一轮，避免打断对话。
- 「设置 → 自动同步 Harness 更新」可以关掉；菜单里的「立即检查同步」（⌘⇧R）手动触发。
- 顶栏模型名旁的刷新按钮会立刻重新读取模型目录。

## 故障排查

- 日志：`~/Library/Logs/DeepChat.log`
- 如果提示「登录凭据没有生效」：先打开一次 DeepSeek Harness，确认它的页面能正常打开，
  回到 DeepChat 点「重新连接」。
- Harness 换端口是正常行为：App 会从 Cookie 的 authority 自动发现。若提示找不到凭据，
  先打开一次 Harness，让它写入新的 Cookie，再点「重新连接」；仍失败时看日志里的
  `using Harness authority ...` 和 `sync check failed` 行。
- 如果 Cookie 数据库里同时存在多个旧 authority，App 会按签发时间探测，选择返回 200 的那个。
- 这个 App 不是沙盒应用；它需要读本机 Harness 的 Cookie 数据库才能免登录。分发前请确认
  接收者了解这一点；没有可用的 Harness Cookie 时，App 会显示连接页而不是静默失败。

## 文件

| 文件 | 作用 |
|---|---|
| `src/main.swift` | 全部 App 代码：窗口、WKWebView、Cookie 引导、侧栏折叠、自动切换 DeepChat、菜单 |
| `make-icon.py` | 从 DSH 的官方大鲸鱼图标提取鲸鱼，画成 DeepSeek 蓝底白鲸鱼的 App 图标 |
| `assets/Info.plist` | Bundle 元数据（名字、id、图标、ATS、最低系统版本） |
| `assets/DeepChat.icns` | 预生成的 App 图标 |
| `build.sh` | 构建 / 签名 / 可选安装脚本 |
