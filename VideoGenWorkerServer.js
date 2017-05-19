// This is the WORKER server
// It runs on each worker hardware server, and can also run on the same hardware as the master VGS server
// It takes requests from the master, and replies back to the master with results

"use strict";

var port = 8004;

var express = require('express');
var app = express();
var http = require('http');
var server = http.Server(app);
var io = require('socket.io')(server);

var path = require("path");
var fs = require('fs');
require('log-timestamp');
var os = require('os');
var spawn = require('child_process').spawn;

app.use(express.static('public'));


app.get('/VGSWorker', function (request, response) {
    response.sendFile(path.join(__dirname + '/VideoGenWorkerServer.html'));
    // Maybe instead of HTML we send a signal back indicating readiness
});

app.get('/VideoGenServer.css', function (request, response) {
    response.sendFile(path.join(__dirname + '/VideoGenServer.css'));
})

var Socket;

var workerJobs = [];

var numGPUs = 0;
var gpuJobCounts = [];

var workerServerShuttingDown = false;

var drive1Letter = "C";
var drive2Letter = "D";


function WorkerJobIndexFromIdAndMSSId(id,MSSID) {
    for (var i = 0, len = workerJobs.length; i < len; i++) {
        if (workerJobs[i].jobId === id && workerJobs[i].MSSID === MSSID) {
            return i;
        }
    }
    return -1;
}

function DumpWorkerJobs() {
    for (var i = 0, len = workerJobs.length; i < len; i++) {
        var job = workerJobs[i];
        console.log(i + ":  id=" + job.jobId + "  MSSID=" + job.MSSID + "  GPU=" + job.assignedGPUIndex + "  errorCode=" + job.errorCode);
    }
    console.log("Worker jobs table has " + workerJobs.length + " entries");
}

function KillHaxxisProcess(index) {
    console.log("About to kill Haxxis instance for job index " + index);

    var lifelineResponse = workerJobs[index].lifelineResponse;
    // Specifically send the word "kill" when telling Haxxis to kill itself.
    // The idea is for Haxxis to be able to differentiate between that, and a Unity WWW object timeout
    if (lifelineResponse !== null)
        lifelineResponse.send("Kill");    // Send the response to the Haxxis instance; it will respond by killing itself
}

function KillJob(index) {
    KillHaxxisProcess(index);

    var process = workerJobs[index].spawnedProcess;
    process.kill("SIGINT"); // This kills the bash script, but if Haxxis is running Haxxis will keep running
    // Note:  workerJobs record will be killed immediately after this, in the 'on exit' handler of the bash script process elsewhere in this file
}

function KillAllJobs() {
    for (var i = 0, len = workerJobs.length; i < len; i++) {
        KillJob(i);
    }
}

io.on('connection', function (socket) {
    console.log("In worker server's connection handler");
    Socket = socket;

    socket.on('get status', function (data) {
        SendStatusToMaster();
    })

    socket.on('echo', function(message) {
        console.log("echo received by worker server; message: " + message + "; sending reply...");
        socket.emit('reply', "reply from worker");
    })

    socket.on('master assigns drives to monitor', function (data) {
        drive1Letter = data['drive1Key'];
        drive2Letter = data['drive2Key'];
        console.log("Master notified worker to monitor drives: " + drive1Letter + "," + drive2Letter);
    })

    socket.on('master requests load info from worker', function(message) {
        //console.log("Worker received request from master for load info...");

        var keywordCPU = "CPU:";
        var keywordCPULen = keywordCPU.length;
        var cpuLoadPctArray = [];
        var keywordGPU = "GPU:";
        var keywordGPULen = keywordGPU.length;
        var gpuLoadPctArray = [];
        var keywordDisk = "DISK:";
        var keywordDiskLen = keywordDisk.length;
        var diskArray = [];

        var childGetLoadInfo = spawn('bash', ['DoGetLoadInfo.sh', drive1Letter, drive2Letter], {});

        //DumpWorkerJobs();

        childGetLoadInfo.stdout.on('data', function (data) {
            var stringIn = String(data);
            if (stringIn.substring(0, keywordCPULen) === keywordCPU) {
                //console.log("recognized cpu load keyword: " + stringIn);
                var cpuFields = stringIn.substring(keywordCPULen, stringIn.length).split('|');
                for (var i = 0, numFields = cpuFields.length - 1; i < numFields; i++) {
                    var cpuLoad = parseInt(cpuFields[i]);
                    //console.log("CPU load keyword recognized; index: " + i + "; load: " + cpuLoad);
                    if (isNaN(cpuLoad)) {
                        cpuLoad = 0;
                    }
                    cpuLoadPctArray.push(cpuLoad);
                }
            } else if (stringIn.substring(0, keywordGPULen) === keywordGPU) {
                //console.log("recognized gpu load keyword: " + stringIn);
                var gpuFields = stringIn.substring(keywordGPULen, stringIn.length).split('|');
                for (var i = 0, numFields = gpuFields.length - 1; i < numFields; i++) {
                    var fields = gpuFields[i].split(',');
                    var gpuIndex = parseInt(fields[0]);
                    var gpuLoad = parseInt(fields[1]);
                    var gpuTemperature = parseInt(fields[2]);
                    //console.log("GPU load keyword recognized; index: " + gpuIndex + "; load: " + gpuLoad + "; temperature: " + gpuTemperature);
                    if (isNaN(gpuLoad)) {   // This happens when an "unsupported" GPU is queried
                        gpuLoad = -1;
                    }
                    if (isNaN(gpuTemperature)) {
                        gpuTemperature = -1;
                    }
                    while (gpuLoadPctArray.length <= gpuIndex)
                        gpuLoadPctArray.push( { load: 0, temperature: 0 } );
                    gpuLoadPctArray[gpuIndex] = { load: gpuLoad, temperature: gpuTemperature };
                }
            } else if (stringIn.substring(0, keywordDiskLen) === keywordDisk) {
                //console.log("recognized disk load keyword: " + stringIn);
                var diskFields = stringIn.substring(keywordDiskLen, stringIn.length).split('|');
                for (var i = 0, numFields = diskFields.length - 1; i < numFields; i++) {
                    var fields = diskFields[i].split(',');
                    var totalUsed = parseInt(fields[0]);
                    var totalSize = parseInt(fields[1]);
                    //console.log("DISK keyword recognized; totalUsed = " + totalUsed + "; totalSize = " + totalSize);
                    diskArray.push({ used: totalUsed, size: totalSize });
                }
            } else {
                console.log("childGetLoadInfo: " + data);
            }
        });

        childGetLoadInfo.on('exit', function (exitCode) {
            // Note that this also gets called when the bash script process is killed, in which case exitCode is null
            if (exitCode != null) {
                //console.log("DoGetLoadInfo script finished; sending results to master");

                var totalMem = os.totalmem();
                var loadMem = Math.round(((totalMem - os.freemem()) / totalMem) * 1000.0) / 10.0;

                socket.emit('worker reply with load info', { memKey: loadMem, cpuLoadPctArrayKey: cpuLoadPctArray, gpuLoadPctArrayKey: gpuLoadPctArray, diskSpaceArrayKey: diskArray });
            } else {
                console.log("DoGetLoadInfo bash script killed");
            }
        });
    })

    socket.on('master requests build version from worker', function (message) {
        //console.log("Worker received request from master for build version...");

        var keywordVersion = "Version:";
        var keywordVersionLen = keywordVersion.length;
        var version = "";

        var keywordPackagesVersion = "PackagesVersion:";
        var keywordPackagesVersionLen = keywordPackagesVersion.length;
        var packagesVersion = "";

        // Note that this bash script is also ran by the MASTER server, to get the latest available versions
        var childGetVersionInfo = spawn('bash', ['DoGetHaxxisBuildVersion.sh', process.env.CGC_LOCAL_BUILD_ROOT], {});

        childGetVersionInfo.stdout.on('data', function (data) {
            var stringIn = String(data);
            if (stringIn.substring(0, keywordVersionLen) === keywordVersion) {
                version = stringIn.substring(keywordVersionLen, stringIn.length);
            } else if (stringIn.substring(0, keywordPackagesVersionLen) === keywordPackagesVersion) {
                packagesVersion = stringIn.substring(keywordPackagesVersionLen, stringIn.length);
            } else {
                console.log("childGetVersionInfo: " + data);
            }
        });

        childGetVersionInfo.on('exit', function (exitCode) {
            // Note that this also gets called when the bash script process is killed, in which case exitCode is null
            if (exitCode != null) {
                socket.emit('worker reply with build version', { buildVersionKey: version, packagesVersionKey: packagesVersion });
            } else {
                console.log("DoGetHaxxisBuildVersion bash script killed");
            }
        });
    })

    socket.on('get hp parameters', function(data) {
        var hpName = data['hpName'];
        var requestingClientId = data['requestingClientId'];
        //console.log("Worker received request from master to get HP parameters for package " + hpName);

        // Find latest packages build
        var packagesPath = process.env.CGC_LOCAL_BUILD_ROOT + '/HaxxisPackages';
        var filename = 'LastPackagesBuildMade.txt';
        fs.readFile(packagesPath + '/' + filename, 'utf8', function (err, data) {
            if (err) {
                console.log('Problem reading ' + filename);
                throw err;
            }
            var lines = data.split("\n");
            var latestPackagesBuildVersion = lines[0].trim();
            //console.log("latestPackagesBuildVersion: " + latestPackagesBuildVersion);

            packagesPath += '/' + latestPackagesBuildVersion;

            // Read the given HP
            fs.readFile(packagesPath + '/' + hpName, 'utf8', function(err, data) {                
                var parameters = {nodes:[], choreo:[], error:""};
                if (err) {
                    console.log('Problem reading ' + hpName);
                    parameters.error = 'Haxxis Package not found';
                } else {
                    parameters = FindCLAsInChainNodes(data, parameters);

                    // TODO:  Also parse the data for all "IfCommandLineArgMatchesStringStep" and "IfCommandLineExistStep" steps in the choreography 
                    // Pull those CLA args out of those steps, and possibly send as a second chunk of data, displayed in the HTML as 'Also in choreography:'
                    // (Because a package can have CLA references in those choreography steps but not in the nodes...)

                    // Parse for all command line arguments and create an array of strings
                    //var p = JSON.parse(data);
                    ////console.log(p.Chain.RootGroup.Nodes.$values[0].ParameterName.LiteralValue);
                    ////console.log(p.Chain.RootGroup.Groups.$values[0].ParameterName.LiteralValue);
                    //// First we want to find all command line argument 'adapters' in the chain nodes:
                    //var root = p.Chain.RootGroup;   // There's only one root group.  All groups contain a list of nodes, and a list of groups
                    //parameters = ProcessChainNodeGroup(parameters, root);
                }
                // Send the array back to master
                socket.emit('worker reply hp parameters', { hpName: hpName, parameters: parameters, requestingClientId: requestingClientId });
            })
        })
    })

    //function ProcessChainNodeGroup(parameters, group) {
    //    var nodes = group.Nodes.$values;
    //    for (var i = 0, len = nodes.length; i < len; i++) { // A group can have multiple root nodes
    //        var x = nodes[i];
    //        console.log('x = ' + x.$type);  // This is the string that is the type of the node
    //    }
    //    //group.Nodes;
    //    //group.Groups;
    //    return parameters;
    //}

    function GetValue(line) {
        // This assumes line is in the format:  "blah": "value"
        var lastQuoteIndex = line.lastIndexOf('"');
        var s = line.substring(0, lastQuoteIndex);  // Trim off the trailing quote mark
        lastQuoteIndex = s.lastIndexOf('"');
        return s.substring(lastQuoteIndex + 1, s.length);
    }

    function FindCLAsInChainNodes(data, parameters) {
        var lines = data.split("\n");
        var literalValue = "";
        var absoluteKey = "";
        var parameterNameTagFound = true;
        var defaultValueTagFound = true;
        var someValueFound = true;
        var commentTagFound = true;

        var curArgName = "";
        var curDefaultValue = "";
        var curCommentValue = "";
        var pendingCLA = false;

        for (var i = 0, len = lines.length; i < len; i++) {
            var line = lines[i];

            if (line.indexOf("CommandLineArgumentAdapter") >= 0) {
                if (pendingCLA) {
                    parameters.nodes.push('-' + curArgName + '=' + curDefaultValue + ' [' + curCommentValue + ']');
                }
                pendingCLA = true;
                curArgName = "";
                curDefaultValue = "";

                parameterNameTagFound = false;
                defaultValueTagFound = false;
                someValueFound = false;
                commentTagFound = false;
            }
            if (line.indexOf("ParameterName") >= 0 && !parameterNameTagFound) {
                parameterNameTagFound = true;
                someValueFound = false;
            }
            if (line.indexOf("DefaultValue") >= 0 && !defaultValueTagFound) {
                defaultValueTagFound = true;
                someValueFound = false;
            }
            if (line.indexOf("LiteralValue") >= 0 && !someValueFound) {
                someValueFound = true;
                literalValue = GetValue(line);
                //console.log("LiteralValue: " + literalValue);
                if (parameterNameTagFound && !defaultValueTagFound) {
                    curArgName = literalValue;
                } else if (defaultValueTagFound) {
                    curDefaultValue = literalValue;
                }
            }
            if (line.indexOf("AbsoluteKey") >= 0 && !someValueFound) {
                someValueFound = true;
                absoluteKey = GetValue(line);
                //console.log("AbsoluteKey: " + absoluteKey);
                if (parameterNameTagFound && !defaultValueTagFound) {
                    curArgName = absoluteKey;
                } else if (defaultValueTagFound) {
                    curDefaultValue = absoluteKey;
                }
            }
            if(line.indexOf("Comment") >= 0 && !commentTagFound) {
                commentTagFound = true;
                var lineBits = line.split("\"");
                curCommentValue = lineBits.slice(3, lineBits.length - 1).join("\"").replace(/\\\"/g, "\"");
                if(curCommentValue === "") {
                    curCommentValue = "No comment was found.";
                }
            }
        }
        if (pendingCLA) {
            parameters.nodes.push('-' + curArgName + '=' + curDefaultValue + ' [' + curCommentValue + ']');
            pendingCLA = false;
            curArgName = "";
            curDefaultValue = "";
            curCommentValue = "";
        }

        var argumentNameFound = false;
        commentTagFound = false;

        for (var i = 0, len = lines.length; i < len; i++) {
            var line = lines[i];

            if (line.indexOf("CommandLineSteps") >= 0) {
                // Catches both Choreography.Steps.CommandLineSteps.IfCommandLineArgMatchesStringStep and Choreography.Steps.CommandLineSteps.IfCommandLineExistsStep

                if (pendingCLA) {
                    parameters.choreo.push('-' + curArgName + ' [' + curCommentValue + ']');
                }
                pendingCLA = true;
                curArgName = "";
                curDefaultValue = "";

                argumentNameFound = false;
                commentTagFound = false;
            }
            if(line.indexOf("ArgumentName") >= 0 && !argumentNameFound) {
                argumentNameFound = true;
                curArgName = GetValue(line);
            }
            if(line.indexOf("Note") >= 0 && !commentTagFound) {
                commentTagFound = true;
                var lineBits = line.split("\"");
                curCommentValue = lineBits.slice(3, lineBits.length - 1).join("\"").replace(/\\\"/g, "\"");
                if(curCommentValue === "") {
                    curCommentValue = "No comment was found.";
                }
            }
        }
        if (pendingCLA) {
            parameters.choreo.push('-' + curArgName + ' [' + curCommentValue + ']');
        }

        return parameters;
    }

    socket.on('get hp list', function(data) {
        var requestingClientId = data['requestingClientId'];
        console.log("Worker received request from master to get HPs list");

        // Find latest packages build
        var packagesPath = process.env.CGC_LOCAL_BUILD_ROOT + '/HaxxisPackages';
        var filename = 'LastPackagesBuildMade.txt';
        fs.readFile(packagesPath + '/' + filename, 'utf8', function (err, data) {
            if (err) {
                console.log('Problem reading ' + filename);
                throw err;
            }
            var lines = data.split("\n");
            var latestPackagesBuildVersion = lines[0].trim();

            packagesPath += '/' + latestPackagesBuildVersion;

            var list = [];
            list = DirSync(packagesPath, packagesPath, list);

            // Send the array back to master
            socket.emit('worker reply hp list', { list: list, requestingClientId: requestingClientId });
        })
    })

    function DirSync(root, dir, filelist) {
        var files = fs.readdirSync(dir);
        files.forEach(function (file) {
            if (fs.statSync(dir + '/' + file).isDirectory()) {
                filelist = DirSync(root, dir + '/' + file, filelist);
            }
            else {
                if (endsWith(file, '.json')) {
                    var partial = dir.replace(root, "");
                    partial = partial + '/' + file;
                    while (partial.substring(0, 1) == '/')
                        partial = partial.substring(1);
                    filelist.push(partial);
                }
            }
        });
        return filelist;
    }

    socket.on('master requests worker to get latest build', function (message) {
        console.log("Worker received request from master to get latest build...");

        var keywordVersion = "Version:";
        var keywordVersionLen = keywordVersion.length;
        var version = "";

        var childGetLatestBuild = spawn('bash', ['DoGetLatestHaxxisBuild.sh'], {});

        childGetLatestBuild.stdout.on('data', function (data) {
            var stringIn = String(data);
            if (stringIn.substring(0, keywordVersionLen) === keywordVersion) {
                version = stringIn.substring(keywordVersionLen, stringIn.length);
            } else {
                console.log("childGetLatestBuild: " + data);
            }
        });

        childGetLatestBuild.on('exit', function (exitCode) {
            // Note that this also gets called when the bash script process is killed, in which case exitCode is null
            if (exitCode != null) {
                socket.emit('worker reply got latest build', { buildVersionKey: version });
            } else {
                console.log("DoGetLatestHaxxisBuild bash script killed");
            }
        });
    })

    socket.on('master requests worker to get latest packages', function (message) {
        console.log("Worker received request from master to get latest packages...");

        var keywordVersion = "Version:";
        var keywordVersionLen = keywordVersion.length;
        var version = "";

        var childGetLatestPackagesBuild = spawn('bash', ['DoGetLatestHaxxisPackagesBuild.sh'], {});

        childGetLatestPackagesBuild.stdout.on('data', function (data) {
            var stringIn = String(data);
            if (stringIn.substring(0, keywordVersionLen) === keywordVersion) {
                version = stringIn.substring(keywordVersionLen, stringIn.length);
            } else {
                console.log("childGetLatestPackagesBuild: " + data);
            }
        });

        childGetLatestPackagesBuild.on('exit', function (exitCode) {
            // Note that this also gets called when the bash script process is killed, in which case exitCode is null
            if (exitCode != null) {
                socket.emit('worker reply got latest packages', { packagesVersionKey: version });
            } else {
                console.log("DoGetLatestHaxxisPackagesBuild bash script killed");
            }
        });
    })

    socket.on('master requests worker restart or shutdown', function (data) {
        var restart = data['restartKey'];
        console.log("Worker received request from master to do system " + (restart ? "RESTART" : "SHUTDOWN"));

        workerServerShuttingDown = true;

        // First, kill all of our jobs:
        KillAllJobs();

        // Then start the restart or shutdown process:
        var shutdownTypeIndicator = (restart ? "r" : "s");
        var child = spawn('bash', ['DoWorkerRestartOrShutdown.sh', shutdownTypeIndicator], {});

        child.stdout.on('data', function (data) {
            var stringIn = String(data);
            console.log("child: " + data);
        });

        child.on('exit', function (exitCode) {
            if (exitCode != null) {
                console.log("DoWorkerRestartOrShutdown bash script completed");
            } else {
                console.log("DoWorkerRestartOrShutdown bash script killed...");
            }
        });
    })

    socket.on('kill job', function (data) {
        var jobId = data['jobIdKey'];
        var MSSID = data['MSSIdKey'];
        console.log("Worker received request to kill job id=" + jobId);
        var index = WorkerJobIndexFromIdAndMSSId(jobId, MSSID);
        if (index >= 0) {
            KillJob(index); // Note: The actual worker job record will be deleted in the 'on exit' handler of the bash script process elsewhere in this file
        } else {
            console.log("Error in kill request:  Job id was not registered");
        }
    })

    socket.on('kill all jobs', function (data) {
        console.log("Worker received request to kill all its jobs");
        KillAllJobs();
    })

    socket.on('rename', function(data) {
        var newName = data['newName'];
        console.log("Worker received request to rename video file for jobId=" + data.jobIdNum + " to " + newName);

        //console.log("Will move file from " + __dirname + '/Public/GeneratedVideos/EventSession_' + data.eventSessionId + '/' + data['oldName'] + " to " + __dirname + '/Public/GeneratedVideos/EventSession_' + data.eventSessionId + '/' + data['newName'])

        fs.renameSync(
            __dirname + '/Public/GeneratedVideos/EventSession_' + data.eventSessionId + '/' + data['oldName'] + '.mp4',
            __dirname + '/Public/GeneratedVideos/EventSession_' + data.eventSessionId + '/' + data['newName'] + '.mp4');
        fs.renameSync(
            __dirname + '/Public/GeneratedVideos/EventSession_' + data.eventSessionId + '/' + data['oldName'] + '.txt',
            __dirname + '/Public/GeneratedVideos/EventSession_' + data.eventSessionId + '/' + data['newName'] + '.txt');
        fs.renameSync(
            __dirname + '/Public/GeneratedVideos/EventSession_' + data.eventSessionId + '/' + data['oldName'] + '_Log.txt',
            __dirname + '/Public/GeneratedVideos/EventSession_' + data.eventSessionId + '/' + data['newName'] + '_Log.txt');
    })

    socket.on('purge special', function(data) {
        console.log('Worker received request to purge the Specials folder');

        var hppath = process.env.CGC_LOCAL_BUILD_ROOT + '/HaxxisPackages';
        var lpbm = fs.readFileSync(hppath + '/LastPackagesBuildMade.txt', 'utf8');
        hppath += '/' + lpbm.split('\n')[0].trim();

        spawn('rm', ['-r', hppath + '/Specials']);
    })

    socket.on('disconnect', function () {
        console.log("The master server has disconnected");
    })
})

// I don't think this is used...
function SendStatusToMaster() {
    // Send to ALL clients.  In our case there's really just one...the master VGS server is a client of this worker

    var data = "ready";
    io.sockets.emit('update workers', { dataKey: data });
}

function nowTime() {
    var dt = String(new Date());
    // Strip out day of week, year, and the time zone
    return dt.substring(4, 11) + dt.substring(16, 24);
}

function endsWith(str, suffix) {
    return str.toLowerCase().indexOf(suffix, str.length - suffix.length) !== -1;
}

function startsWith(str, prefix) {
    return str.indexOf(prefix) === 0;
}

function DebugLogCurrentGPUJobCounts() {
    var str = "Current GPU job counts:  ";
    for (var i = 0, len = gpuJobCounts.length; i < len; i++) {
        str += gpuJobCounts[i];
        if (i < len - 1)
            str += ", ";
    }
    console.log(str);
}

function AssignGPUForJob() {
    var bestGPUJobCount = 9999;
    var bestGPUIndex = 0;
    for (var i = 0, len = gpuJobCounts.length; i < len; i++) {
        if (gpuJobCounts[i] < bestGPUJobCount) {
            bestGPUJobCount = gpuJobCounts[i];
            bestGPUIndex = i;
        }
    }
    return bestGPUIndex;
}

function UnassignGPUForJob(index) {
    var gpu = workerJobs[index].assignedGPUIndex;
    gpuJobCounts[gpu]--;
    DebugLogCurrentGPUJobCounts();
}

// This is called from the master server
app.get('/VideoGen/:HPName/:Parameters/:Id/:EventSessionId/:MasterServerSessionId/:BackupDrive/:VideoFilename', function(request, response) {
    response.send();

    var HPName = request.params.HPName;
    var parameters = request.params.Parameters;
    var id = parseInt(request.params.Id);
    var eventSessionId = parseInt(request.params.EventSessionId);
    var masterServerSessionId = parseInt(request.params.MasterServerSessionId);
    var backupDrive = request.params.BackupDrive;
    var targetVideoFilename = request.params.VideoFilename;

    var gpuIndex = AssignGPUForJob();
    gpuJobCounts[gpuIndex]++;
    DebugLogCurrentGPUJobCounts();

    var keyword = "VideoFileName:";
    var keywordLen = keyword.length;
    var videoFilename = "";

    var keywordFinalizing = "JobIsFinalizing";
    var keywordFinalizingLen = keywordFinalizing.length;

    console.log("Starting video gen script for ID:" + id + "; HP:" + HPName + "; parameters:" + parameters + "; assigned GPU index:" + gpuIndex + '; target video filename:' + targetVideoFilename);

    var jobObject = {
        jobId: id,
        spawnedProcess: null,
        HaxxisProcessId: 0,
        assignedGPUIndex: gpuIndex,
        errorCode: 0,
        lifelineResponse: null,
        MSSID: masterServerSessionId
    };

    HPName = HPName.replace(/\\/g, '/');

    var donewaiting = function() {
        console.log("Beginning generation");

        workerJobs.push(jobObject);
        //DumpWorkerJobs();

        var childVideoGen = spawn('bash', ['DoVideoGen.sh', HPName, parameters, id, gpuIndex, eventSessionId, masterServerSessionId, backupDrive, targetVideoFilename], {});

        // Save the child process reference so we can kill it later if need be
        var index = WorkerJobIndexFromIdAndMSSId(id, masterServerSessionId);
        workerJobs[index].spawnedProcess = childVideoGen;

        childVideoGen.stdout.on('data', function (data) {
            if (workerServerShuttingDown)
                return;

            var stringIn = String(data);
            if (stringIn.substring(0, keywordLen) === keyword) {
                videoFilename = stringIn.substring(keywordLen, stringIn.length);
                console.log("Video file name recognized: " + videoFilename);
                Socket.emit('worker job partial info', { jobIdKey: id, MSSIDKey: masterServerSessionId, videoFilenameKey: videoFilename, gpuIndexKey: gpuIndex });
            } else if (stringIn.substring(0, keywordFinalizingLen) === keywordFinalizing) {
                Socket.emit('worker job progress info', { jobIdKey: id, MSSIDKey: masterServerSessionId, progressKey: 100, progressTextKey: "Finalizing" });
            } else {
                console.log("childVideoGen: " + data);
            }
        });

        childVideoGen.on('exit', function (exitCode) {
            // Note that this also gets called when the bash script process is killed, in which case exitCode is null
            if (exitCode != null) {
                console.log("Video generation bash script ended for HP: " + HPName + "; exited with code: " + exitCode);
            } else {
                console.log("Job killed (id: " + id + ")");
            }
            var index = WorkerJobIndexFromIdAndMSSId(id, masterServerSessionId);
            if (workerJobs[index].errorCode !== 0)  // An earlier error has priority
                exitCode = workerJobs[index].errorCode;
            
            if (!workerServerShuttingDown) {
                console.log("Sending result to master server");
                Socket.emit('worker job result', { jobIdKey: id, MSSIDKey: masterServerSessionId, exitCodeKey: exitCode });
            }

            UnassignGPUForJob(index);
            if (index >= 0) {
                workerJobs.splice(index, 1); // Delete the worker job record
                //DumpWorkerJobs();
            } else {
                console.log("Error: Worker job ended naturally but cannot find the recorded job id");
            }
        });
    }

    if(HPName.startsWith('Specials')) {
        var hppath = process.env.CGC_LOCAL_BUILD_ROOT + '/HaxxisPackages';
        var lpbm = fs.readFileSync(hppath + '/LastPackagesBuildMade.txt', 'utf8');
        hppath += '/' + lpbm.split('\n')[0].trim();

        if(!fs.existsSync(hppath + '/Specials'))
            fs.mkdirSync(hppath + '/Specials');

        if(!fs.existsSync(hppath + '/' + HPName)) {
            console.log("Don't have the package, need to fetch.");

            Socket.emit('worker job progress info', { jobIdKey: id, MSSIDKey: masterServerSessionId, progressKey: 0, progressTextKey: "Fetching Special Package" })
            Socket.emit('fetch special', { name: HPName.slice(9) }, function(data) {
                if(data.success) { // Hooray, package!
                    fs.writeFileSync(hppath + '/' + HPName, data.file)
                }
                donewaiting();
            });
        } else {
            console.log("Have package, don't need to fetch.");
            donewaiting();
        }
    } else {
        donewaiting();
    }
})


// This is called from Haxxis, BUT NO LONGER USED
app.get('/JobProcessID/:Id/:MSSId/:ProcessId', function (request, response) {
    response.send();

    if (workerServerShuttingDown)
        return;

    var id = parseInt(request.params.Id);
    var processId = parseInt(request.params.ProcessId);
    var masterServerSessionId = parseInt(request.params.MSSId);

    //console.log("Received Process ID from Haxxis; id=" + id + "; processId=" + processId);
    var index = WorkerJobIndexFromIdAndMSSId(id, masterServerSessionId);
    if (index >= 0) {
        workerJobs[index].HaxxisProcessId = processId;
    } else {
        console.log("The job has already been killed, however");
    }
})


// This is called from Haxxis
// This is a "long poll"; we send the response if we want to tell Haxxis to kill itself
app.get('/JobLifeline/:Id/:MSSId', function (request, response) {

    if (workerServerShuttingDown) {
        response.send();
        return;
    }

    var id = parseInt(request.params.Id);
    var masterServerSessionId = parseInt(request.params.MSSId);

    console.log("Received LIFELINE request from Haxxis client, job id:" + id);

    var index = WorkerJobIndexFromIdAndMSSId(id, masterServerSessionId);
    if (index >= 0) {
        workerJobs[index].lifelineResponse = response;
    } else {
        console.log("The job has already been killed");
    }
})


// This is called from Haxxis
app.get('/JobProgress/:Id/:MSSId/:ProgressPct/:ProgressText', function (request, response) {
    response.send();

    if (workerServerShuttingDown)
        return;

    var id = parseInt(request.params.Id);
    var masterServerSessionId = parseInt(request.params.MSSId);
    var progressPct = request.params.ProgressPct;
    var progressText = request.params.ProgressText;

    //console.log("Received progress update from Haxxis; id=" + id + "; MSSID=" + masterServerSessionId + "; pct=" + progressPct + "; text=" + progressText);
    //DumpWorkerJobs();
    var index = WorkerJobIndexFromIdAndMSSId(id, masterServerSessionId);
    if (index >= 0) {
        var masterServerSessionId = workerJobs[index].MSSID;

        //console.log("Received progress update from Haxxis; passing on to master server: id=" + id +"; pct=" + progressPct + "; text=" + progressText);
        Socket.emit('worker job progress info', { jobIdKey: id, MSSIDKey: masterServerSessionId, progressKey: progressPct, progressTextKey: progressText });
    }
})


// This is called from Haxxis
app.get('/JobResult/:Id/:MSSId/:ErrorCode', function (request, response) {
    response.send();

    if (workerServerShuttingDown)
        return;

    var id = parseInt(request.params.Id);
    var masterServerSessionId = parseInt(request.params.MSSId);
    var errorCode = parseInt(request.params.ErrorCode);

    var index = WorkerJobIndexFromIdAndMSSId(id, masterServerSessionId);
    if (index >= 0) {
        if (workerJobs[index].errorCode !== 0) {
            console.log("Received ADDITIONAL error code message from Haxxis; ignoring, as we just want the first error code.  id=" + id + "; errorCode=" + errorCode);
        } else {
            console.log("Received error code message from Haxxis; registering, and passing on to master server: id=" + id + "; errorCode=" + errorCode);

            workerJobs[index].errorCode = errorCode;

            Socket.emit('worker job error code', { jobIdKey: id, MSSIDKey: masterServerSessionId, errorCodeKey: errorCode });
        }
    } else {
        console.log("ERROR:  worker job not found");
    }
})


// This is called from Haxxis
app.get('/VideoDuration/:Id/:MSSId/:FrameCount/:Duration', function (request, response) {
    response.send();

    if (workerServerShuttingDown)
        return;

    var id = parseInt(request.params.Id);
    var masterServerSessionId = parseInt(request.params.MSSId);
    var frameCount = parseInt(request.params.FrameCount);
    var duration = parseFloat(request.params.Duration);

    var index = WorkerJobIndexFromIdAndMSSId(id, masterServerSessionId);
    if (index >= 0) {
        console.log("Received video duration information from Haxxis:  FrameCount=" + frameCount + "; Duration=" + duration);

        Socket.emit('worker job video duration', { jobIdKey: id, MSSIDKey: masterServerSessionId, frameCount: frameCount, duration: duration });
    } else {
        console.log("ERROR:  worker job not found");
    }
})


// This interface is part of the VRS (Video Retrieval System)
app.get('/GetVideo/:EventSessionId/:JobId/:VideoFilename', function (request, response) {

    if (workerServerShuttingDown) {
        response.send();
        return;
    }

    var eventSessionId = parseInt(request.params.EventSessionId);
    var jobId = parseInt(request.params.JobId);
    var videoFilename = request.params.VideoFilename;

    console.log("Received request to retrieve video; eventSessionId=" + eventSessionId + "; jobId=" + jobId + "; videoFilename=" + videoFilename);

    var options = {
        root: __dirname + '/Public/GeneratedVideos/EventSession_' + eventSessionId,
        dotfiles: 'deny',
        headers: {
            'x-timestamp': Date.now(),
            'x-sent': true
        }
    };

    response.sendFile(videoFilename, options, function (err) {
        if (err) {
            console.log(err);
            // response.status(err.status).end();  // If this line is active, we get at least 3 different kinds of crashes when scrubbing video, one of which is: 'cannot read property 'toString' of undefined (statusCode).'
        }
        else {
            console.log('Sent:', videoFilename);
        }
    });
})

app.get('/FetchVideo/:EventSessionId/:JobId/:VideoFilename', function (request, response) {

    if(workerServerShuttingDown) {
        response.send();
        return;
    }

    var eventSessionId = parseInt(request.params.EventSessionId);
    var jobId = parseInt(request.params.JobId);

    console.log("Received request to retrieve video; eventSessionId=" + eventSessionId + "; JobId=" + jobId);

    var options = {
        root: __dirname + '/Public/GeneratedVideos/EventSession_' + eventSessionId,
        dotfiles: 'deny',
        headers: {
            'x-timestamp': Date.now(),
            'x-sent': true
        }
    };

    
    response.sendFile(request.params.VideoFilename, options, function(err) {
        if(err) console.log(err);
        else console.log("Sent: ", request.params.VideoFilename);
    })
})


function WorkerServerInit() {
    console.log("WorkerServerInit");

    var configs = {
        MasterIP: "localhost",
        LocalIP: require("ip").address(),
        Name: "Test Worker",
        RegularSlots: 1,
        SpecialSlots: 1,
        Drive1: "C",
        Drive2: "D"
    }

    fs.readFile("VideoGenWorkerServerConfig.txt", 'utf8', function(err, data) {
        if(err) {
            console.log("Problem finding or reading Worker Configuration, assuming Master knows about me");
            return;
        }
        var lines = data.split("\n");
        lines.forEach(function (line) {
            line = line.trim();

            for(var property in configs) {
                if(line.startsWith(property + ":")) {
                    line = line.substring((property + ":").length).trim();
                    if(typeof configs[property] === 'string') {
                        configs[property] = line;
                    } else if(typeof configs[property] === 'number') {
                        configs[property] = parseInt(line);
                    }
                }
            }
        })

        console.log("Master is at " + configs.MasterIP + " and chances are they don't know I'm here.");
        console.log("I am " + configs.Name + " and I'm at " + configs.LocalIP + ".  Notifying Master.");
        var path = '/RegisterWorker/' + configs.LocalIP + '/' + encodeURIComponent(configs.Name) + '/' + configs.RegularSlots + '/' + configs.SpecialSlots + '/' + configs.Drive1 + '/' + configs.Drive2;
        console.log(path);

        var req = http.request({hostname: configs.MasterIP, port: 8003, path: path, method: 'GET' }, function (res) {
            res.on('data', function(d) {
                console.log("Master responded: " + d);
            });
        });
        req.on('error', function (e) {
            console.log("Problem registering with Master: " + e.message);
        });
        req.end();
    })

    var keywordGPUCount = "GPUCount:";
    var keywordGPUCountLen = keywordGPUCount.length;
    // Start with the assumption that we have one GPU; this is because the bash script
    // will take some time to execute and we may get a job request in the mean time
    numGPUs = 1;
    gpuJobCounts.push(0);

    var childGetNumGPUs = spawn('bash', ['DoGetNumGPUs.sh'], {});

    childGetNumGPUs.stdout.on('data', function (data) {
        var stringIn = String(data);
        if (stringIn.substring(0, keywordGPUCountLen) === keywordGPUCount) {
            var field = stringIn.substring(keywordGPUCountLen, stringIn.length);
            var gpuCount = parseInt(field);
            if (gpuCount > numGPUs) {
                numGPUs = gpuCount;
                while (gpuJobCounts.length < numGPUs)
                    gpuJobCounts.push(0);
            }
        } else {
            console.log("childGetNumGPUs: " + data);
        }
    });

    childGetNumGPUs.on('exit', function (exitCode) {
        if (exitCode != null) {
            console.log("This worker has " + numGPUs + " GPUs");            
        } else {
            console.log("DoGetNumGPUs bash script killed");
        }
    });
}

WorkerServerInit();

server.listen(port);
