#!/bin/bash
#echo -e "Start of DoGetNumGPUs bash script"

gpuList="$('NVSMI/nvidia-smi.exe' --query-gpu='index' --format=csv)"
#echo "${gpuList}"

count=0
GpuCount=0
while IFS= read -r line
do
	line="${line//[$'\t\r\n ']}"
    if [ "$count" -gt 0 ]
    then
		if [ -z "$line" ]
		then
			continue
		else
			GpuCount=$[GpuCount +1]
		fi
    fi
    count=$((count+1))
done <<< "$gpuList"

# Note the below "GPUCount:" keyword must match what's in the worker server
echo "GPUCount:$[GpuCount]"

exitCode=$?

#echo -e "End of DoGetNumGPUs bash script"

exit $exitCode
