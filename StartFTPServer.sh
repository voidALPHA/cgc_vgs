#!/bin/bash

# If you copy this file and the batch file into the windows startup folder, e.g. C:\Users\exx\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup, it will run on startup

echo -e "Starting FTP server"

# pushd /c/dev/cgc/videogenserver
nodemon FTPserver.js

# popd 1>/dev/null/

echo -e "End of ftp-server-starting bash script"
exit $exitCode
