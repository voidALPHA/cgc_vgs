cd /d %~dp0
Installs\x264vfw_full_43_2694bm_43159_fix.exe /S
regsvr32 Installs\mp4mux.dll
setx /M CGC_LOCAL_BUILD_ROOT "%cd%\Haxxis"
pause