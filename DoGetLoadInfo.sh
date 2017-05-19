#!/bin/bash
# Note this script currently takes about 1.13 seconds to execute on my main PC
# Primarily because the wmic operation to get cpu load does so over a period of time
#echo -e "Start of DoGetLoadInfo bash script"

if [ $# -ne 2 ]; then
    echo $0: usage: DoGetLoadInfo drive1Letter drive2Letter
    exit 99
fi


# GET CPU LOAD MEASUREMENT
cpuLoad="$(wmic cpu get loadpercentage)"

count=0
cpuLoadList=""
while IFS= read -r line
do
	line="${line//[$'\t\r\n ']}"
    if [ "$count" -gt 0 ]
    then
		if [ -z "$line" ]
		then
			continue
		else
			cpuLoadList=$cpuLoadList$line"|"
		fi
    fi
    count=$((count+1))
done <<< "$cpuLoad"

# Note the below "CPU:" keyword must match what's in the worker server
echo "CPU:$cpuLoadList"


# GET GPU LOAD MEASUREMENT
gpuLoad="$('NVSMI/nvidia-smi.exe' --query-gpu='index,utilization.gpu,temperature.gpu' --format=csv)"

count2=0
gpuLoadList=""
while IFS= read -r line
do
	line="${line//[$'\t\r\n% ']}"	# Strip out whitespace >and< percent symbol
    if [ "$count2" -gt 0 ]
    then
		if [ -z "$line" ]
		then
			continue
		else
			gpuLoadList=$gpuLoadList$line"|"
		fi
    fi
    count2=$((count2+1))
done <<< "$gpuLoad"

# Note the below "GPU:" keyword must match what's in the worker server
echo "GPU:$gpuLoadList"


# GET DISK SPACE STATS
drive1Stats="$(df /$1 /$2 --output=used,size)"

count3=0
diskSpaceList=""
while IFS= read -r line
do
	# I bet there's a much better way to do this.
	line=$(sed -e 's/^[[:space:]]*//' <<< "$line")				# Trim leading whitespace
	line=$(sed 's/[[:space:]][[:space:]]*/,/g' <<< "$line")		# Convert space(s) to comma
    if [ "$count3" -gt 0 ]
    then
		if [ -z "$line" ]
		then
			continue
		else
			diskSpaceList=$diskSpaceList$line"|"
		fi
    fi
    count3=$((count3+1))
done <<< "$drive1Stats"

# Note the below "DISK:" keyword must match what's in the worker server
echo "DISK:$diskSpaceList"
sleep .1	# Give some time for worker server to process the above output before we end this script

exitCode=$?

#echo -e "End of DoGetLoadInfo bash script"

exit $exitCode
