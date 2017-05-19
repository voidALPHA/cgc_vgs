#!/bin/bash
#echo -e "Start of DoPostVideoGenCopy bash script"

if [ $# -ne 5 ]; then
    echo $0: usage: DoPostVideoGenCopy videoFilename textFilename logFilename destDrive eventSessionId
    exit 99
fi

videoFilename=$1
textFilename=$2
logFilename=$3
destDrive=$4
eventSessionId=$5

targetPath="/"$destDrive"/CGCVideosBackup/EventSession_"$eventSessionId
mkdir -p $targetPath

cp $videoFilename $targetPath
cp $textFilename $targetPath
cp $logFilename $targetPath

#echo -e "End of DoPostVideoGenCopy bash script"

exit $exitCode
