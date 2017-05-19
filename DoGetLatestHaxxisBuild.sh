#!/bin/bash

#clear
echo ""
echo ""
echo "Copying latest deployed Haxxis build from the REMOTE to this PC; please stand by..."
echo "Copying from "$CGC_REMOTE_BUILD_ROOT"/Haxxis to "$CGC_LOCAL_BUILD_ROOT"/Haxxis"
echo ""
echo ""

# First, find the correct build and change to that directory:
pushd $CGC_REMOTE_BUILD_ROOT"/Haxxis" > /dev/null
if [ $? -ne 0 ]
    then
        exit 1
fi
firstLine=$(head -n 1 LastBuildMade.txt)
pushd $CGC_REMOTE_BUILD_ROOT/Haxxis/$firstLine > /dev/null
sourceDirLoc=$(pwd)

# DO NOT comment out the line below.  It is parsed by the server
echo -e "Version:$firstLine"
# DO NOT comment out the line above.

pushd $CGC_LOCAL_BUILD_ROOT"/Haxxis" > /dev/null
if [ -d "$CGC_LOCAL_BUILD_ROOT/Haxxis/$firstLine" ]; then

  # Important step:  Here we write out the LastBuildMade.txt file.  This is because a special script can be run
  # on REMOTE that deletes the last build made.  So in that case we also want to adjust our LOCAL version of
  # the LastBuildMade.txt file to reflect that change.  (We don't bother removing the removed build locally, however.)
  echo $firstLine > LastBuildMade.txt

  echo "Build "$firstLine" already exists locally."
  #read -p "Press any key..."
  exit 0
fi

mkdir $firstLine
cd $firstLine

echo "Copying..."
cp -r $sourceDirLoc/. .

# We don't copy the LastBuildMade.txt file because that may have changed in the meantime, due to another build happening.
# So instead we just create one that has the actual version of the build that we just copied
echo "Creating LastBuildMade.txt file on local machine"
cd ..
echo $firstLine > LastBuildMade.txt

popd > /dev/null
popd > /dev/null
popd > /dev/null

echo -e "End of DoGetLatestHaxxisBuild.sh script"
# read -p "Press any key..."
exit $exitCode