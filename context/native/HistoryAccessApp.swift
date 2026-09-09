import AppKit
import Foundation
import CryptoKit
import Darwin

final class Helper: NSObject, NSApplicationDelegate {
    let home = FileManager.default.homeDirectoryForCurrentUser
    var base: URL { home.appendingPathComponent(".local/share/codex-context-exporter") }
    var statusURL: URL { base.appendingPathComponent(agentMode ? "state/access-helper.json" : "state/access-helper-ui.json") }
    var bookmarkURL: URL { base.appendingPathComponent("state/history-folder.bookmark") }
    var source: URL!
    var window: NSWindow!
    var label: NSTextField!
    var signals: [DispatchSourceSignal] = []
    var child: Process?
    var scoped: URL?
    var agentMode = CommandLine.arguments.contains("--agent")

    func applicationDidFinishLaunching(_ note: Notification) {
        for sig in [SIGTERM,SIGINT] { signal(sig,SIG_IGN);let handler=DispatchSource.makeSignalSource(signal:sig,queue:.main);handler.setEventHandler { NSApp.terminate(nil) };handler.resume();signals.append(handler) }
        do {
            let config = try JSONSerialization.jsonObject(with: Data(contentsOf: base.appendingPathComponent("config.json"))) as! [String:Any]
            guard let p = config["history_segments"] as? String else { throw NSError(domain:"Config",code:1) }
            source = URL(fileURLWithPath:p)
            NSApp.setActivationPolicy(agentMode ? .accessory : .regular)
            if !agentMode { makeWindow() }
            restoreBookmark()
            DispatchQueue.main.asyncAfter(deadline:.now()+0.5) { self.probe() }
        } catch { finish(false,"配置无法读取：\(error.localizedDescription)") }
    }
    func makeWindow() {
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:620,height:330),styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.title="本地上下文同步 · 读取授权"
        let title=NSTextField(labelWithString:"允许同步计算机活动时间线")
        title.font = .boldSystemFont(ofSize:22);title.frame=NSRect(x:28,y:272,width:560,height:30)
        let detail=NSTextField(wrappingLabelWithString:"这个独立助手只为现有同步器读取 Computer History 原始活动目录。\n会话和摘要同步仍在运行。不会修改原始记录，也不会给通用 Node / Python 授权。")
        detail.frame=NSRect(x:28,y:195,width:560,height:64)
        label=NSTextField(wrappingLabelWithString:"正在请求系统读取授权。若出现系统弹窗，请由你选择允许。")
        label.frame=NSRect(x:28,y:108,width:560,height:72)
        let select=NSButton(title:"选择并授权活动目录…",target:self,action:#selector(selectFolder))
        select.frame=NSRect(x:28,y:44,width:220,height:36)
        let check=NSButton(title:"重新检查",target:self,action:#selector(checkAgain));check.frame=NSRect(x:260,y:44,width:110,height:36)
        [title,detail,label,select,check].forEach { window.contentView!.addSubview($0) }
        window.center();window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
    }
    func restoreBookmark() {
        guard let data=try? Data(contentsOf:bookmarkURL) else{return}
        var stale=false
        if let url=try? URL(resolvingBookmarkData:data,options:[.withSecurityScope,.withoutUI],relativeTo:nil,bookmarkDataIsStale:&stale), url.resolvingSymlinksInPath().path==source.resolvingSymlinksInPath().path {
            _=url.startAccessingSecurityScopedResource();scoped=url
        }
    }
    @objc func selectFolder() {
        let panel=NSOpenPanel();panel.title="授权 Computer History 活动目录";panel.prompt="授权此目录"
        panel.message="请选择 segments 目录；程序只接受配置中的原始活动目录。"
        panel.canChooseFiles=false;panel.canChooseDirectories=true;panel.allowsMultipleSelection=false
        panel.directoryURL=source.deletingLastPathComponent()
        if panel.runModal() == .OK, let url=panel.url {
            guard url.resolvingSymlinksInPath().path==source.resolvingSymlinksInPath().path else { finish(false,"选中的不是 segments 原始活动目录，未保存授权。");return }
            _=url.startAccessingSecurityScopedResource();scoped=url
            if let data=try? url.bookmarkData(options:[.withSecurityScope,.securityScopeAllowOnlyReadAccess],includingResourceValuesForKeys:nil,relativeTo:nil){try? data.write(to:bookmarkURL,options:.atomic)}
            probe()
        }
    }
    @objc func checkAgain(){probe()}
    func validatedRuntime() throws -> [String:String] {
        let manifest=try JSONSerialization.jsonObject(with:Data(contentsOf:Bundle.main.url(forResource:"runtime-manifest",withExtension:"json")!)) as! [String:String]
        for (p,expected) in manifest {
            let actual=SHA256.hash(data:try Data(contentsOf:URL(fileURLWithPath:p))).map{String(format:"%02x",$0)}.joined()
            if actual != expected {throw NSError(domain:"同步程序发生变化，请重新校验并构建助手",code:2)}
        }
        return manifest
    }
    func probe() {
        label?.stringValue="正在检查目录读取和后台子进程…"
        DispatchQueue.global(qos:.utility).async {
            do {
                _=try self.validatedRuntime()
                let names=try FileManager.default.contentsOfDirectory(atPath:self.source.path)
                let task=Process();task.executableURL=URL(fileURLWithPath:"/usr/bin/python3")
                task.arguments=["-c","import os,sys,json; root=sys.argv[1]; ds=os.listdir(root); files=[os.path.join(root,x,'events.jsonl') for x in ds if os.path.isfile(os.path.join(root,x,'events.jsonl'))]; f=open(sorted(files)[-1],'rb') if files else None; b=f.read(1) if f else b''; print(json.dumps({'directories':len(ds),'readable_file':bool(files),'sample_read':bool(b)}))",self.source.path]
                let out=Pipe(),err=Pipe();task.standardOutput=out;task.standardError=err;try task.run();task.waitUntilExit()
                let data=out.fileHandleForReading.readDataToEndOfFile()
                guard task.terminationStatus==0 else {throw NSError(domain:"后台子进程仍无读取权限",code:Int(task.terminationStatus))}
                self.finish(true,"读取授权通过：助手及子进程均可访问（\(names.count) 个目录）。",extra:["probe":String(data:data,encoding:.utf8) ?? ""])
                if self.agentMode { self.startWatcher() }
            } catch {self.finish(false,"读取仍受限：\(error.localizedDescription)。请尝试“选择并授权活动目录”。")}
        }
    }
    func finish(_ ok:Bool,_ message:String,extra:[String:Any]=[:]) {
        var result=extra;result["ok"]=ok;result["message"]=message;result["at"]=ISO8601DateFormatter().string(from:Date());result["pid"]=ProcessInfo.processInfo.processIdentifier;result["agent_mode"]=agentMode
        if let data=try? JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]) {try? data.write(to:statusURL,options:.atomic)}
        DispatchQueue.main.async {self.label?.stringValue=message;if self.agentMode && !ok {NSApp.terminate(nil)}}
    }
    func startWatcher() {
        let task=Process();task.executableURL=home.appendingPathComponent(".local/share/devspace-air/node-v24.20.0-darwin-arm64/bin/node")
        task.arguments=[base.appendingPathComponent("bin/watcher.mjs").path,base.appendingPathComponent("config.json").path]
        task.environment=["HOME":home.path,"PATH":"/usr/bin:/bin:/usr/sbin:/sbin"]
        for (name,isError) in [("sync.log",false),("error.log",true)] {
            let p=base.appendingPathComponent("logs/"+name);if !FileManager.default.fileExists(atPath:p.path){FileManager.default.createFile(atPath:p.path,contents:nil)}
            if let f=try? FileHandle(forWritingTo:p){_ = try? f.seekToEnd();if isError{task.standardError=f}else{task.standardOutput=f}}
        }
        task.terminationHandler={_ in DispatchQueue.main.async{NSApp.terminate(nil)}}
        do{try task.run();child=task}catch{finish(false,"同步器启动失败：\(error.localizedDescription)")}
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool{!agentMode}
    func applicationWillTerminate(_ notification:Notification){if child?.isRunning==true{child?.terminate()};scoped?.stopAccessingSecurityScopedResource()}
}
let app=NSApplication.shared
let delegate=Helper();app.delegate=delegate;app.run()
