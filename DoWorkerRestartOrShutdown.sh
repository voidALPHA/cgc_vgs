#!/bin/bash
echo -e "Start of DoWorkerRestartOrShutdown bash script"

if [ $# -ne 1 ]; then
    echo $0: usage: DoWorkerRestartOrShutdown RestartOrShutDownIndicatorLetter
    exit 99
fi

cmd "/C shutdown.exe /$1 /f /t 5"

exitCode=$?

echo -e "End of DoWorkerRestartOrShutdown bash script"

exit $exitCode
