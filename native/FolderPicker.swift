import AppKit
import Foundation

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.activate(ignoringOtherApps: true)
let panel = NSOpenPanel()
panel.title = "为 DevSpace 选择文件夹"
panel.prompt = "选择此文件夹"
panel.message = "只选择目录；不会扫描或上传目录中的文件。"
panel.canChooseFiles = false
panel.canChooseDirectories = true
panel.allowsMultipleSelection = false
panel.canCreateDirectories = false
panel.resolvesAliases = true
var result: [String: Any] = ["cancelled": true]
if panel.runModal() == .OK, let url = panel.url {
    result = ["cancelled": false, "path": url.resolvingSymlinksInPath().standardizedFileURL.path]
}
let data = try JSONSerialization.data(withJSONObject: result)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([10]))
