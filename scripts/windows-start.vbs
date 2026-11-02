' WINDOWS AUTO-START: runs the production server with no console window.
' Used by the "Email Assistant" Task Scheduler task (runs at sign-in).
' Waits for node to exit, so the task shows Running and its restart-on-failure applies.
' Output is appended to data\server.log.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
If Not fso.FolderExists("data") Then fso.CreateFolder("data")
WScript.Quit sh.Run("cmd /c node backend\dist\index.js >> data\server.log 2>&1", 0, True)
