#!/bin/bash
#echo -e "Start of DoGetHaxxisBuildVersion bash script"
# NOTE:  This is used by:
#  (A) The master server, to get the latest version (of build, and packages) from the CGC_REMOTE_BUILD_ROOT
#  (B) The worker server, to get the same from the CGC_LOCAL_BUILD_ROOT

if [ $# -ne 1 ]; then
    echo $0: usage: DoGetHaxxisBuildVersion buildRootToUse
    exit 99
fi

pushd $1"/Haxxis" 1>/dev/null
if [ $? -ne 0 ]
    then
        exit 1
fi
firstLine=$(head -n 1 LastBuildMade.txt)

# DO NOT comment out the line below.  It is parsed by the server
echo -e "Version:$firstLine"
# DO NOT comment out the line above.

pushd $1"/HaxxisPackages" 1>/dev/null
if [ $? -ne 0 ]
    then
        exit 1
fi
firstLine=$(head -n 1 LastPackagesBuildMade.txt)

# DO NOT comment out the line below.  It is parsed by the server
echo -e "PackagesVersion:$firstLine"
# DO NOT comment out the line above.

exitCode=$?

#echo -e "End of DoGetHaxxisBuildVersion bash script"

exit $exitCode
