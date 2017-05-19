#!/bin/bash

echo ""
echo ""
echo "Copying latest deployed Haxxis Packages build from the REMOTE to this PC; please stand by..."
echo "Copying from "$CGC_REMOTE_BUILD_ROOT"/HaxxisPackages to "$CGC_LOCAL_BUILD_ROOT"/HaxxisPackages"
echo ""
echo ""

# First, find the correct build and change to that directory:
pushd $CGC_REMOTE_BUILD_ROOT"/HaxxisPackages" > /dev/null
if [ $? -ne 0 ]
    then
        exit 1
fi
firstLine=$(head -n 1 LastPackagesBuildMade.txt)
pushd $CGC_REMOTE_BUILD_ROOT/HaxxisPackages/$firstLine > /dev/null
sourceDirLoc=$(pwd)

# DO NOT comment out the line below.  It is parsed by the server
echo -e "Version:$firstLine"
# DO NOT comment out the line above.

# Create local HaxxisPackages folder if it doesn't exist (important because if not, we get a big copy to a wrong place!)
pushd $CGC_LOCAL_BUILD_ROOT > /dev/null
mkdir -p HaxxisPackages
pushd $CGC_LOCAL_BUILD_ROOT"/HaxxisPackages" > /dev/null
if [ -d "$CGC_LOCAL_BUILD_ROOT/HaxxisPackages/$firstLine" ]; then

  # Important step:  Here we write out the LastPackagesBuildMade.txt file.  This is because a special script can be run
  # on REMOTE that deletes the last build made.  So in that case we also want to adjust our LOCAL version of
  # the LastPackagesBuildMade.txt file to reflect that change.  (We don't bother removing the removed build locally, however.)
  echo $firstLine > LastPackagesBuildMade.txt

  echo "Packages Build "$firstLine" already exists locally."
  #read -p "Press any key..."
  exit 0
fi

mkdir $firstLine
cd $firstLine

echo "Copying..."
cp -r $sourceDirLoc/. .

# We don't copy the LastPackagesBuildMade.txt file because that may have changed in the meantime, due to another build happening.
# So instead we just create one that has the actual version of the build that we just copied
echo "Creating LastPackagesBuildMade.txt file on local machine"
cd ..
echo $firstLine > LastPackagesBuildMade.txt

popd > /dev/null
popd > /dev/null
popd > /dev/null
popd > /dev/null

echo -e "End of DoGetLatestHaxxisPackagesBuild.sh script"
# read -p "Press any key..."
exit $exitCode