Option Explicit
Dim shell, files, folder, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
command = "node.exe " & Chr(34) & folder & "\launcher.mjs" & Chr(34)
shell.Run command, 0, False
