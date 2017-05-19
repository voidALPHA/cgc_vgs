#!/bin/bash
#echo -e "Start of DoDeleteLocalBuilds bash script"

if [ $# -ne 2 ]; then
	echo
    echo "usage: ./DoDeleteLocalBuilds.sh buildkind versioncutoff"
	echo
	echo "The idea of this script is to have a way to programmatically and permanently remove"
	echo "either Haxxis or Packages builds, all versions equal and prior to a given version,"
	echo "in the machine's CGC_LOCAL_BUILDS_ROOT folder"
	echo
	echo "Example: ./DoDeleteLocalBuilds.sh Haxxis 2016.05.01_15.30.00"
	echo "Example: ./DoDeleteLocalBuilds.sh HaxxisPackages 2016.06.15_10.00.00"
    exit 99
fi

pushd $CGC_LOCAL_BUILD_ROOT"/"$1 1>/dev/null
if [ $? -ne 0 ]
    then
        exit 1
fi

if [ $1 = "Haxxis" ]
	then
        firstLine=$(head -n 1 LastBuildMade.txt)
	else
        firstLine=$(head -n 1 LastPackagesBuildMade.txt)
fi
echo "Latest version of "$1" is "$firstLine

if [ "$2" \> "$firstLine" ]
    then
	    echo "Cannot remove all builds!"
		exit 2
fi

if [ "$2" == "$firstLine" ]
    then
	    echo "Cannot remove latest build!"
		exit 3
fi

for Dir in $(find * -maxdepth 0 -type d );
do
    FolderName=$(basename $Dir)
	if [ ! "$FolderName" \> "$2" ]
	    then
	        echo "Removing "$FolderName
			rm -r $FolderName
    fi
done

exitCode=$?

#echo -e "End of DoDeleteLocalBuilds bash script"

exit $exitCode
