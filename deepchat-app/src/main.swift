import Cocoa
import WebKit
import SQLite3
import Network

// DeepChat.app — a small native macOS window around the DeepChat page that the
// local DeepSeek Harness already serves. The app reuses the Harness login
// cookie, collapses the Harness navigation column, and opens DeepChat.

private let harnessBundleID = "com.deepseek.dsh"
private let harnessAppPath = "/Applications/DeepSeek Harness.app"
private let desktopCookiePath = ("~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies" as NSString).expandingTildeInPath

private let bootstrapJS = #"""
(() => {
  if (window.__deepchatAppInstalled) return;
  window.__deepchatAppInstalled = true;

  const post = (payload) => {
    try { window.webkit.messageHandlers.deepchat.postMessage(payload); } catch (error) { /* not in the app */ }
  };

  const collapseHarnessSidebar = () => {
    const slot = document.querySelector('[data-slot="sidebar"]');
    const column = slot ? slot.parentElement : null;
    if (!column) return false;
    column.style.width = '0px';
    column.style.minWidth = '0px';
    column.style.maxWidth = '0px';
    column.style.overflow = 'hidden';
    column.style.padding = '0';
    column.style.border = '0';
    const frame = column.parentElement;
    if (frame && getComputedStyle(frame).display === 'grid') {
      frame.style.gridTemplateColumns = '0px minmax(0, 1fr) 0px';
      const handle = frame.querySelector(':scope > [class*="handle"]');
      if (handle) handle.style.display = 'none';
    }
    return true;
  };

  const openDeepChat = () => {
    if (document.querySelector('[data-chat-mode]')) return true;
    // Scope the click to the Harness sidebar: the DeepChat page now also has a
    // brand button whose text contains "DeepChat", and clicking that while the
    // model catalog is still empty would open the app's model menu at launch.
    const sidebar = document.querySelector('[data-slot="sidebar"]');
    if (!sidebar) return false;
    const entries = [...sidebar.querySelectorAll('button, [role="button"]')];
    const entry = entries.find((el) => (el.textContent || '').trim() === 'DeepChat');
    if (!entry) return false;
    entry.click();
    return true;
  };

  let announced = false;
  const tick = () => {
    const collapsed = collapseHarnessSidebar();
    const opened = openDeepChat();
    if (opened && !announced) {
      announced = true;
      post({ kind: 'deepchat-ready', collapsed });
    }
  };

  tick();
  window.addEventListener('load', tick);
  document.addEventListener('DOMContentLoaded', tick);
  let fast = window.setInterval(tick, 400);
  window.setTimeout(() => { window.clearInterval(fast); }, 60000);
  window.setInterval(tick, 1200);
  window.addEventListener('error', (event) => post({ kind: 'script-error', message: String(event.message || '') }));
})();
"""#

private struct StoredCookie {
    let name: String
    let value: String
    /// The exact `127.0.0.1:<port>` authority the Harness server bound this
    /// signed cookie to. The port changes every time Harness restarts.
    let authority: String
    let issuedAt: Double

    var baseURL: URL? {
        URL(string: "http://\(authority)/")
    }
}

/// Decode the signed cookie's payload and read the authority it is bound to.
private func cookieAuthority(from value: String) -> (String, Double)? {
    let parts = value.split(separator: ".")
    guard parts.count >= 2 else { return nil }
    var payload = String(parts[1])
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    while payload.count % 4 != 0 { payload += "=" }
    guard let data = Data(base64Encoded: payload),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let authority = object["authority"] as? String,
          !authority.isEmpty else { return nil }
    let issued = (object["issuedAt"] as? NSNumber)?.doubleValue ?? 0
    return (authority, issued)
}

private let logFilePath = ("~/Library/Logs/DeepChat.log" as NSString).expandingTildeInPath

private func log(_ message: String) {
    let line = "[DeepChat] " + message + "\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
    let url = URL(fileURLWithPath: logFilePath)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    if let data = line.data(using: .utf8) {
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }
}

private func readHarnessCookies() -> [StoredCookie] {
    let manager = FileManager.default
    guard manager.fileExists(atPath: desktopCookiePath) else {
        log("cookie database not found at \(desktopCookiePath)")
        return []
    }
    let temporary = manager.temporaryDirectory.appendingPathComponent("DeepChatCookie-\(UUID().uuidString)")
    try? manager.createDirectory(at: temporary, withIntermediateDirectories: true)
    defer { try? manager.removeItem(at: temporary) }
    let copy = temporary.appendingPathComponent("Cookies")
    do {
        try manager.copyItem(atPath: desktopCookiePath, toPath: copy.path)
        for suffix in ["-wal", "-journal"] {
            let sidecar = desktopCookiePath + suffix
            if manager.fileExists(atPath: sidecar) { try? manager.copyItem(atPath: sidecar, toPath: copy.path + suffix) }
        }
    } catch {
        log("could not copy the cookie database: \(error.localizedDescription)")
        return []
    }

    var database: OpaquePointer?
    guard sqlite3_open_v2(copy.path, &database, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let database else {
        log("could not open the cookie database")
        return []
    }
    defer { sqlite3_close(database) }
    let query = "SELECT name, value FROM cookies WHERE host_key = '127.0.0.1' AND length(value) > 0"
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, query, -1, &statement, nil) == SQLITE_OK, let statement else {
        log("could not read the cookie table")
        return []
    }
    defer { sqlite3_finalize(statement) }
    var cookies: [StoredCookie] = []
    while sqlite3_step(statement) == SQLITE_ROW {
        guard let namePointer = sqlite3_column_text(statement, 0),
              let valuePointer = sqlite3_column_text(statement, 1) else { continue }
        let name = String(cString: namePointer)
        let value = String(cString: valuePointer)
        guard let (authority, issuedAt) = cookieAuthority(from: value) else { continue }
        cookies.append(StoredCookie(name: name, value: value, authority: authority, issuedAt: issuedAt))
    }
    return cookies.sorted { $0.issuedAt > $1.issuedAt }
}

/// A one-page local server whose only job is to hand WebKit the Harness auth
/// cookie in a server-set `Set-Cookie` response, then let the page navigate to
/// the real DeepChat origin. WKWebView refuses to attach a manually stored
/// `HTTPCookie` to an IP-literal host, while server-set cookies work.
private final class BootstrapServer {
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.deepseek.deepchat.bootstrap")
    private let cookie: StoredCookie
    private let target: URL

    init(cookie: StoredCookie, target: URL) {
        self.cookie = cookie
        self.target = target
    }

    func start(completion: @escaping (Int?) -> Void) {
        do {
            let listener = try NWListener(using: .tcp, on: .any)
            self.listener = listener
            listener.newConnectionHandler = { [weak self] connection in
                self?.handle(connection)
            }
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    let port = Int(listener.port?.rawValue ?? 0)
                    DispatchQueue.main.async { completion(port > 0 ? port : nil) }
                case .failed, .cancelled:
                    DispatchQueue.main.async { completion(nil) }
                default:
                    break
                }
            }
            listener.start(queue: queue)
        } catch {
            log("bootstrap listener could not start: \(error.localizedDescription)")
            completion(nil)
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self else {
                connection.cancel()
                return
            }
            let requestLine = data.flatMap { String(data: $0, encoding: .utf8) }?
                .split(separator: "\r\n").first.map(String.init) ?? ""
            if requestLine.contains("favicon") {
                self.send(connection, status: "204 No Content", headers: [:], body: "", contentType: nil)
                return
            }
            let cookieHeader = "\(self.cookie.name)=\(self.cookie.value); Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly"
            self.send(connection, status: "302 Found", headers: ["Set-Cookie": cookieHeader, "Location": self.target.absoluteString], body: "", contentType: nil)
        }
    }

    private func send(_ connection: NWConnection, status: String, headers: [String: String], body: String, contentType: String?) {
        let bodyData = body.data(using: .utf8) ?? Data()
        var response = "HTTP/1.1 \(status)\r\nContent-Length: \(bodyData.count)\r\nConnection: close\r\n"
        if let contentType {
            response += "Content-Type: \(contentType)\r\n"
        }
        for (key, value) in headers {
            response += "\(key): \(value)\r\n"
        }
        response += "\r\n"
        var payload = response.data(using: .utf8) ?? Data()
        payload.append(bodyData)
        connection.send(content: payload, completion: .contentProcessed { _ in connection.cancel() })
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var launchView: NSView!
    private var spinner: NSProgressIndicator!
    private var statusLabel: NSTextField!
    private var startButton: NSButton!
    private var retryButton: NSButton!

    private var snapshotPath: String?
    private var snapshotReport: [String: Any] = [:]
    private var readyMessage: [String: Any]?
    private var pollTimer: Timer?
    private var pollCount = 0
    private var launchedHarness: NSRunningApplication?
    private var pageLoaded = false
    private var cookieRetried = false
    private var didCapture = false
    private var authRetries = 0
    private var bootstrapServer: BootstrapServer?
    private var targetURL: URL?
    private var activeAuth: StoredCookie?
    private var syncTimer: Timer?
    private var syncWork: DispatchWorkItem?
    private var lastPageHTML: Data?
    private var loadedCookieValue: String?
    private var syncFailures = 0
    private var syncing = false
    private var autoSyncEnabled = true
    private var harnessRestartInFlight = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let index = CommandLine.arguments.firstIndex(of: "--snapshot"), index + 1 < CommandLine.arguments.count {
            snapshotPath = CommandLine.arguments[index + 1]
        }
        if let index = CommandLine.arguments.firstIndex(of: "--target"), index + 1 < CommandLine.arguments.count, let url = URL(string: CommandLine.arguments[index + 1]) {
            targetURL = url
        }
        if UserDefaults.standard.object(forKey: "DeepChatAutoSync") != nil {
            autoSyncEnabled = UserDefaults.standard.bool(forKey: "DeepChatAutoSync")
        }
        buildMenu()
        buildWindow()
        begin()
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            self.window.makeKeyAndOrderFront(nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationDidBecomeActive(_ notification: Notification) {
        checkSyncNow()
    }

    // MARK: - Window

    private func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1280, height: 860)
        window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "DeepChat"
        window.minSize = NSSize(width: 940, height: 620)
        window.setFrameAutosaveName("DeepChatMainWindow")
        window.isReleasedWhenClosed = false
        window.contentView = NSView(frame: frame)
        window.contentView?.wantsLayer = true
        window.center()
        window.makeKeyAndOrderFront(nil)

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.userContentController.addUserScript(WKUserScript(source: bootstrapJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        configuration.userContentController.add(self, name: "deepchat")

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isHidden = true
        window.contentView?.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor),
            webView.topAnchor.constraint(equalTo: window.contentView!.topAnchor),
            webView.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor),
        ])

        buildLaunchView()
    }

    private func buildLaunchView() {
        launchView = NSView()
        launchView.translatesAutoresizingMaskIntoConstraints = false
        launchView.wantsLayer = true
        window.contentView?.addSubview(launchView)
        NSLayoutConstraint.activate([
            launchView.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor),
            launchView.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor),
            launchView.topAnchor.constraint(equalTo: window.contentView!.topAnchor),
            launchView.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor),
        ])

        let iconView = NSImageView()
        iconView.image = NSApp.applicationIconImage
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.widthAnchor.constraint(equalToConstant: 112).isActive = true
        iconView.heightAnchor.constraint(equalToConstant: 112).isActive = true

        let title = NSTextField(labelWithString: "DeepChat")
        title.font = NSFont.systemFont(ofSize: 30, weight: .semibold)
        title.textColor = .labelColor

        let subtitle = NSTextField(labelWithString: "ChatGPT 式的 DeepSeek 对话，随时可用")
        subtitle.font = NSFont.systemFont(ofSize: 13, weight: .regular)
        subtitle.textColor = .secondaryLabelColor

        spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false

        statusLabel = NSTextField(labelWithString: "正在连接 DeepSeek Harness…")
        statusLabel.font = NSFont.systemFont(ofSize: 13)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.alignment = .center
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 3

        startButton = NSButton(title: "启动 DeepSeek Harness", target: self, action: #selector(startHarnessClicked))
        startButton.bezelStyle = .rounded
        startButton.controlSize = .large
        startButton.isHidden = true

        retryButton = NSButton(title: "重新连接", target: self, action: #selector(retryClicked))
        retryButton.bezelStyle = .rounded
        retryButton.controlSize = .large
        retryButton.isHidden = true

        let buttons = NSStackView(views: [startButton, retryButton])
        buttons.orientation = .horizontal
        buttons.spacing = 10
        buttons.alignment = .centerY

        let textStack = NSStackView(views: [title, subtitle, statusLabel])
        textStack.orientation = .vertical
        textStack.spacing = 8
        textStack.alignment = .centerX

        let stack = NSStackView(views: [iconView, textStack, spinner, buttons])
        stack.orientation = .vertical
        stack.spacing = 18
        stack.alignment = .centerX
        stack.translatesAutoresizingMaskIntoConstraints = false
        launchView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: launchView.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: launchView.centerYAnchor, constant: -24),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
        ])
    }

    // MARK: - Connection

    private func begin() {
        setStatus("正在连接 DeepSeek Harness…", spinning: true)
        discoverHarness { [weak self] auth in
            guard let self else { return }
            if let auth {
                self.adopt(auth)
            } else {
                self.startHarness()
            }
        }
    }

    private func adopt(_ auth: StoredCookie) {
        activeAuth = auth
        log("using Harness authority \(auth.authority) cookie \(auth.name) issuedAt=\(Int(auth.issuedAt))")
        loadMainPage()
    }

    /// The Harness port changes on every restart. Each signed auth cookie names
    /// its own `127.0.0.1:<port>` authority, so probe the cookies newest-first
    /// and adopt the one whose server answers 200.
    private func discoverHarness(completion: @escaping (StoredCookie?) -> Void) {
        let candidates = readHarnessCookies()
        probeNext(candidates, index: 0, completion: completion)
    }

    private func probeNext(_ candidates: [StoredCookie], index: Int, completion: @escaping (StoredCookie?) -> Void) {
        guard index < candidates.count else {
            DispatchQueue.main.async { completion(nil) }
            return
        }
        let candidate = candidates[index]
        probeCookie(candidate) { [weak self] ok, status in
            if ok {
                DispatchQueue.main.async { completion(candidate) }
            } else {
                if let status {
                    log("authority \(candidate.authority) answered HTTP \(status); trying the next cookie")
                }
                self?.probeNext(candidates, index: index + 1, completion: completion)
            }
        }
    }

    private func probeCookie(_ cookie: StoredCookie, completion: @escaping (Bool, Int?) -> Void) {
        guard let url = cookie.baseURL else {
            completion(false, nil)
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.6
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("\(cookie.name)=\(cookie.value)", forHTTPHeaderField: "Cookie")
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode
            completion(status == 200, status)
        }.resume()
    }

    private func startHarness() {
        setStatus("DeepChat 需要 DeepSeek Harness 在后台运行，正在启动…", spinning: true)
        startButton.isHidden = false
        retryButton.isHidden = true

        let running = NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == harnessBundleID }
        if running == nil {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: harnessAppPath), configuration: configuration) { [weak self] application, error in
                if let error {
                    DispatchQueue.main.async {
                        self?.setStatus("启动 DeepSeek Harness 失败：\(error.localizedDescription)", spinning: false)
                    }
                } else {
                    self?.launchedHarness = application
                }
            }
        }

        pollCount = 0
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
            guard let self else { return }
            self.pollCount += 1
            self.discoverHarness { auth in
                if let auth {
                    timer.invalidate()
                    self.setStatus("连接成功，正在载入 DeepChat…", spinning: true)
                    self.startButton.isHidden = true
                    if let launched = self.launchedHarness {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { launched.hide() }
                    }
                    self.adopt(auth)
                } else if self.pollCount > 45 {
                    timer.invalidate()
                    self.setStatus("仍未连接到 DeepSeek Harness。请手动启动它，然后点“重新连接”。", spinning: false)
                    self.retryButton.isHidden = false
                }
            }
        }
    }

    private func loadMainPage() {
        guard let auth = activeAuth, let target = auth.baseURL else {
            setStatus("找不到 DeepSeek Harness 的本地登录凭据。请先启动一次 DeepSeek Harness，再点“重新连接”。", spinning: false)
            retryButton.isHidden = false
            return
        }
        log("using cookie \(auth.name) for \(auth.authority) (value length \(auth.value.count))")
        loadedCookieValue = auth.value
        lastPageHTML = nil
        bootstrapServer?.stop()
        // Drop every cookie this app stored earlier: an old attempt may have
        // left the same name marked Secure, which WebKit then refuses to send
        // over the loopback HTTP origin.
        webView.configuration.websiteDataStore.removeData(ofTypes: [WKWebsiteDataTypeCookies], modifiedSince: .distantPast) { [weak self] in
            DispatchQueue.main.async { self?.startBootstrapServer(cookie: auth, target: self?.targetURL ?? target) }
        }
    }

    private func startBootstrapServer(cookie: StoredCookie, target: URL) {
        let server = BootstrapServer(cookie: cookie, target: target)
        bootstrapServer = server
        setStatus("正在载入 DeepChat…", spinning: true)
        server.start { [weak self] port in
            guard let self else { return }
            guard let port else {
                self.setStatus("本地登录桥接启动失败，请点“重新连接”重试。", spinning: false)
                self.retryButton.isHidden = false
                return
            }
            log("cookie bootstrap listening on 127.0.0.1:\(port) -> \(target.absoluteString)")
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = 15
            self.webView.load(request)
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                server.stop()
                if self.bootstrapServer === server { self.bootstrapServer = nil }
            }
        }
    }

    private func setStatus(_ text: String, spinning: Bool) {
        statusLabel.stringValue = text
        if spinning { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
    }

    private func showMainPage() {
        guard !pageLoaded else { return }
        pageLoaded = true
        launchView.isHidden = true
        webView.isHidden = false
        window.makeFirstResponder(webView)
        startSyncMonitor()
        if snapshotPath != nil { scheduleSnapshot() }
    }

    // MARK: - Harness sync

    /// Watch the Harness host from outside the WebView: a plugin/bundle update
    /// changes the served HTML (the boot graph carries every plugin revision),
    /// and a Harness restart changes the auth cookie. Either event reloads the
    /// page when no answer is streaming and the composer is empty.
    private func startSyncMonitor() {
        guard syncTimer == nil else { return }
        syncTimer = Timer.scheduledTimer(withTimeInterval: 20.0, repeats: true) { [weak self] _ in
            self?.checkSyncNow()
        }
        checkSyncNow()
    }

    @objc private func checkSyncNow() {
        guard autoSyncEnabled, pageLoaded, !syncing else { return }
        syncing = true
        discoverHarness { [weak self] auth in
            guard let self else { return }
            self.syncing = false
            guard let auth, let url = auth.baseURL else {
                self.noteSyncFailure("no authenticated Harness authority")
                return
            }
            if self.activeAuth?.authority != auth.authority || self.activeAuth?.value != auth.value {
                log("Harness authority/cookie changed to \(auth.authority); reloading")
                self.adopt(auth)
                return
            }
            var request = URLRequest(url: url)
            request.timeoutInterval = 4
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue("\(auth.name)=\(auth.value)", forHTTPHeaderField: "Cookie")
            URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.syncing = false
                    if let http = response as? HTTPURLResponse {
                        self.syncFailures = 0
                        if http.statusCode == 401 {
                            log("sync check got 401; rediscovering the Harness authority")
                            self.activeAuth = nil
                            self.discoverHarness { found in
                                if let found { self.adopt(found) }
                            }
                            return
                        }
                        if http.statusCode == 200, let data {
                            if let last = self.lastPageHTML {
                                if last != data {
                                    log("Harness page revision changed; reloading")
                                    self.lastPageHTML = data
                                    self.requestSyncReload(force: false)
                                }
                            } else {
                                self.lastPageHTML = data
                            }
                        }
                        return
                    }
                    self.noteSyncFailure(error?.localizedDescription ?? "no response")
                }
            }.resume()
        }
    }

    private func noteSyncFailure(_ message: String) {
        syncFailures += 1
        log("sync check failed (\(syncFailures)): \(message)")
        if syncFailures >= 3, !harnessRestartInFlight {
            harnessRestartInFlight = true
            log("Harness looks down; starting it and waiting for the page")
            startHarness()
            DispatchQueue.main.asyncAfter(deadline: .now() + 75) { self.harnessRestartInFlight = false }
        }
    }

    @objc private func toggleAutoSync(_ sender: NSMenuItem) {
        autoSyncEnabled.toggle()
        sender.state = autoSyncEnabled ? .on : .off
        UserDefaults.standard.set(autoSyncEnabled, forKey: "DeepChatAutoSync")
        if autoSyncEnabled { checkSyncNow() }
    }

    private func requestSyncReload(force: Bool) {
        if force { lastPageHTML = nil }
        guard pageLoaded else { return }
        webView.evaluateJavaScript("""
        JSON.stringify({
          busy: !!document.querySelector('.cm_sendStop'),
          draft: (document.querySelector('.cm_input')?.value || '').length,
          attachments: document.querySelectorAll('.cm_composer .cm_chip').length
        })
        """) { [weak self] value, _ in
            guard let self else { return }
            var busy = false
            var draft = 0
            var attachments = 0
            if let string = value as? String, let data = string.data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                busy = parsed["busy"] as? Bool ?? false
                draft = parsed["draft"] as? Int ?? 0
                attachments = parsed["attachments"] as? Int ?? 0
            }
            if busy || draft > 0 || attachments > 0 {
                self.syncWork?.cancel()
                let work = DispatchWorkItem { [weak self] in
                    self?.requestSyncReload(force: force)
                }
                self.syncWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
                log("sync reload deferred (busy=\(busy), draft=\(draft), attachments=\(attachments))")
                return
            }
            self.syncWork?.cancel()
            self.syncWork = nil
            if force {
                self.loadMainPage()
            } else {
                self.webView.reloadFromOrigin()
            }
        }
    }

    // MARK: - Actions

    @objc private func startHarnessClicked() {
        startHarness()
    }

    @objc private func retryClicked() {
        retryButton.isHidden = true
        launchedHarness = nil
        begin()
    }

    @objc private func reloadPage() {
        if pageLoaded {
            webView.reload()
        } else {
            begin()
        }
    }

    @objc private func actualSize() {
        webView.pageZoom = 1.0
    }

    @objc private func openHarness() {
        if let running = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == harnessBundleID }) {
            running.activate(options: [.activateAllWindows])
        } else {
            NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: harnessAppPath), configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
        }
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any] else { return }
        if let kind = payload["kind"] as? String, kind == "deepchat-ready" {
            readyMessage = payload
            log("DeepChat page ready: \(payload)")
        } else if let kind = payload["kind"] as? String, kind == "script-error" {
            log("page script error: \(payload["message"] ?? "")")
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        log("didFinish \(webView.url?.absoluteString ?? "?")")
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
            let summary = cookies.prefix(8).map { "\($0.name)@\($0.domain) path=\($0.path) len=\($0.value.count) secure=\($0.isSecure) httpOnly=\($0.isHTTPOnly)" }.joined(separator: " | ")
            log("cookie jar (\(cookies.count)): \(summary)")
        }
        showMainPage()
        webView.evaluateJavaScript("(document.body.innerText || '').slice(0, 600)") { [weak self] value, _ in
            guard let self else { return }
            let text = (value as? String ?? "").replacingOccurrences(of: "\n", with: " ")
            log("page says: \(text.prefix(140))")
            if text.contains("authentication required") || text.contains("访问令牌") || text.contains("access token") {
                if self.authRetries < 2 {
                    self.authRetries += 1
                    log("auth page; re-reading the cookie and retrying (\(self.authRetries))")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.loadMainPage() }
                } else {
                    self.setStatus("登录凭据没有生效。请打开一次 DeepSeek Harness，确认页面正常后回到这里点“重新连接”。", spinning: false)
                    self.launchView.isHidden = false
                    self.webView.isHidden = true
                    self.retryButton.isHidden = false
                    self.startButton.isHidden = false
                }
            } else if text.contains("DeepChat") {
                self.authRetries = 0
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleNavigationFailure(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleNavigationFailure(error)
    }

    private func handleNavigationFailure(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        log("navigation failed: \(error.localizedDescription)")
        launchView.isHidden = false
        webView.isHidden = true
        setStatus("载入 DeepChat 失败：\(error.localizedDescription)", spinning: false)
        retryButton.isHidden = false
        startButton.isHidden = false
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
        if navigationAction.targetFrame == nil {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        if let host = url.host, host != "127.0.0.1", url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // MARK: - WKUIDelegate

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "DeepChat"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "DeepChat"
        alert.informativeText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    // MARK: - Snapshot

    private func scheduleSnapshot() {
        guard let path = snapshotPath else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) { [weak self] in
            self?.captureSnapshot(path: path)
        }
    }

    private func captureSnapshot(path: String) {
        guard !didCapture else { return }
        didCapture = true
        let javascript = """
        (() => {
          const side = document.querySelector('[data-slot="sidebar"]')?.parentElement;
          return JSON.stringify({
            url: location.href,
            title: document.title,
            chat: !!document.querySelector('[data-chat-mode]'),
            rail: !!document.querySelector('.cm_rail'),
            brand: document.querySelector('.cm_brandName')?.innerText || null,
            sidebarWidth: side ? getComputedStyle(side).width : null,
            bodyText: (document.body.innerText || '').slice(0, 240)
          });
        })()
        """
        webView.evaluateJavaScript(javascript) { [weak self] value, error in
            guard let self else { return }
            var report: [String: Any] = [:]
            if let string = value as? String, let data = string.data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                report = parsed
            }
            if let error { report["evaluateError"] = error.localizedDescription }
            if let ready = self.readyMessage { report["readyMessage"] = ready }
            report["capturedAt"] = ISO8601DateFormatter().string(from: Date())
            self.snapshotReport = report
            self.webView.takeSnapshot(with: WKSnapshotConfiguration()) { image, snapshotError in
                if let image, let tiff = image.tiffRepresentation, let representation = NSBitmapImageRep(data: tiff), let png = representation.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: path))
                    report["snapshot"] = path
                    report["snapshotError"] = snapshotError?.localizedDescription ?? NSNull()
                    log("snapshot written to \(path)")
                } else {
                    report["snapshotError"] = snapshotError?.localizedDescription ?? "unknown"
                    log("snapshot failed: \(snapshotError?.localizedDescription ?? "unknown")")
                }
                if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
                    let reportPath = path.replacingOccurrences(of: ".png", with: ".json")
                    try? data.write(to: URL(fileURLWithPath: reportPath))
                }
                NSApp.terminate(nil)
            }
        }
    }

    // MARK: - Menu

    private func buildMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem(title: "DeepChat", action: nil, keyEquivalent: "")
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 DeepChat", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let reload = NSMenuItem(title: "重新加载", action: #selector(reloadPage), keyEquivalent: "r")
        reload.target = self
        appMenu.addItem(reload)
        let harness = NSMenuItem(title: "打开 Harness 完整界面", action: #selector(openHarness), keyEquivalent: "")
        harness.target = self
        appMenu.addItem(harness)
        let autoSync = NSMenuItem(title: "自动同步 Harness 更新", action: #selector(toggleAutoSync(_:)), keyEquivalent: "")
        autoSync.target = self
        autoSync.state = autoSyncEnabled ? .on : .off
        appMenu.addItem(autoSync)
        let syncNow = NSMenuItem(title: "立即检查同步", action: #selector(checkSyncNow), keyEquivalent: "r")
        syncNow.keyEquivalentModifierMask = [.command, .shift]
        syncNow.target = self
        appMenu.addItem(syncNow)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 DeepChat", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 DeepChat", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "显示")
        let reloadView = NSMenuItem(title: "重新载入页面", action: #selector(reloadPage), keyEquivalent: "")
        reloadView.target = self
        viewMenu.addItem(reloadView)
        viewMenu.addItem(.separator())
        viewMenu.addItem(withTitle: "进入全屏幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        let actual = NSMenuItem(title: "实际大小", action: #selector(actualSize), keyEquivalent: "0")
        actual.target = self
        viewMenu.addItem(actual)
        viewMenuItem.submenu = viewMenu

        NSApp.mainMenu = mainMenu
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
