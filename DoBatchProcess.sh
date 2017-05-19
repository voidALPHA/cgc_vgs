#!/bin/bash
echo -e "Start of DoBatchProcess bash script"

if [ $# -ne 4 ]; then
    echo $0: usage: dobatchprocess manifestname batchid autoRoundNum parameters
    exit 99
fi

ManifestName=$1
BatchId=$2
AutoRoundNum=$3
Parameters=$4

# Go to this machine's local versioned HaxxisPackages folder, and find the latest version:
pushd $CGC_LOCAL_BUILD_ROOT"/HaxxisPackages" 1>/dev/null
if [ $? -ne 0 ]
	then
		exit 1
fi
firstLine=$(head -n 1 LastPackagesBuildMade.txt)
pushd $firstLine 1>/dev/null

if [ ! -f "$ManifestName" ]; then
    echo $ManifestName" NOT FOUND."
    exit 2
fi

exitCode=0

# Now we go through the manifest file, line by line:

while read -r line
do
    rawLine=$line

    strippedLine=${rawLine%%#*}    # Strip everything from the first # character onwards (comments)

    strippedLine=$(echo $strippedLine | sed -e 's/\r//g')      # Strip newlines

    if [[ ! $strippedLine = *[!\ ]* ]]; then    # Stripped line consists of spaces only
        continue
    fi

    if [ -z "$strippedLine" ]; then       # Check for empty string
        continue
    fi

    arr=($strippedLine) # Split into an array of strings, using space as delimiter

    if [ ${arr[0]} = "call" ]; then
        manifestToBeCalled=${arr[1]}
        #echo "call command recognized: "$manifestToBeCalled

        # Convert spaces to %20
        allParameters=${Parameters// /%20}
        
        #echo "localhost:8003/StartBatchGen/${manifestToBeCalled}/${BatchId}/${AutoRoundNum}/${allParameters}"
        curl "localhost:8003/StartBatchGen/${manifestToBeCalled}/${BatchId}/${AutoRoundNum}/${allParameters}"
    else
        # Otherwise this line is for a single video generation request.  Combine the passed-in parameters with any parameters specified on this line
		if [ ${#arr[@]} -lt 3 ]; then
			echo "ERROR:  Single video generation line must contain at least three keywords (HP name, video filename format string, and priority)"
		else
			allParameters=$Parameters
			skippedHPNameAndFormatString=0
			for item in "${arr[@]}"
			do
				:
				if [[ skippedHPNameAndFormatString -gt 2 ]]; then
					allParameters="$allParameters $item"
				else
					((++skippedHPNameAndFormatString))
				fi
			done

			# Convert spaces to %20
			allParameters=${allParameters// /%20}

			HPName=${arr[0]}
			# Encode slashes in the package name (for partial paths)
			HPName=$(echo $HPName|sed 's#/#_^_#g')

			VideoFilenameFormatString=${arr[1]}
			#echo "VideoFilenameFormatString="$VideoFilenameFormatString

			Priority=${arr[2]}

			#echo "allParameters="$allParameters

			curl "localhost:8003/StartVideoGen/${HPName}/${Priority}/${BatchId}/${AutoRoundNum}/${VideoFilenameFormatString}/${allParameters}"
		fi
    fi
    
done < "$ManifestName"


echo -e "End of DoBatchProcess bash script"

exit $exitCode
