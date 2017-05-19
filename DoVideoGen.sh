#!bash
echo -e "Start of DoVideoGen bash script"

startTime=date
startTimeSeconds=$(date +%s)
generateTimestamp2() {
    $startTime +"%Y/%m/%d %H:%M:%S"
}
startTimeTime=$(generateTimestamp2)

if [ $# -ne 8 ]; then
    echo $0: usage: DoVideoGen hpname parameters id gpuindex eventsessionid masterserversessionid backupDrive targetVideoFilename
    exit 99
fi

HPName=$1
backupDrive=$7
targetVideoFilename=$8

# Go to this machine's local versioned HaxxisPackages folder, and find the latest version:
pushd $CGC_LOCAL_BUILD_ROOT"/HaxxisPackages" 1>/dev/null
if [ $? -ne 0 ]
	then
		exit 1
fi
firstLineHPB=$(head -n 1 LastPackagesBuildMade.txt)
	
HPName=$CGC_LOCAL_BUILD_ROOT"/HaxxisPackages/"$firstLineHPB"/"$HPName

popd 1>/dev/null

exitCode=0

targetVideoDir=$PWD"/Public/GeneratedVideos/EventSession_"$5
mkdir -p $targetVideoDir

# First, find the latest build and change to that directory:
pushd $CGC_LOCAL_BUILD_ROOT"/Haxxis" 1>/dev/null
if [ $? -ne 0 ]
    then
        exit 1
fi
firstLine=$(head -n 1 LastBuildMade.txt)
pushd $firstLine 1>/dev/null

# Check for existence of the HP file, and exit if not found
if [ ! -f "$HPName" ]; then
    echo "$HPName NOT FOUND."
    exit 4
fi

# Generate a unique name to be used in video output filename, and Haxxis log filename, etc.
generateTimestamp() {
    $startTime +"%Y%m%d_%H%M%S"
}
uniqueID=$(generateTimestamp)
# Add the unique job ID
uniqueID=$3"_"$uniqueID

tempFilename="Temp_"$uniqueID".txt"		# Used for two purposes

if [ "$targetVideoFilename" = "DEFAULT" ]; then
	videoFilename=$uniqueID".mp4"		# Default video filename
    textFilename=$uniqueID".txt"		# This is the companion text file
	logFilename=$uniqueID"_Log.txt"	    # Unity log file

	# DO NOT comment out the line below.  It is parsed by the server to get the generated video file name.
	echo -e "VideoFileName:$videoFilename"
	# DO NOT comment out the line above.
else
	videoFilename=$targetVideoFilename		# Note that we don't append .mp4 here (like we do above) because we do that earlier in the pipeline
    textFilename=${targetVideoFilename::-4}".txt"	# This is the companion text file (note we strip off the .mp4 before adding .txt)
	logFilename=${targetVideoFilename::-4}"_Log.txt"	    # Unity log file

	# DO NOT comment out the line below.  It is parsed by the server to get the generated video file name.
	echo -e "VideoFileName:$videoFilename"
	# DO NOT comment out the line above.

	# Temporarily add a timestamp prefix to this filename.  This is so that if there is an 'orphaned' job running on the worker (master went down and was restarted),
	# there will be no filename conflict.  When the video completes successfully, we remove the temporary timestamp prefix below.
	videoFilename=$uniqueID"_"$videoFilename
fi

# Now launch Haxxis, telling it to run the video generation script
# Enforce a timeout here; duration of 900 seconds is 15 minutes)

( cmdpid=$BASHPID; (sleep 900; kill $cmdpid) & exec ./Haxxis.exe -logFile $logFilename -gpu $4 -RunOnStartup=VideoGenScript.txt -HPName=$HPName -VideoFilename=$videoFilename -isVGSJob -jobID=$3 -MSSID=$6 $2 )

exitCode=$?
if [ "$exitCode" -eq 143 ]	# On the timeout enforced above, we get exit code 143 (SIG_TERM)
	then
		echo "HAXXIS TIMEOUT detected"
		timedOut=1
	else
		timedOut=0
fi

# I'm seeing exit code 0 when pressing Alt-F4 on Haxxis; 137 when it kills itself.
if [ $? -ne 0 -a $? -ne 127 ]
    then
        exit 2
fi

if [ "$timedOut" -eq 0 ]	# If Haxxis didn't time out...
	then
		# DO NOT comment out the line below.  It is parsed by the server
		echo -e "JobIsFinalizing"
		# DO NOT comment out the line above.

		# MOVE the resulting video to the target folder
		# Note:  We're doing a copy-and-delete here instead of a mv (move), because otherwise the file won't show up in a Windows shared folder with file sharing.  Ugh
		cp $videoFilename $targetVideoDir
		rm $videoFilename

		# If we gave it a temporary prefix for uniqueness, remove that temporary prefix:
		if [ "$targetVideoFilename" != "DEFAULT" ]; then
			newFilename=${videoFilename:22}
			mv $targetVideoDir/$videoFilename $targetVideoDir/$newFilename
			videoFilename=$newFilename
		fi

		# COPY the resulting log file to the target folder
		cp $logFilename $targetVideoDir

		# Parse the log file for exceptions
		grep -c -i "exception:" $logFilename > $tempFilename
		grepExitCode=$?
		# Note: grepExitCode holds 0 if there were matches found, 1 if no matches were found
		exceptionCount=$(head -n 1 $tempFilename)
		rm $tempFilename 1>/dev/null

		if [ $exceptionCount -gt 0 ]
			then
				echo -e $exceptionCount" exception(s) were encountered in the run"
				exitCode=3
			else   # Warning:  If you comment out a section of an 'else' you must also comment out the else
				# Remove the log file if there were no exceptions
				rm $logFilename 1>/dev/null
		fi
fi

endTimeSeconds=$(date +%s)
durationSeconds=$(($endTimeSeconds - $startTimeSeconds))

generateTimestamp3() {
    $1 +"%Y/%m/%d %H:%M:%S"
}
endTimeTime=$(generateTimestamp3 date)

# Generate a companion text file, and then move it to the target folder
echo "Video generation info for: "$videoFilename$'\r' > $textFilename
echo $'\r' >> $textFilename
echo "           HP name: "$HPName$'\r' >> $textFilename
echo "        Parameters: "$2$'\r' >> $textFilename
echo $'\r' >> $textFilename
echo "      Haxxis Build: "$PWD$'\r' >> $textFilename
echo "         GPU index: "$4$'\r' >> $textFilename
echo $'\r' >> $textFilename
echo "       Result code: "$exitCode$'\r' >> $textFilename
echo "   Exception count: "$exceptionCount$'\r' >> $textFilename
echo $'\r' >> $textFilename
echo "Generation started: "$startTimeTime$'\r' >> $textFilename
echo "  Generation ended: "$endTimeTime$'\r' >> $textFilename
echo "   Generation took: "$durationSeconds" seconds"$'\r' >> $textFilename
echo $'\r' >> $textFilename

# Note:  We're doing a copy-and-delete here instead of a mv (move), because otherwise the file won't show up in a Windows shared folder with file sharing.  Ugh
cp $textFilename $targetVideoDir
rm $textFilename

popd 1>/dev/null
popd 1>/dev/null

# Now we copy the video and text files to the other drive, for redundancy.
# We do this in another process (indicated by the ampersand below) so we don't hold up this process.
#echo -e "Launch process to copy files for redundancy..."
./DoPostVideoGenCopy.sh $targetVideoDir"/"$videoFilename $targetVideoDir"/"$textFilename $targetVideoDir"/"$logFilename $backupDrive $5 &

echo -e "End of DoVideoGen bash script"

if [ $exitCode -eq 127 ]
	then
		exit 0
fi

exit $exitCode
