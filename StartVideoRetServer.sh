#!/bin/bash

# If you copy this file and the batch file into the windows startup folder, e.g. C:\Users\exx\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup, it will run on startup

echo -e "Starting VRS Server"

pushd /c/dev/cgc/videogenserver
nodemon VideoRetServer.js

popd 1>/dev/null/

echo -e "End of vrs-server-starting bash script"
exit $exitCode
