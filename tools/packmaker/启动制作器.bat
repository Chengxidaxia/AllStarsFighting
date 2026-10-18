@echo off
chcp 936 >nul
rem ALSF 数据包制作器启动器（pythonw：无黑色控制台窗口）
setlocal
set "PYW=%LOCALAPPDATA%\Programs\Python\Python311\pythonw.exe"
if not exist "%PYW%" set "PYW=pythonw"
start "" "%PYW%" "%~dp0packmaker.pyw"
