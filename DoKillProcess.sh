#!/bin/bash


################################################
#  THIS FILE NOT USED.
#  I CHOSE A MORE EFFICIENT WAY OF KILLING (HAXXIS KILLS ITSELF WHEN IT RECEIVES A LONG-POLL RESPONSE FROM THE WORKER SERVER)
################################################



echo -e "Start of DoKillProcess bash script"

if [ $# -ne 1 ]; then
    echo $0: usage: DoKillProcess processid
    exit 99
fi

# Now, we run the 'kill' command to actually kill the process
#echo "Attempting to TASK-kill real process ID "$1
#killOutput="$(./taskkill /PID $1 /F)"
#./taskkill /PID $1 /F
#echo $killOutput

killParams="/PID $1 /F"
echo $killParams
cmd='start "Title" taskkill '$killParams
echo $cmd
x="$(cmd)"
echo $x
#START "title" [/D path] [options] "command" [parameters]

echo -e "End of DoKillProcess bash script"

exit 0


# Sigh.  First, we run the 'ps' command to dump the running processes, and search the output lines
#  for one containing the matching process ID (which is in the WINPID column).  Then, pull out the
#  first number in that line which is in the PID column.

psOutput="$(ps)"

realProcessID=0
while IFS= read -r line
do
	#line="${line//[$'\t\r\n ']}"
	if [[ $line == *$1* ]]
	then
		echo "Found matching line in ps output: "$line
		arr=($line)
		realProcessID=${arr[0]}
	fi
done <<< "$psOutput"

if [ $realProcessID -eq 0 ]; then
	echo "Windows Process ID was not found; this might be because the kill request came after the process already died"
	exit 98
fi

# Now, we run the 'kill' command to actually kill the process
#echo "Attempting to TASK-kill real process ID "$realProcessID
#killOutput="$(./taskkill /PID $realProcessID /F)"
#./taskkill /PID $realProcessID /F
#echo $killOutput

#echo "Attempting to kill real process ID "1
#killOutput="$(taskkill /PID $1 /F)"
#killOutput="$(cmd "/C TASKKILL /fi /PID $realProcessID")"
#echo $killOutput

# Now, we run the 'kill' command to actually kill the process
#echo "Attempting to kill real process ID "$realProcessID
#killOutput="$(kill $realProcessID)"
#echo $killOutput



echo -e "End of DoKillProcess bash script"

exit 0
