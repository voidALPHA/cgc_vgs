var port = 8003;
var workerPort = 8004;
var chatPort = 3000;

"use strict";

var express = require('express');
var app = express();
var favicon = require('serve-favicon');
var http = require('http');
var server = http.Server(app);
var io = require('socket.io')(server);
var ioc = require('socket.io-client');
var jsonfile = require('jsonfile');

var mailer = require('nodemailer');
var path = require("path");
var fs = require('fs');
require('log-timestamp');
var spawn = require('child_process').spawn;
var os = require('os');
var request = require('request');


var numWorkers = 0;
var workers = {};   // Array of all workers

const maxRequestedJobs = 5000;

var firstJobId = nextJobId = 10000;
var firstBatchId = nextBatchId = 100;
var firstMasterServerSessionId = masterServerSessionId = 10;
var eventSessionId = 101;

var jobRecords = [];    // Master array of all jobs

var batchRecords = [];  // Master array of all batch jobs

var numWaitingJobs = 0;
var numActiveJobsTotal = 0;
var numSuccessfullyCompletedJobs = 0;
var numFailedJobs = 0;
var numCancelledJobs = 0;
var numKilledJobs = 0;

var jobStatusEnum = {
    WAITING: 0,
    ACTIVE: 1,
    COMPLETED_SUCCESS: 2,
    COMPLETED_FAIL: 3,
    CANCELLED: 4,
    KILLED: 5
};

var batchStatusEnum = {
    WAITING: 0,
    ACTIVE: 1,
    COMPLETED_SUCCESS: 2,
    COMPLETED_FAIL: 3
    // For now let's just go with the above
};

var specialPriorityThreshold = 50;
var priorityMax = 99;
var priorityMin = 0;

var StressTestCount = 0;
var DefaultItemsPerPage = 30;
var DefaultItemsPerPageBatch = 10;
var SupressChatNotifications = false;

var masterHasShutDown = false;

// Global settings that can be configured by web clients (and in the config text file)
// Note that these key names must match those in the HTML
var gs = {};
gs['TraceApiUrl'] = "localhost:8000";
gs['ScreenRes'] = "1920x1080";
gs['FullScreen'] = "Off";
gs['CodecName'] = "x264";
gs['ExtraParameters'] = "";
gs['RealTime'] = "Off";
gs['FrameRate'] = "Thirty";
gs['DownScale'] = "Original";
gs['CurrentRound'] = -1;
gs['PreviousRound'] = -1;
gs['AutoRoundBatch'] = "Off";
gs['AutoRoundCheckFequency'] = 10;
gs['AutoSaveFrequencyMs'] = 8000;

var latestBuildVersion = "Unknown";
var latestPackagesVersion = "Unknown";


/*var transporter = mailer.createTransport({
    service: 'Gmail',
    auth: {
        user: 'user@example.com',
        pass: 'myveryexcellentpassword'
    }
});*/

app.use(express.static('public'));
app.use(express.static('recipes'));

app.use(favicon(__dirname + '/favicon_vgs.png'));

app.get('/VGS', function (request, response) {
    response.sendFile(path.join(__dirname + '/VideoGenServer.html'));
});

app.get('/Recipes', function (request, response) {
    response.sendFile(path.join(__dirname + '/Recipes.html'));
});

app.get('/VideoGenServer.css', function (request, response) {
    response.sendFile(path.join(__dirname + '/VideoGenServer.css'));
})

app.get('/VGS/BuildDeployed/:Version', function (request, response) {
    response.send();
    latestBuildVersion = request.params.Version;
    SendWorkerStatusesToClients(true);
});

app.get('/VGS/PackagesBuildDeployed/:Version', function (request, response) {
    response.send();
    latestPackagesVersion = request.params.Version;
    SendWorkerStatusesToClients(true);
});

app.get('/VGS/VideoInfo/:JobId', function (request, response) {
    // Allow this to be called from other >HTML< besides the VGS HTML (e.g. V35's TraceAPI HTML)
    response.header("Access-Control-Allow-Origin", "*");
    response.header("Access-Control-Allow-Headers", "X-Requested-With");

    var jobId = parseInt(request.params.JobId);

    var index = -1;
    for (var i = 0, len = jobRecords.length; i < len; i++) {
        if (jobRecords[i].id == jobId) {
            index = i;
            break;
        }
    }
    var exists = (index >= 0);
    var ready = (exists && jobRecords[index].status === jobStatusEnum.COMPLETED_SUCCESS);
    var status = -1;
    var workerIp = "";
    var progressPct = 0;
    var progressText = "";
    var videoFilename = "";
    if (exists) {
        status = jobRecords[index].status;
        workerIp = jobRecords[index].workerIp;
        progressPct = jobRecords[index].progress;
        progressText = jobRecords[index].progressText;
        videoFilename = jobRecords[index].videoFilename;
    }

    var data = {
        "exists": exists,
        "ready": ready,
        "status": status,
        "eventSessionId": eventSessionId,
        "workerIp": workerIp,
        "videoFilename": videoFilename,
        "progressPct": progressPct,
        "progressText": progressText
    };
    response.send(data);
})

app.get('/VGS/BatchInfo/:BatchId', function (request, response) {
    // Allow this to be called from other >HTML< besides the VGS HTML (e.g. V35's TraceAPI HTML)
    response.header("Access-Control-Allow-Origin", "*");
    response.header("Access-Control-Allow-Headers", "X-Requested-With");

    var batchId = parseInt(request.params.BatchId);

    var index = -1;
    for (var i = 0, len = batchRecords.length; i < len; i++) {
        if (batchRecords[i].id == batchId) {
            index = i;
            break;
        }
    }
    var exists = (index >= 0);
    var ready = (exists && batchRecords[index].status === batchStatusEnum.COMPLETED_SUCCESS);
    var status = -1;
    var progressPct = 0;
    var progressText = "";
    var numJobsTotal = 0;
    var numJobsComplete = 0;
    if (exists) {
        status = batchRecords[index].status;
        progressPct = batchRecords[index].progress;
        progressText = batchRecords[index].progressText;
        numJobsTotal = batchRecords[index].numJobsTotal;
        numJobsComplete = batchRecords[index].numJobsComplete;
    }

    var data = {
        "exists": exists,
        "ready": ready,
        "status": status,
        "eventSessionId": eventSessionId,
        "progressPct": progressPct,
        "progressText": progressText,
        "numJobsTotal": numJobsTotal,
        "numJobsComplete": numJobsComplete
    };
    response.send(data);
})

app.get('/VGS/RoundInfo/:Round', function(request, response) {
    // Allow this to be called from other >HTML< besides the VGS HTML (e.g. V35's TraceAPI HTML)
    response.header("Access-Control-Allow-Origin", "*");
    response.header("Access-Control-Allow-Headers", "X-Requested-With");

    var round = parseInt(request.params.Round);

    var numJobsTotal = 0;
    var numJobsComplete = 0;

    // First, make a list of all auto per-round batches that match the given round number
    matchingBatchIds = [];
    for (var i = 0, len = batchRecords.length; i < len; i++) {
        if (batchRecords[i].autoRoundNum >= 0 &&
            batchRecords[i].autoRoundNum === round) {
            matchingBatchIds.push(batchRecords[i].id);
            numJobsTotal += batchRecords[i].numJobsTotal;
            numJobsComplete += batchRecords[i].numJobsComplete;
        }
    }
    var exists = (matchingBatchIds.length > 0);
    var ready = false;
    var progressPct = 0;
    if (numJobsTotal > 0) {
        progressPct = numJobsComplete * 100 / numJobsTotal;
    }
    jobData = [];
    if (exists) {
        ready = (numJobsComplete === numJobsTotal);

        // Gather up info about every job that matches this auto-generated round
        for (var i = 0, len = jobRecords.length; i < len; i++) {
            //console.log("checking job index " + i);
            var job = jobRecords[i];
            if (job.batchId >= 0) {
                var found = false;
                //console.log("Searching for match of job.batchId " + job.batchId);
                for (var j = 0; j < matchingBatchIds.length; j++) {
                    if (job.batchId === matchingBatchIds[j]) {
                        found = true;
                        break;
                    }
                }
                if (found) {
                    var workerIp = "Undecided";
                    if (job.workerIp != "") {
                        workerIp = job.workerIp;
                    }
                    var jd = {
                        id: job.id,
                        HPName: job.HPName,
                        videoFilename: job.videoFilename,
                        videoDuration: job.videoDuration,
                        status: job.status,
                        errorCode: job.errorCode,
                        workerIp: workerIp
                    };
                    jobData.push(jd);
                }
            }
        }
    }

    var data = {
        "exists": exists,
        "ready": ready,
        "eventSessionId": eventSessionId,
        "progressPct": progressPct,
        "numJobsTotal": numJobsTotal,
        "numJobsComplete": numJobsComplete,
        "jobData": jobData
    };
    response.send(data);
})

// This is also for external callers like the VRS.
// Given a round number, this returns the next round after that (if any, otherwise it returns the same round number)
// that has at least one batch of automatic per-round videos.  Basically it tells the caller that there is a batch(es)
// of automatic per-round videos at least started, for the next round.

app.get('/VGS/Round/After/:Round', function (request, response) {
    // Allow this to be called from other >HTML< besides the VGS HTML (e.g. V35's TraceAPI HTML)
    response.header("Access-Control-Allow-Origin", "*");
    response.header("Access-Control-Allow-Headers", "X-Requested-With");

    var currentRound = parseInt(request.params.Round);

    // Find the lowest autoRoundNum that's greater than the input round number.

    // Go through entire batch list, and find the lowest "autoRoundNum" that's greater than the input round number; If none found, go with the current round number
    var nextRound = 9999;
    for (var i = 0, len = batchRecords.length; i < len; i++) {
        var autoRoundNum = batchRecords[i].autoRoundNum;
        if (autoRoundNum >= 0 && // If this batch is for an auto per-round batch
            autoRoundNum > currentRound && // And it is for a round equal to or later than the given round
            autoRoundNum < nextRound) { // And it is the lowest of the those rounds
            nextRound = autoRoundNum;
        }
    }
    if (nextRound === 9999) {
        nextRound = currentRound;
    }

    // Now create a list of all batches that are auto batches that are associated with that round
    var batchIdsForRound = [];
    for (var i = 0, len = batchRecords.length; i < len; i++) {
        var autoRoundNum = batchRecords[i].autoRoundNum;
        if (autoRoundNum >= 0 && autoRoundNum === nextRound) {
            batchIdsForRound.push(batchRecords[i].id);
        }
    }

    var data = {
        "nextRound": nextRound,
        "batchIdsForRound": batchIdsForRound
    };
    response.send(data);
})

app.get('/FetchVideo/:id/view', function(request, response) {
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("Content-Type", "video/mp4");
    VGSLog(1, 'Asked to retrieve video for Job ' + request.params.id + ' for playback');

    var jobId = parseInt(request.params.id);

    var index = -1;
    for (var i = 0, len = jobRecords.length; i < len; i++) {
        if (jobRecords[i].id == jobId) {
            index = i;
            break;
        }
    }
    var exists = (index >= 0);
    var workerIp = "";
    if (exists) {
        workerIp = jobRecords[index].workerIp;
        videoFilename = jobRecords[index].videoFilename;
    }

    var options = { hostname: workerIp, port: workerPort, path: '/FetchVideo/' + eventSessionId + '/' + jobId + '/' + videoFilename, method: 'GET' };

    var req = http.request(options, function(res) {
        res.on('data', function(e) {
            response.write(e, 'binary')
        })

        res.on('end', function(e) {
            response.end(null, 'binary');
        })
    })
    
    req.on('error', function(e) {
        VGSLog(0, 'Problem with FetchVideo request: ' + e.message);
        response.send('Problem with FetchVideo request: ' + e.message);
    })

    req.end();
})
app.get('/FetchVideo/:id/download/:suggestedName', function(request, response) {
    response.setHeader("Content-Disposition", 'attachment; filename="' + request.params.suggestedName + '"');
    response.setHeader("Content-Type", "video/mp4");
    VGSLog(1, 'Asked to retrieve video for Job ' + request.params.id + ' for download; suggesting filename ' + request.params.suggestedName);

    var jobId = parseInt(request.params.id);

    var index = -1;
    for (var i = 0, len = jobRecords.length; i < len; i++) {
        if (jobRecords[i].id == jobId) {
            index = i;
            break;
        }
    }
    var exists = (index >= 0);
    var workerIp = "";
    if (exists) {
        workerIp = jobRecords[index].workerIp;
        videoFilename = jobRecords[index].videoFilename;
    }

    var options = { hostname: workerIp, port: workerPort, path: '/FetchVideo/' + eventSessionId + '/' + jobId + '/' + videoFilename, method: 'GET' };

    var req = http.request(options, function(res) {
        response.setHeader("content-length", res.headers['content-length']);

        res.on('data', function(e) {
            response.write(e, 'binary');
        })

        res.on('end', function(e) {
            response.end(null, 'binary');
        })
    })
    
    req.on('error', function(e) {
        VGSLog(0, 'Problem with FetchVideo request: ' + e.message);
        response.send('Problem with FetchVideo request: ' + e.message);
    })

    req.end();
})

app.get('/RegisterWorker/:ipAddress/:friendlyName/:startingRegularJobs/:startingSpecialJobs/:drive1/:drive2', function(request, response) {
    var newWorker = {
        ip: request.params.ipAddress,
        friendlyName: request.params.friendlyName,
        maxJobsRegular: parseInt(request.params.startingRegularJobs),
        maxJobsSpecial: parseInt(request.params.startingSpecialJobs),
        paused: false,
        hardPaused: false,
        numActiveJobs: 0,
        numActiveJobsRegular: 0,
        numActiveJobsSpecial: 0,
        numAvailSlotsRegular: parseInt(request.params.startingRegularJobs),
        numAvailSlotsSpecial: parseInt(request.params.startingSpecialJobs),
        jobLoadPctRegular: 0,
        jobLoadPctSpecial: 0,
        loadCPU: 0,
        loadCPUArray: [],
        loadMem: 0,
        loadGPU: 0,
        loadGPUArray: [],
        numGPUs: 0,
        disk1DriveLetter: request.params.drive1,
        disk2DriveLetter: request.params.drive2,
        disk1SpaceUsed: 0,
        disk1SpaceTotal: 0,
        disk2SpaceUsed: 0,
        disk2SpaceTotal: 0,
        loadRequestTimeout: null,
        connected: false,
        buildVersion: "Unknown",
        pendingGetBuildRequest: false,
        packagesVersion: "Unknown",
        pendingGetPackagesRequest: false,
        pendingRestartRequest: false,
        pendingShutdownRequest: false
    };

    for(var workerip in workers) {
        if(workerip == newWorker.ip) {
            VGSLog(0, "Worker " + workers[workerip].friendlyName + " tried to Late Register despite already being known.");
            response.send("Hello again Worker " + workers[workerip].friendlyName);
            return;
        }
    }

    workers[newWorker.ip] = newWorker;
    VGSLog(0, "Worker \"" + newWorker.friendlyName + "\" Late Registered at IP " + newWorker.ip + " with " + newWorker.maxJobsRegular + " + " + newWorker.maxJobsSpecial + " job slots.");
    numWorkers++;

    ConnectToWorker(newWorker);
    SendWorkerStatusesToClients(false);

    response.send("Welcome, Worker " + newWorker.friendlyName);
})

function CancelWaitingJob(jobIndex) {
    jobRecords[jobIndex].status = jobStatusEnum.CANCELLED;
    jobRecords[jobIndex].errorCode = -2;
    jobRecords[jobIndex].completionTime = nowTime();
    jobRecords[jobIndex].videoFilename = "None";
    numWaitingJobs--;
    numCancelledJobs++;

    RegisterJobAsDoneInBatch(jobIndex);

    saveDirty = true;
}

function DeleteJobRecordIfAppropriate(jobIndex) {
    var deleteMe = true;
    saveDirty = true;

    switch (jobRecords[jobIndex].status) {
        case jobStatusEnum.WAITING:
        case jobStatusEnum.ACTIVE:
            deleteMe = false;
            break;
        case jobStatusEnum.COMPLETED_SUCCESS:
            numSuccessfullyCompletedJobs--;
            break;
        case jobStatusEnum.COMPLETED_FAIL:
            numFailedJobs--;
            break;
        case jobStatusEnum.CANCELLED:
            numCancelledJobs--;
            break;
        case jobStatusEnum.KILLED:
            numKilledJobs--;
            break;
    }
    if (deleteMe)
        jobRecords.splice(jobIndex, 1);    // Delete the job record

    return deleteMe;
}

function ClientIndexFromId(clientId) {
    for (var i = 0, len = clients.length; i < len; i++) {
        if (clients[i].clientId == clientId) {
            return i;
        }
    }
    return -1;
}

function IndexFromTrackedJobMatch(clientIndex, jobId) {
    for (var i = 0, len = clients[clientIndex].trackedJobs.length; i < len; i++) {
        if (clients[clientIndex].trackedJobs[i] === jobId) {
            return i;
        }
    }
    return -1;
}

var nextUniqueClientId = 101;
var clients = [];

var clientIdDisconnecting = -1;
var clientDisconnectTimeout;

io.on('connection', function (socket) {
    console.log("In server's connection handler");

    // Per-client variables:
    var clientId;

    saveDirty = true;

    var BasicStatusSendFrequencyMs = 750;
    var WorkerTableSendFrequencyMs = 750;
    var JobTableSendFrequencyMs = 1250; // Not quite so frequent, as this interferes with job table button clicks (the 'real' fix would be to not regenerate the job table each update)
    var BatchTableSendFrequencyMs = 750;

    if (clientIdDisconnecting >= 0) {
        // Hacky way of 'reconnecting' (via browser refresh)
        clientId = clientIdDisconnecting;
        clientIdDisconnecting = -1;
        clearTimeout(clientDisconnectTimeout);

        var index = ClientIndexFromId(clientId);
        clients[index].socket = socket;

        VGSLog(1, "Client " + clientId + " has reconnected to the master server");
    } else {
        clientId = nextUniqueClientId++;

        // Register the client so we can talk to it individually later
        var clientInfo = {
            clientId: clientId,
            socket: socket,
            adminLevel: 2,
            curPage: 0,
            curPageBatch: 0,
            itemsPerPage: DefaultItemsPerPage,
            itemsPerPageBatch: DefaultItemsPerPageBatch,
            jobStatusFilter: -1, // Bit-wise filter flags for the various job statuses; -1 means 'all'
            jobSortField: 'id',
            jobSortAscending: true,
            batchStatusFilter: -1,  // Bit-wise filter flags for the various batch statuses; -1 means 'all'
            batchSortField: 'id',
            batchSortAscending: true,
            showingWorkerTable: true,
            showingWorkerTableSpecial: true,
            showingJobTable: true,
            showingBatchTable: true,
            jobTableSendCount: 0,       // Just used as a statistic
            jobTableSendDirty: false,
            workerTableSendCount: 0,    // Just a stat
            workerTableSendDirty: false,
            basicStatusSendCount: 0,    // Just a stat
            basicStatusSendDirty: false,
            batchTableSendCount: 0,     // Just a stat
            batchTableSendDirty: false,
            trackedJobs: [],
            eventSessionIdViewed: 0
        };
        clients.push(clientInfo);

        setTimeout(PeriodicBasicStatusSend, BasicStatusSendFrequencyMs);
        setTimeout(PeriodicWorkerTableSend, WorkerTableSendFrequencyMs);
        setTimeout(PeriodicJobTableSend, JobTableSendFrequencyMs);
        setTimeout(PeriodicBatchTableSend, BatchTableSendFrequencyMs);
    }

    SendGlobalSettingsToClients();    // I'm not worried that we're sending these to all clients, because we won't have that many
    SendBasicStatusToClient(ClientIndexFromId(clientId));
    SendWorkerStatusesToClient(ClientIndexFromId(clientId));
    SendJobStatusPageToClient(ClientIndexFromId(clientId));

    function PeriodicBasicStatusSend() {
        var index = ClientIndexFromId(clientId);
        if (index >= 0) {   // Only if the client is still around; otherwise don't restart the timer, etc.
            setTimeout(PeriodicBasicStatusSend, BasicStatusSendFrequencyMs);

            if (clients[index].basicStatusSendDirty) {
                clients[index].basicStatusSendDirty = false;
                //console.log('PeriodicBasicStatusSend for client ' + clientId);
                SendBasicStatusToClient(index);
            }
        }
    }

    function PeriodicWorkerTableSend() {
        var index = ClientIndexFromId(clientId);
        if (index >= 0) {   // Only if the client is still around; otherwise don't restart the timer, etc.
            setTimeout(PeriodicWorkerTableSend, WorkerTableSendFrequencyMs);

            if (clients[index].workerTableSendDirty) {
                clients[index].workerTableSendDirty = false;
                //console.log('PeriodicWorkerTableSend for client ' + clientId);
                SendWorkerStatusesToClient(index);
            }
        }
    }

    function PeriodicJobTableSend() {
        var index = ClientIndexFromId(clientId);
        if (index >= 0) {   // Only if the client is still around; otherwise don't restart the timer, etc.
            setTimeout(PeriodicJobTableSend, JobTableSendFrequencyMs);

            if (clients[index].jobTableSendDirty) {
                clients[index].jobTableSendDirty = false;
                //console.log('PeriodicJobTableSend for client ' + clientId);
                SendJobStatusPageToClient(index);
            }
        }
    }

    function PeriodicBatchTableSend() {
        var index = ClientIndexFromId(clientId);
        if (index >= 0) {   // Only if the client is still around; otherwise don't restart the timer, etc.
            setTimeout(PeriodicBatchTableSend, BatchTableSendFrequencyMs);

            if (clients[index].batchTableSendDirty) {
                clients[index].batchTableSendDirty = false;
                SendBatchStatusPageToClient(index);
            }
        }
    }

    socket.on('admin login', function(data) {
        var pw = data['password'];

        var clientIndex = ClientIndexFromId(clientId);
        var changeMade = false;
        var d = new Date();
        var m = d.getMinutes();
        var minutesStr = (m < 10) ? "0" + m : m;
        if (pw === 'normal') {
            changeMade = true;
            clients[clientIndex].adminLevel = 0;
        } else if (pw === 'nimda') {    
            changeMade = true;
            clients[clientIndex].adminLevel = 1;
        } else if (pw === 'nimdarepus' + minutesStr) {
            changeMade = true;
            clients[clientIndex].adminLevel = 2;
        }

        if (changeMade) {
            SendBasicStatusToClient(clientIndex);
        }
        var text = changeMade ? "" : "Incorrect";
        clients[clientIndex].socket.emit('admin login response', {
            responseText: text
        });
    })

    socket.on('get jobs status', function (data) {
        SendJobStatusPageToClient(ClientIndexFromId(clientId));
    })

    socket.on('get batches status', function (data) {
        SendBatchStatusPageToClient(ClientIndexFromId(clientId));
    })

    socket.on('get workers status', function (data) {
        SendWorkerStatusesToClient(ClientIndexFromId(clientId));
    })

    socket.on('set max regular jobs', function (data) {
        var workerIp = data['workerIpKey'];
        var newMax = data['newMaxKey'];
        var worker = workers[workerIp];
        var oldMax = worker.maxJobsRegular;
        VGSLog(0, "Changing max regular jobs on worker " + worker.friendlyName + " from " + oldMax + " to " + newMax);

        worker.maxJobsRegular = newMax;
        if (newMax > oldMax) {
            AttemptJobStarts();
        }

        SendWorkerStatusesToClients(true);
    })

    socket.on('set max special jobs', function (data) {
        var workerIp = data['workerIpKey'];
        var newMax = data['newMaxKey'];
        var worker = workers[workerIp];
        var oldMax = worker.maxJobsSpecial;
        VGSLog(0, "Changing max special jobs on worker " + worker.friendlyName + " from " + oldMax + " to " + newMax);

        worker.maxJobsSpecial = newMax;
        if (newMax > oldMax) {
            AttemptJobStarts();
        }

        SendWorkerStatusesToClients(true);
    })

    socket.on('get hp parameters', function(data) {
        var hpName = data['hpName'];

        // Find the first connected worker, and request that worker to do the lookup
        // (this is so we can run the master server on a non-worker machine if we need to)
        var worker = null;
        for(var workerIp in workers) {
            if(workers[workerIp].connected) {
                worker = workers[workerIp];
                break;
            }
        }

        var workerClient = worker.ioc;
        workerClient.emit('get hp parameters', { hpName: hpName, requestingClientId: clientId }, function(message) {});
    })

    socket.on('get hp list', function (data) {
        // Find the first connected worker, and request that worker to create the list
        // (this is so we can run the master server on a non-worker machine if we need to)
        var worker = null;
        for(var workerIp in workers) {
            if(workers[workerIp].connected) {
                worker = workers[workerIp];
                break;
            }
        }

        var workerClient = worker.ioc;
        workerClient.emit('get hp list', { requestingClientId: clientId }, function (message) { });
    })

    socket.on('get latest build', function (data) {
        var workerIp = data['workerIpKey'];
        var worker = workers[workerIp];
        VGSLog(0, "Get latest build request for worker " + worker.friendlyName);

        if (worker.pendingGetBuildRequest) {
            VGSLog(0, "Error: a 'get latest build' request was made for worker " + worker.friendlyName + " but that worker already has a request");
            return;
        }
        worker.pendingGetBuildRequest = true;
        var workerClient = worker.ioc;
        workerClient.emit('master requests worker to get latest build', {  }, function (message) {
            VGSLog(0, "Callback from request to get latest build");
        });
        SendWorkerStatusesToClients(true);  // Send this to all clients so they see immediately that the request is in progress (via the fact the button is disabled and says 'getting...')
    })

    socket.on('get latest packages', function (data) {
        var workerIp = data['workerIpKey'];
        var worker = workers[workerIp];
        VGSLog(0, "Get latest packages request for worker " + worker.friendlyName);

        if (worker.pendingGetPackagesRequest) {
            VGSLog(0, "Error: a 'get latest packages' request was made for worker " + worker.friendlyName + " but that worker already has a request");
            return;
        }
        worker.pendingGetPackagesRequest = true;
        var workerClient = worker.ioc;
        workerClient.emit('master requests worker to get latest packages', {}, function (message) {
            VGSLog(0, "Callback from request to get latest packages");
        });
        SendWorkerStatusesToClients(true);  // Send this to all clients so they see immediately that the request is in progress (via the fact the button is disabled and says 'getting...')
    })

    socket.on('get latest build versions', function (data) {
        VGSLog(1, "Get latest build versions request");

        GetLatestBuildVersions();
    })

    socket.on('soft pause', function (data) {
        var workerIp = data['workerIpKey'];
        var worker = workers[workerIp];
        VGSLog(0, "Soft pause request for worker " + worker.friendlyName);

        worker.paused = true;
        worker.hardPaused = false;

        SendWorkerStatusesToClients(true);
    })

    socket.on('hard pause', function (data) {
        var workerIp = data['workerIpKey'];
        var worker = workers[workerIp];
        VGSLog(0, "Hard pause request for worker " + worker.friendlyName);

        worker.paused = true;
        worker.hardPaused = true;

        // Find all jobs that (were) running on the worker that disconnected, and put them back in the waiting queue
        RevertAllJobsForWorker(worker);

        AttemptJobStarts();

        SendJobStatusesToClients(true);
        SendBatchStatusesToClients(true);
        SendWorkerStatusesToClients(true);

        // Tell the worker to immediately kill all of its active jobs
        var workerClient = worker.ioc;
        workerClient.emit('kill all jobs', function () { });

    })

    socket.on('un pause', function (data) {
        var workerIp = data['workerIpKey'];
        var worker = workers[workerIp];
        VGSLog(0, "Un-pause request for worker " + worker.friendlyName);

        worker.paused = false;
        worker.hardPaused = false;

        AttemptJobStarts();

        SendWorkerStatusesToClients(true);
    })

    socket.on('kill all jobs on worker', function (data) {
        var workerIp = data['workerIpKey'];
        var worker = workers[workerIp];
        VGSLog(0, "Request to kill all active jobs on worker " + worker.friendlyName);

        for (index = 0, len = jobRecords.length; index < len; index++) {
            if (jobRecords[index].status === jobStatusEnum.ACTIVE && jobRecords[index].workerIp === worker.ip) {
                VGSLog(0, "Killing job " + jobRecords[index].id);
                KillJob(index);
            }
        }

        SendWorkerStatusesToClients(true);
        SendBasicStatusToClients(true);
        SendJobStatusesToClients(true);
        SendBatchStatusesToClients(true);
    })

    socket.on('restart worker', function (data) {
        var workerIp = data['workerIpKey'];
        var worker = workers[workerIp];
        VGSLog(0, "Server RESTART request for worker " + worker.friendlyName);

        if (worker.pendingRestartRequest) {
            VGSLog(0, "Error: a 'restart worker' request was made for worker " + worker.friendlyName + " but that worker already has a request to restart");
            return;
        }
        worker.pendingRestartRequest = true;

        // Find all jobs that (were) running on the worker that disconnected, and put them back in the waiting queue
        RevertAllJobsForWorker(worker);

        AttemptJobStarts();

        SendJobStatusesToClients(true);
        SendBatchStatusesToClients(true);
        SendWorkerStatusesToClients(true);  // Send this to all clients so they see immediately that the request is in progress (via the fact the button is disabled)

        var workerClient = worker.ioc;
        workerClient.emit('master requests worker restart or shutdown', { restartKey: true }, function (message) {
            VGSLog(0, "Callback from request to get do system restart");
        });

        PostToStatusChat('VSG Worker server ' + worker.friendlyName + ' is being restarted...', ':slight_frown:', []);
    })

    socket.on('shutdown worker', function (data) {
        var workerIp = data['workerIpKey'];
        var worker = workers[workerIp];
        VGSLog(0, "Server SHUT DOWN request for worker " + worker.friendlyName);

        if (worker.pendingShutdownRequest) {
            VGSLog(0, "Error: a 'shut down worker' request was made for worker " + worker.friendlyName + " but that worker already has a request to shut down");
            return;
        }
        worker.pendingShutdownRequest = true;

        // Find all jobs that (were) running on the worker that disconnected, and put them back in the waiting queue
        RevertAllJobsForWorker(worker);

        AttemptJobStarts();

        SendJobStatusesToClients(true);
        SendBatchStatusesToClients(true);
        SendWorkerStatusesToClients(true);  // Send this to all clients so they see immediately that the request is in progress (via the fact the button is disabled)

        var workerClient = worker.ioc;
        workerClient.emit('master requests worker restart or shutdown', { restartKey: false }, function (message) {
            VGSLog(0, "Callback from request to get do system shutdown");
        });

        PostToStatusChat('VSG Worker server ' + worker.friendlyName + ' is being shut down!', ':poop:', []);
    })

    socket.on('save event session', function (data) {
        VGSLog(0, "Save request from client " + clientId);

        SaveEventSession(true);
    })

    socket.on('quit master server', function (data) {
        PostToStatusChat("VGS Master server software is quitting intentionally (but not the machine it's running on)", ':sob:', []);

        VGSLog(0, "QUIT MASTER SERVER request from client " + clientId);

        SaveEventSession(true);

        masterHasShutDown = true;

        SendGlobalSettingsToClients();
        SendWorkerStatusesToClients(true);
        SendBasicStatusToClients(true);
        SendJobStatusesToClients(true);
        SendBatchStatusesToClients(true);

        setTimeout(function () { process.exit(0); }, 1000); // Give it a second before exiting, so the clients can receive their update
    })

    socket.on('end event session', function (data) {
        VGSLog(0, "END EVENT SESSION request from client " + clientId);

        // Prerequisites:  auto-round-batch turned off, no waiting jobs, no active jobs
        if (gs['AutoRoundBatch'].toLowerCase() !== 'off') {
            VGSLog(0, "END EVENT SESSION request DENIED because auto batch is not set to OFF");
            return;
        }

        for (var i = 0, len = jobRecords.length; i < len; i++) {
            if (jobRecords[i].status === jobStatusEnum.ACTIVE) {
                VGSLog(0, "END EVENT SESSION request DENIED because there are active job(s)");
                return;
            }
            if (jobRecords[i].status === jobStatusEnum.WAITING) {
                VGSLog(0, "END EVENT SESSION request DENIED because there are waiting job(s)");
                return;
            }
        }

        for (var i = 0, len = batchRecords.length; i < len; i++) {
            //if (batchRecords[i].status === batchStatusEnum.ACTIVE) {
            //    VGSLog(0, "END EVENT SESSION request DENIED because there are active batch job(s)");
            //    return;
            //}
            //if (batchRecords[i].status === batchStatusEnum.WAITING) {
            //    VGSLog(0, "END EVENT SESSION request DENIED because there are waiting batch job(s)");
            //    return;
            //}
        }

        VGSLog(0, "END EVENT SESSION request ACCEPTED");

        // Save/close the database and log file, and archive
        SaveEventSession(true);

        var partialPath = "";
        var lastSlash = fileCurEventSession.lastIndexOf('/');
        if (lastSlash >= 0)
            partialPath = fileCurEventSession.substring(0, lastSlash + 1);
        var newFilename = partialPath + "EventSession_" + eventSessionId + ".json";
        fs.renameSync(fileCurEventSession, newFilename);

        var newLogFilename = partialPath + "SessionLog_" + eventSessionId + ".txt"; // This assumes the database and log file appear in the same folder
        fs.renameSync(logFileName, newLogFilename);

        // Tell all clients to clear out their log text
        for (var i = 0, len = clients.length; i < len; i++) {
            clients[i].socket.emit('clear log', {});
        }

        // Write out a csv file
        var newCsvFilename = partialPath + "EventSession_" + eventSessionId + ".csv";
        csvData = "HPName,,Video Duration,Parameters,ID,Status,Error Code,Start Time,Completion Time,Job Duration,Video Name,GPU Index,Worker Index,Priority\n";
        for (var i = 0, len = jobRecords.length; i < len; i++) {
            var j = jobRecords[i];
            var parameters = j.parameters;
            if (startsWith(parameters, '-'))    // NOTE:  Current issue is commas within the parameters, which messes up CSVs
                parameters = "'" + '\"' + parameters + '\"';   // Add a tilde to parameter strings that begin with a hyphen, so that Excel will display this field correctly
            csvData += j.HPName + "," + j.videoDuration + "," + parameters + "," + j.id + "," + j.status + "," + j.errorCode + "," + j.startTime + "," +
                j.completionTime + "," + j.duration + "," + j.videoFilename + "," + j.gpuIndex + "," + j.worker + "," + j.priority + "\n";
        }
        fs.writeFileSync(newCsvFilename, csvData);
        
        // Create the new event session
        nextJobId = firstJobId;
        nextBatchId = firstBatchId;
        eventSessionId++;
        jobRecords = [];    // The other way of doing this is:  jobRecords.length = 0;
        batchRecords = [];
        gs['CurrentRound'] = -1;
        gs['PreviousRound'] = -1;
        ResetMiscJobCounts();

        // Save the new event session
        SaveEventSession(true);

        // Reset all clients' "tracked jobs" since all those jobs have been deleted
        for (var i = 0, len = clients.length; i < len; i++) {
            clients[i].trackedJobs = [];
        }

        // Update the clients
        SendGlobalSettingsToClients();
        SendWorkerStatusesToClients(true);
        SendBasicStatusToClients(true);
        SendJobStatusesToClients(true);
        SendBatchStatusesToClients(true);

        VGSLog(0, "NEW EVENT SESSION with ID " + eventSessionId + " has been STARTED");

        PostToStatusChat("Event session " + (eventSessionId - 1) + " has been ended/archived, and a new event session (" + eventSessionId + ") has been started", ':speaking_head:', []);
    })

    socket.on('cancel all waiting jobs', function (data) {
        VGSLog(0, "Cancel all waiting jobs");

        for (index = 0, len = jobRecords.length; index < len; index++) {
            if (jobRecords[index].status === jobStatusEnum.WAITING) {
                CancelWaitingJob(index);
            }
        }

        SendBasicStatusToClients(true);
        SendJobStatusesToClients(true);
        SendBatchStatusesToClients(true);
    })

    socket.on('cancel waiting job', function (data) {
        VGSLog(0, "Cancel Waiting Job request...");
        var jobIdNum = parseInt(data['jobIdToCancel']);

        // Find the specified job
        for (index = 0, len = jobRecords.length; index < len; index++) {
            if (jobRecords[index].id === jobIdNum) {
                if (jobRecords[index].status != jobStatusEnum.WAITING) {
                    VGSLog(0, "ERROR:  Cancel requested for a job that is not waiting");
                } else {
                    CancelWaitingJob(index);
                }
                break;
            }
        }

        SendBasicStatusToClients(true);
        SendJobStatusesToClients(true);
        SendBatchStatusesToClients(true);
    })

    socket.on('update worker load', function (data) {
        //VGSLog(4, "'update worker load' request received from client " + clientId);
        socket.emit('worker load info');    // This message simply re-starts the periodic timer on the individual client

        SendWorkerStatusesToClient(ClientIndexFromId(clientId));
    });

    socket.on('delete all completed jobs', function (data) {
        VGSLog(0, "Delete All Completed Jobs request...");

        for (var index = 0; index < jobRecords.length;) {
            if (!DeleteJobRecordIfAppropriate(index)) {
                index++;
            }
        }

        SendBasicStatusToClients(true);
        SendJobStatusesToClients(true);
    })

    socket.on('delete job', function (data) {
        var jobIdNum = parseInt(data['jobIdToDelete']);
        VGSLog(0, "Delete Job request for job ID " + jobIdNum);

        // Find the specified job
        var index = 0;
        for (len = jobRecords.length; index < len; index++) {
            if (jobRecords[index].id === jobIdNum) {
                DeleteJobRecordIfAppropriate(index);
                break;
            }
        }

        // Also delete the job from any clients' 'tracked jobs' list
        for (var i = 0, len = clients.length; i < len; i++) {
            var j = IndexFromTrackedJobMatch(i, jobIdNum);
            if (j >= 0) {
                clients[i].trackedJobs.splice(j, 1);
            }
        }

        SendBasicStatusToClients(true);
        SendJobStatusesToClients(true);
    })

    socket.on('rerun job', function (data) {
        var jobIdNum = parseInt(data['jobIdToReRun']);
        VGSLog(0, "Re-Run Job request for job ID " + jobIdNum);

        // Find the specified job
        var index = 0;
        for (len = jobRecords.length; index < len; index++) {
            if (jobRecords[index].id === jobIdNum) {
                break;
            }
        }

        var job = jobRecords[index];
        switch (job.status) {
            case jobStatusEnum.COMPLETED_FAIL:
                numFailedJobs--;
                break;
            case jobStatusEnum.KILLED:
                numKilledJobs--;
                break;
            case jobStatusEnum.CANCELLED:
                numCancelledJobs--;
                break;
        }

        // Put the job back onto the waiting queue
        job.status = jobStatusEnum.WAITING;
        job.errorCode = 0;
        job.startTime = "";
        job.completionTime = "";
        job.duration = -1;
        job.videoFilename = job.origVideoFilename.slice(0);
        job.gpuIndex = -1;
        job.worker = -1;
        job.progress = 0;
        job.progressText = "";

        numWaitingJobs++;

        console.log('videoFilename = ' + job.videoFilename);

        if (job.batchId >= 0) {
            var batchIndex = BatchIndexFromId(job.batchId);
            if (batchIndex < 0) {
                VGSLog(0, "ERROR:  Batch id associated with a job was not found; this should not happen");
            } else {
                batchRecords[batchIndex].numJobsComplete--;
                var pct = batchRecords[batchIndex].numJobsComplete * 100 / batchRecords[batchIndex].numJobsTotal;
                batchRecords[batchIndex].progress = pct;
                saveDirty = true;
            }
        }

        AttemptJobStarts();

        SendBasicStatusToClients(true);
        SendJobStatusesToClients(true);
        SendBatchStatusesToClients(true);
    })

    socket.on('toggle job track', function (data) {
        var jobIdNum = parseInt(data['jobId']);
        var newOn = data['on'];
        VGSLog(1, "Client requested to toggle tracking " + (newOn ? "ON" : "OFF") + " for job " + jobIdNum);
        var clientIndex = ClientIndexFromId(clientId);
        if (newOn) {
            clients[clientIndex].trackedJobs.push(jobIdNum);
        } else {
            var i = IndexFromTrackedJobMatch(clientIndex, jobIdNum);
            if (i >= 0) {
                clients[clientIndex].trackedJobs.splice(i, 1);
            } else {
                console.log("ERROR: Client requested to toggle job off but it was not in the client's list");
            }
        }
        SendJobStatusPageToClient(clientIndex);
    })

    socket.on('change job priority', function (data) {
        var jobIdNum = parseInt(data['jobId']);
        var delta = parseInt(data['delta']);
        VGSLog(1, "Client requested to change priority for job " + jobIdNum + " (delta = " + delta + ")");

        var index = JobIndexFromId(jobIdNum);
        if (index >= 0) {
            jobRecords[index].priority += delta;
            if (jobRecords[index].priority < priorityMin) {
                jobRecords[index].priority = priorityMin;
            } else if (jobRecords[index].priority > priorityMax) {
                jobRecords[index].priority = priorityMax;
            }
            // Send response quickly to the client that's making the request; but less urgently to the other clients:
            var clientIndex = ClientIndexFromId(clientId);
            SendJobStatusPageToClient(clientIndex);
            SendJobStatusesToClients(false);
        }
    })

    socket.on('kill active job', function (data) {
        var jobIdNum = parseInt(data['jobIdToKill']);
        VGSLog(0, "Request from client to kill job id=" + jobIdNum);

        // Find the specified job
        for (index = 0, len = jobRecords.length; index < len; index++) {
            if (jobRecords[index].id === jobIdNum) {
                if (jobRecords[index].status != jobStatusEnum.ACTIVE) {
                    VGSLog(0, "ERROR:  Kill requested for a job that is not active");
                } else {
                    KillJob(index);
                }
                break;
            }
        }

        SendWorkerStatusesToClients(true);
        SendBasicStatusToClients(true);
        SendJobStatusesToClients(true);
        SendBatchStatusesToClients(true);
    })

    socket.on('next page', function(data) {
        var index = ClientIndexFromId(clientId);
        clients[index].curPage++;
        SendJobStatusPageToClient(index);
    })

    socket.on('prev page', function (data) {
        var index = ClientIndexFromId(clientId);
        if (clients[index].curPage > 0) {
            clients[index].curPage--;
            SendJobStatusPageToClient(index);
        }
    })

    socket.on('first page', function (data) {
        var index = ClientIndexFromId(clientId);
        clients[index].curPage = 0;
        SendJobStatusPageToClient(index);
    })

    socket.on('last page', function (data) {
        var index = ClientIndexFromId(clientId);
        clients[index].curPage = 999999;  // This will get adjusted in the function below
        SendJobStatusPageToClient(index);
    })

    socket.on('jump to page', function (data) {
        var index = ClientIndexFromId(clientId);
        var newPage = data['pageKey'];
        //VGSLog(1, "received request to jump to page " + newPage);
        if (newPage < 0)
            newPage = 0;
        clients[index].curPage = newPage;
        SendJobStatusPageToClient(index);
    })

    socket.on('reset filter', function (data) {
        var index = ClientIndexFromId(clientId);
        clients[index].jobStatusFilter = -1;
        SendJobStatusPageToClient(index);
    })

    socket.on('toggle filter', function (data) {
        var index = ClientIndexFromId(clientId);
        var filterIndexToToggle = data['whichFilterKey'];
        var jsf = clients[index].jobStatusFilter;
        if (jsf === -1) {
            jsf = 0;
        }
        jsf ^= (1 << filterIndexToToggle);
        if (jsf === 0) {
            jsf = -1;
        }
        clients[index].jobStatusFilter = jsf;
        SendJobStatusPageToClient(index);
    })

    socket.on('sort column', function(data) {
        var index = ClientIndexFromId(clientId);
        var sortField = data['sortFieldKey'];
        if (sortField === clients[index].jobSortField) {
            clients[index].jobSortAscending = !clients[index].jobSortAscending;
        } else {
            clients[index].jobSortField = sortField;
            clients[index].jobSortAscending = true;
        }
        SendJobStatusPageToClient(index);
    })

    socket.on('set items per page', function (data) {
        var index = ClientIndexFromId(clientId);
        clients[index].itemsPerPage = data["newItemsPerPage"];
        VGSLog(1, "new items per page (jobs table) is " + data["newItemsPerPage"]);
        SendJobStatusPageToClient(index);
    })

    socket.on('next page batch', function (data) {
        var index = ClientIndexFromId(clientId);
        clients[index].curPageBatch++;
        SendBatchStatusPageToClient(index);
    })

    socket.on('prev page batch', function (data) {
        var index = ClientIndexFromId(clientId);
        if (clients[index].curPageBatch > 0) {
            clients[index].curPageBatch--;
            SendBatchStatusPageToClient(index);
        }
    })

    socket.on('first page batch', function (data) {
        var index = ClientIndexFromId(clientId);
        clients[index].curPageBatch = 0;
        SendBatchStatusPageToClient(index);
    })

    socket.on('last page batch', function (data) {
        var index = ClientIndexFromId(clientId);
        clients[index].curPageBatch = 999999;  // This will get adjusted in the function below
        SendBatchStatusPageToClient(index);
    })

    socket.on('jump to page batch', function (data) {
        var index = ClientIndexFromId(clientId);
        var newPage = data['pageKey'];
        //VGSLog(1, "received request to jump to page " + newPage);
        if (newPage < 0)
            newPage = 0;
        clients[index].curPageBatch = newPage;
        SendBatchStatusPageToClient(index);
    })

    socket.on('reset filter batch', function (data) {
        var index = ClientIndexFromId(clientId);
        clients[index].batchStatusFilter = -1;
        SendBatchStatusPageToClient(index);
    })

    socket.on('toggle filter batch', function (data) {
        var index = ClientIndexFromId(clientId);
        var filterIndexToToggle = data['whichFilterKey'];
        var jsf = clients[index].batchStatusFilter;
        if (jsf === -1) {
            jsf = 0;
        }
        jsf ^= (1 << filterIndexToToggle);
        if (jsf === 0) {
            jsf = -1;
        }
        clients[index].batchStatusFilter = jsf;
        SendBatchStatusPageToClient(index);
    })

    socket.on('sort column batch', function (data) {
        var index = ClientIndexFromId(clientId);
        var sortField = data['sortFieldKey'];
        if (sortField === clients[index].batchSortField) {
            clients[index].batchSortAscending = !clients[index].batchSortAscending;
        } else {
            clients[index].batchSortField = sortField;
            clients[index].batchSortAscending = true;
        }
        SendBatchStatusPageToClient(index);
    })

    socket.on('set items per page batch', function (data) {
        var index = ClientIndexFromId(clientId);
        clients[index].itemsPerPageBatch = data["newItemsPerPage"];
        VGSLog(1, "new items per page (batch table) is " + data["newItemsPerPage"]);
        SendBatchStatusPageToClient(index);
    })

    socket.on('set global setting', function (data) {
        var varToSet = data['gsVarKey'];
        var newSetting = data['gsValueKey'];
        gs[varToSet] = newSetting;
        saveDirty = true;

        if (varToSet === 'AutoRoundBatch') {
            clearTimeout(AutoRoundBatchCheckTimeout);
            if (newSetting === 'On') {
                AutoRoundBatchCheckTimeout = setTimeout(PeriodicAutoRoundBatchCheck, 100);
            }
        }

        if (varToSet === 'AutoSaveFrequencyMs') {
            clearTimeout(AutoSaveTimeout);
            if (newSetting !== 0) {
                AutoSaveTimeout = setTimeout(PeriodicAutoSave, newSetting);
            }
        }

        if (varToSet === 'AutoRoundCheckFrequency') {
        }

        SendGlobalSettingsToClients();
    })

    socket.on('reset to current esid', function(data) {
        var index = ClientIndexFromId(clientId);
        clients[index].eventSessionIdViewed = eventSessionId;
    })

    socket.on('set new esid', function (data) {
        var esid = data['esid'];
        var index = ClientIndexFromId(clientId);
        clients[index].eventSessionIdViewed = esid;
    })

    socket.on('set showing worker table', function (data) {
        var index = ClientIndexFromId(clientId);
        clients[index].showingWorkerTable = data['showingKey'];
    })

    socket.on('set showing worker table special', function (data) {
        var index = ClientIndexFromId(clientId);
        clients[index].showingWorkerTableSpecial = data['showingKey'];
    })

    socket.on('set showing job table', function (data) {
        var index = ClientIndexFromId(clientId);
        clients[index].showingJobTable = data['showingKey'];
    })

    socket.on('set showing batch table', function (data) {
        var index = ClientIndexFromId(clientId);
        clients[index].showingBatchTable = data['showingKey'];
    })

    socket.on('rename', function (data) {
        data.jobIdNum = parseInt(data['jobId']);
        var newName = data['newName'];

        VGSLog(0, "Request from client to rename job=" + data.jobIdNum + " from " + data['oldName'] + " to " + newName);

        // Find worker who's hosting that file.
        for (index = 0, len = jobRecords.length; index < len; index++) {
            if (jobRecords[index].id === data.jobIdNum) {
                if(jobRecords[index].workerIp != "") {
                    workerSocket = workers[jobRecords[index].workerIp].ioc;
                    if(workerSocket.connected) {
                        data.eventSessionId = eventSessionId;
                        data['oldName'] = data['oldName'].slice(0, data['oldName'].lastIndexOf('.'));
                        if(data['newName'].lastIndexOf('.') > -1)
                            data['newName'] = data['newName'].slice(0, data['newName'].lastIndexOf('.'));
                        workerSocket.emit('rename', data);
                        jobRecords[index].videoFilename = data['newName'] + '.mp4';
                    }
                } else {
                    VGSLog(0, "ERROR:  Rename requested, but couldn't find owning worker.");
                }
                break;
            }
        }

        // Update everyone's pages; no need to rush.
        // Will correct sending client if it fails, correct everyone else if it succeeds.
        SendJobStatusesToClients(false);
    })

    socket.on('upload special', function(data) {
        VGSLog(1, 'New Special Haxxis Package - ' + data.name);

        if(!fs.existsSync(__dirname + '/Public/SpecialPackages/'))
            fs.mkdirSync(__dirname + '/Public/SpecialPackages');

        fs.writeFile(__dirname + "/Public/SpecialPackages/" + data.name, data.file, function (err) {
            if(err) VGSLog(0, 'ERROR: New Special Haxxis Package failed save: ' + err.message);
            else VGSLog(1, 'Saved ' + data.name);
        })
    })

    socket.on('purge special', function(data) {
        VGSLog(0, 'Asked to purge Special Haxxis Package from workers');

        for(var i in workers) {
            if(workers[i].connected)
                workers[i].ioc.emit('purge special');
        }
    })

    socket.on('delete special', function(data) {
        data.name = data.name.slice(9);
        VGSLog(1, 'Delete Special Haxxis Package - ' + data.name);

        fs.unlink(__dirname + "/Public/SpecialPackages/" + data.name, function (err) {
            if(err) VGSLog(0, 'ERROR: Delete Special Haxxis Package failed: ' + err.message);
            else VGSLog(1, 'Deleted ' + data.name);
        })
    })

    // Disconnect
    socket.on('disconnect', function () {
        console.log('Disconnection from client ID ' + clientId + ' detected');
        clientIdDisconnecting = clientId;
        clientDisconnectTimeout = setTimeout(FormalDisconnect, 250);  // This is a hacky way to allow browser refresh to occur and preserve the client's tracked jobs
    })

    function FormalDisconnect() {
        var index = ClientIndexFromId(clientId);
        clients.splice(index, 1);   // Unregister the client by removing it from the list of clients
        clientIdDisconnecting = -1;
        VGSLog(1, "Client " + clientId + " has disconnected from the master server");   // We log this >after< removing the client, so we're not trying to send to a disconnected client
        SendGlobalSettingsToClients();  // (There might be an issue here still with the 'go to sleep with 2 active clients' bug...unless socket-io handles it...
    }
})

function SendGlobalSettingsToClients() {
    // Send to ALL clients
    io.sockets.emit('update global settings', {
        eventSessionIdKey: eventSessionId,
        saveDirtyKey: saveDirty,
        traceApiUrlKey: gs.TraceApiUrl,
        screenResKey: gs.ScreenRes,
        fullScreenKey: gs.FullScreen,
        codecNameKey: gs.CodecName,
        extraParametersKey: gs.ExtraParameters,
        realTimeKey: gs.RealTime,
        frameRateKey: gs.FrameRate,
        downScaleKey: gs.DownScale,
        currentRoundKey: gs.CurrentRound,
        previousRoundKey: gs.PreviousRound,
        autoRoundBatchKey: gs.AutoRoundBatch,
        autoRoundCheckFrequency: gs.AutoRoundCheckFrequency,
        autoSaveFrequencyMsKey: gs.AutoSaveFrequencyMs,
        masterHasShutDownKey: masterHasShutDown,
        numClientsKey: clients.length
    });
}

function SendWorkerStatusesToClient(clientIndex) {
    if (clients[clientIndex].showingWorkerTable === false && clients[clientIndex].showingWorkerTableSpecial === false)
        return;

    var client = clients[clientIndex];
    client.workerTableSendCount++;
    var workerDataToSend = [];
    for (var workerip in workers) {
        var worker = workers[workerip];
        var workerData = {
            ip: worker.ip,
            friendlyName: worker.friendlyName,
            maxJobsRegular: worker.maxJobsRegular,
            maxJobsSpecial: worker.maxJobsSpecial,
            paused: worker.paused,
            hardPaused: worker.hardPaused,
            numActiveJobs: worker.numActiveJobs,
            numActiveJobsRegular: worker.numActiveJobsRegular,
            numActiveJobsSpecial: worker.numActiveJobsSpecial,
            numAvailSlotsRegular: worker.numAvailSlotsRegular,
            numAvailSlotsSpecial: worker.numAvailSlotsSpecial,
            jobLoadPctRegular: worker.jobLoadPctRegular,
            jobLoadPctSpecial: worker.jobLoadPctSpecial,
            loadCPU: worker.loadCPU,
            loadCPUArray: worker.loadCPUArray,
            loadMem: worker.loadMem,
            loadGPU: worker.loadGPU,
            loadGPUArray: worker.loadGPUArray,
            numGPUs: worker.numGPUs,
            disk1DriveLetter: worker.disk1DriveLetter,
            disk1SpaceUsed: worker.disk1SpaceUsed,
            disk1SpaceTotal: worker.disk1SpaceTotal,
            disk2DriveLetter: worker.disk2DriveLetter,
            disk2SpaceUsed: worker.disk2SpaceUsed,
            disk2SpaceTotal: worker.disk2SpaceTotal,
            connected: worker.connected,
            buildVersion: worker.buildVersion,
            pendingGetBuildRequest: worker.pendingGetBuildRequest,
            packagesVersion: worker.packagesVersion,
            pendingGetPackagesRequest: worker.pendingGetPackagesRequest,
            pendingRestartRequest: worker.pendingRestartRequest,
            pendingShutdownRequest: worker.pendingShutdownRequest
        };
        workerDataToSend.push(workerData);
    }
    client.socket.emit('update workers', { dataKey: workerDataToSend, latestBuildVersionKey: latestBuildVersion, latestPackagesVersionKey: latestPackagesVersion, sendCountKey: client.workerTableSendCount });
}

function SendWorkerStatusesToClients(forceSend) {
    for (var i = 0, len = clients.length; i < len; i++) {
        if (forceSend) {
            SendWorkerStatusesToClient(i);
        } else {
            clients[i].workerTableSendDirty = true;
        }
    }
}

function SendBasicStatusToClient(clientIndex) {
    var client = clients[clientIndex];
    client.basicStatusSendCount++;
    client.socket.emit('update basic status', {
        numJobRecordsTotalKey: jobRecords.length,
        maxRequestedJobsKey: maxRequestedJobs,
        numWaitingJobsKey: numWaitingJobs,
        numActiveJobsTotalKey: numActiveJobsTotal,
        numSuccessfullyCompletedJobsKey: numSuccessfullyCompletedJobs,
        numFailedJobsKey: numFailedJobs,
        numCancelledJobsKey: numCancelledJobs,
        numKilledJobsKey: numKilledJobs,
        saveDirtyKey: saveDirty,
        sendCountKey: client.basicStatusSendCount,
        adminLevel: client.adminLevel
    })
}

function SendBasicStatusToClients(forceSend) {
    for (var i = 0, len = clients.length; i < len; i++) {
        if (forceSend) {
            SendBasicStatusToClient(i);
        } else {
            clients[i].basicStatusSendDirty = true;
        }
    }
}

var sort_by = function (field, reverse, primer) {
    var key = function (x) { return primer ? primer(x[field]) : x[field] };

    return function (a, b) {
        var A = key(jobRecords[a]), B = key(jobRecords[b]);
        return ((A < B) ? -1 : ((A > B) ? 1 : 0)) * [-1, 1][+!!reverse];
    }
}

function AddJobRecordToData(jobIndex, inTrackingSection, isTracked) {
    var jobRecord = jobRecords[jobIndex];
    var workerIp = "Undecided";
    if (jobRecord.workerIp) {
        workerIp = jobRecord.workerIp;
    }
    var outputData = {
        id: jobRecord.id,
        status: jobRecord.status,
        HPName: jobRecord.HPName,
        parameters: jobRecord.parameters,
        errorCode: jobRecord.errorCode,
        videoFilename: jobRecord.videoFilename,
        completionTime: jobRecord.completionTime,
        duration: jobRecord.duration,
        worker: jobRecord.worker,
        priority: jobRecord.priority,
        gpuIndex: jobRecord.gpuIndex,
        progress: jobRecord.progress,
        progressText: jobRecord.progressText,
        batchId: jobRecord.batchId,
        workerIp: workerIp,
        inTrackingSection: inTrackingSection,
        isTracked: isTracked,
        frameCount: jobRecord.frameCount,
        videoDuration: jobRecord.videoDuration
    }
    return outputData;
}

function SendJobStatusPageToClient(clientIndex) {
    if (clients[clientIndex].showingJobTable === false)
        return;

    //var start = new Date().getTime();

    // Create a filtered list of jobs from the master list
    var jobs = [];
    var jobStatusFilter = clients[clientIndex].jobStatusFilter;
    if (jobStatusFilter === -1) {
        for (var i = 0, len = jobRecords.length; i < len; i++) {
            jobs.push(i);
        }
    } else {
        for (var i = 0, len = jobRecords.length; i < len; i++) {
            if (jobStatusFilter & (1 << jobRecords[i].status)) {
                jobs.push(i);
            }
        }
    }

    var jobsDataToSend = [];
    var itemsPerPage = clients[clientIndex].itemsPerPage;
    if (jobs.length > 0) {
        // Sort the list
        var sortField = clients[clientIndex].jobSortField;
        var ascending = clients[clientIndex].jobSortAscending;
        var firstItem = jobRecords[jobs[0]];
        var doNumericSort = (!isNaN(firstItem[sortField]));  // (Maybe not the best way...check the type of the first item in the list to be sorted)
        if (sortField == 'parameters') {    // To get this field to work (should be text, not numeric).  I think it's because by default it's "%20"
            doNumericSort = false;
        }
        if (doNumericSort) {
            jobs.sort(sort_by(sortField, ascending, parseFloat));
        } else {
            jobs.sort(sort_by(sortField, ascending)); // Can give third option:  'parseInt', or function (a) { return a.toUpperCase() }
        }

        var numPages = Math.floor((jobs.length - 1) / itemsPerPage) + 1;
        // Adjust current page down if it's now out of range
        if (clients[clientIndex].curPage >= numPages)
            clients[clientIndex].curPage = numPages - 1;

        // >Insert< the 'tracked' jobs this client is following.  Note that this does not affect page size of the non-tracked jobs
        for (var i = 0, len = clients[clientIndex].trackedJobs.length; i < len; i++) {
            //console.log("In code to collect tracked jobs: i=" + i + "; len=" + len + "; clients[clientIndex].trackedJobs[i]=" + clients[clientIndex].trackedJobs[i]);
            jobsDataToSend.push(AddJobRecordToData(JobIndexFromId(clients[clientIndex].trackedJobs[i]), true, true));
        }

        // Now package up the jobs data for the page
        var endIndex = (clients[clientIndex].curPage + 1) * itemsPerPage;
        if (endIndex > jobs.length)
            endIndex = jobs.length;
        for (var j = (clients[clientIndex].curPage * clients[clientIndex].itemsPerPage); j < endIndex; j++) {
            jobsDataToSend.push(AddJobRecordToData(jobs[j], false, (IndexFromTrackedJobMatch(clientIndex, jobRecords[jobs[j]].id) >= 0)));
        }
    } else {
        clients[clientIndex].curPage = 0;
    }

    var client = clients[clientIndex];
    client.jobTableSendCount++;
    client.socket.emit('update jobs', {
        curPageKey: client.curPage, itemsPerPageKey: client.itemsPerPage, totalJobsKey: jobRecords.length, totalFilteredItemsKey: jobs.length,
        jobStatusFilterKey: client.jobStatusFilter, sortFieldKey: sortField, ascendingKey: ascending, jobsDataKey: jobsDataToSend, sendCountKey: client.jobTableSendCount
    });

    //var end = new Date().getTime();
    //var time = end - start;
    //console.log('Execution time for filter/sort/send: ' + time + " ms");
}

function SendJobStatusesToClients(forceSend) {
    // Send to ALL clients

    for (var i = 0, len = clients.length; i < len; i++) {
        if (forceSend) {
            SendJobStatusPageToClient(i);
        } else {
            clients[i].jobTableSendDirty = true;
        }
    }
}

var batchRecords_sort_by = function (field, reverse, primer) {
    var key = function (x) { return primer ? primer(x[field]) : x[field] };

    return function (a, b) {
        var A = key(batchRecords[a]), B = key(batchRecords[b]);
        return ((A < B) ? -1 : ((A > B) ? 1 : 0)) * [-1, 1][+!!reverse];
    }
}

function SendBatchStatusPageToClient(clientIndex) {
    if (clients[clientIndex].showingBatchTable === false)
        return;

    //var start = new Date().getTime();

    // Create a filtered list of batches from the master list
    var batches = [];
    var batchStatusFilter = clients[clientIndex].batchStatusFilter;
    if (batchStatusFilter === -1) {
        for (var i = 0, len = batchRecords.length; i < len; i++) {
            batches.push(i);
        }
    } else {
        for (var i = 0, len = batchRecords.length; i < len; i++) {
            if (batchStatusFilter & (1 << batchRecords[i].status)) {
                batches.push(i);
            }
        }
    }

    var data = [];
    if (batches.length > 0) {
        // Sort the list
        var sortField = clients[clientIndex].batchSortField;
        var ascending = clients[clientIndex].batchSortAscending;
        var firstItem = batchRecords[batches[0]];
        var doNumericSort = (!isNaN(firstItem[sortField]));  // (Maybe not the best way...check the type of the first item in the list to be sorted)
        if (sortField == 'parameters') {    // To get this field to work (should be text, not numeric).  I think it's because by default it's "%20"
            doNumericSort = false;
        }
        if (doNumericSort) {
            batches.sort(batchRecords_sort_by(sortField, ascending, parseFloat));
        } else {
            batches.sort(batchRecords_sort_by(sortField, ascending)); // Can give third option:  'parseInt', or function (a) { return a.toUpperCase() }
        }

        var itemsPerPageBatch = clients[clientIndex].itemsPerPageBatch;
        var numPages = Math.floor((batches.length - 1) / itemsPerPageBatch) + 1;
        // Adjust current page down if it's now out of range
        if (clients[clientIndex].curPageBatch >= numPages)
            clients[clientIndex].curPageBatch = numPages - 1;

        // Now package up the batches data for the page and send it
        var endIndex = (clients[clientIndex].curPageBatch + 1) * itemsPerPageBatch;
        if (endIndex > batches.length)
            endIndex = batches.length;
        for (var j = (clients[clientIndex].curPageBatch * clients[clientIndex].itemsPerPageBatch); j < endIndex; j++) {
            var batchRecord = batchRecords[batches[j]];
            var d = {
                id: batchRecord.id,
                status: batchRecord.status,
                manifestName: batchRecord.manifestName,
                parameters: batchRecord.parameters,
                numJobsTotal: batchRecord.numJobsTotal,
                numJobsComplete: batchRecord.numJobsComplete,
                errorCode: batchRecord.errorCode,
                completionTime: batchRecord.completionTime,
                duration: batchRecord.duration,
                priority: batchRecord.priority,
                progress: batchRecord.progress,
                progressText: batchRecord.progressText
            };
            data.push(d);
        }
    } else {
        clients[clientIndex].curPageBatch = 0;
    }

    var client = clients[clientIndex];
    client.batchTableSendCount++;
    client.socket.emit('update batches', {
        curPageKey: client.curPageBatch, itemsPerPageKey: client.itemsPerPageBatch, totalBatchesKey: batchRecords.length, totalFilteredItemsKey: batches.length,
        batchStatusFilterKey: client.batchStatusFilter, sortFieldKey: sortField, ascendingKey: ascending, dataKey: data, sendCountKey: client.batchTableSendCount
    });

    //var end = new Date().getTime();
    //var time = end - start;
    //console.log('Execution time for SendBatchStatusPageToClient: ' + time + " ms");
}

function SendBatchStatusesToClients(forceSend) {
    // Send to ALL clients

    for (var i = 0, len = clients.length; i < len; i++) {
        if (forceSend) {
            SendBatchStatusPageToClient(i);
        } else {
            clients[i].batchTableSendDirty = true;
        }
    }
}

function nowTime() {
    var dt = String(new Date());
    // Strip out day of week, year, and the time zone
    return dt.substring(4, 11) + dt.substring(16, 24);
}

// This finds command line arguments in the form -keyword=value and returns value (or empty string if not found)
function GetParameterArgumentValue(keyword, parameters) {
    var value = "";
    //console.log("GetParameterArgumentValue(" + keyword + ', ' + parameters);

    // Search the parameters string, looking for a keyword in the form -keyword=
    parameters = parameters.toLowerCase();
    keyword = keyword.toLowerCase();
    //console.log("GetParameterArgumentValue for keyword " + keyword + " and parameters " + parameters);
    var startIndex = 0;
    while (true) {
        //console.log("LOOP START:  Remaining string is " + parameters.substring(startIndex));
        var hyphenIndex = parameters.indexOf('-', startIndex);
        if (hyphenIndex < 0)
            break;

        var equalsIndex = parameters.indexOf('=', startIndex);
        if (equalsIndex < 0)
            break;

        var spaceIndex = parameters.indexOf(' ', startIndex);
        //console.log("Hyphen:" + hyphenIndex + " Equals:" + equalsIndex + " Space:" + spaceIndex);

        if (spaceIndex > hyphenIndex && spaceIndex < equalsIndex) {
            startIndex = hyphenIndex + 1;
            continue; // Ignore if there is a space before the equals, because we've hit something like "-isBlah -monkeyValue=56"
        }

        //console.log("testing against: " + parameters.substring(hyphenIndex + 1, equalsIndex));
        if (parameters.substring(hyphenIndex + 1, equalsIndex) === keyword) {
            // We've found the keyword; now pull out the value (from right after the equals sign, to the next space, or end of string)
            var newSpaceIndex = parameters.indexOf(' ', equalsIndex);
            value = parameters.substring(equalsIndex + 1, newSpaceIndex < 0 ? parameters.length : newSpaceIndex);
            break;
        }

        if (spaceIndex < 0)
            break;
        startIndex = spaceIndex + 1;
    }
    return value;
}

function ResolveVideoFilename(jobId, formatString, parameters, autoRoundNum) {
    while (true) {
        //console.log("FORMATSTRING: " + formatString);
        var openDelimIndex = formatString.indexOf('(');
        if (openDelimIndex < 0)
            break;

        var closeDelimIndex = formatString.indexOf(')');
        if (closeDelimIndex < 0) {
            VGSLog(1, "WARNING: In VGS job video filename format string, found opening delimiter but no matching closing delimiter, in " + formatString + "; going with what we have...");
            break;
        }

        var keyword = formatString.substring(openDelimIndex + 1, closeDelimIndex);
        var value = GetParameterArgumentValue(keyword, parameters);
        if (value === "") {
            VGSLog(1, "WARNING: In resolving VGS job video filename format string, did not find command line argument for keyword " + keyword + "; continuing...");
            value = "UNRESOLVED";
        }
        // Replace the keyword (including delimiters) with the value found
        var firstPortion = formatString.substring(0, openDelimIndex);
        var lastPortion = formatString.substring(closeDelimIndex + 1, formatString.length);
        formatString = firstPortion + value + lastPortion;
    }

    var encodedRoundString = "";
    if (autoRoundNum >= 0) {
        encodedRoundString = 'R' + (autoRoundNum < 10 ? "0" : "") + autoRoundNum + '_';
    }

    var baseVideoFilename = encodedRoundString + formatString + '.mp4';

    // Search the jobs database for an exact match of the base video filename, and WARN if there is
    // (The job ID prefix in the filename will serve to make the video filename unique)
    for (var i = 0, len = jobRecords.length; i < len; i++) {
        var jobVideoFilename = jobRecords[i].videoFilename;
        var baseIndex = jobVideoFilename.indexOf('_', 3); // (Slightly hacky way of getting the base videofilename from the final filename)
        var jobBaseVideoFilename = jobVideoFilename.substring(baseIndex + 1, jobVideoFilename.length);
        if (jobBaseVideoFilename === baseVideoFilename) {
            VGSLog(2, 'WARNING: Duplicate BASE video filename \"' + baseVideoFilename + '\"; however, video filename will still be distinguished by job ID in the prefix');
            break;
        }
    }

    videoFilename = /*'V_' +*/ jobId + '_' + baseVideoFilename;

    return videoFilename;
}


// This is still an http request, because it is also called from the batch gen bash script, not just the VGS client
app.get('/StartVideoGen/:HPName/:Priority/:BatchId/:AutoRoundNum/:VideoFilenameFormatString/:Parameters', function (request, response) {

    if (masterHasShutDown) {
        response.send('false');
        return;
    }

    if (numWaitingJobs >= maxRequestedJobs) {
        VGSLog(0, "Too many jobs requested; ignoring this request");
        response.send('false');
        return;
    }

    var HPName = DecodeSlashes(request.params.HPName);
    var priority = parseInt(request.params.Priority);
    var batchId = parseInt(request.params.BatchId);
    var autoRoundNum = parseInt(request.params.AutoRoundNum);
    var VideoFilenameFormatString = request.params.VideoFilenameFormatString;
    var Parameters = request.params.Parameters;

    VGSLog(1, "Requested processing for " + HPName + "; batch ID:" + request.params.BatchId + "; parameters:" + Parameters);

    if (batchId >= 0) {
        var index = BatchIndexFromId(batchId);
        if (index < 0) {
            VGSLog(0, "ERROR:  Batch id associated with a job was not found; this should not happen");
        } else {
            batchRecords[index].numJobsTotal++;
            batchRecords[index].progressText = "";
            saveDirty = true;
            SendBatchStatusesToClients(false);
        }
    }

    nextJobId++;
    var jobId = nextJobId;

    // If a video filename format string was provided, "resolve" it with this job's parameters
    var videoFilename = "DEFAULT";
    if (VideoFilenameFormatString != "DEFAULT") {
        videoFilename = ResolveVideoFilename(jobId, VideoFilenameFormatString, Parameters, autoRoundNum);
    }

    var job = {
        HPName: HPName,
        parameters: Parameters,
        id: jobId,
        status: jobStatusEnum.WAITING,
        errorCode: 0,
        startTime: "",
        completionTime: "",
        duration: -1,
        videoFilename: videoFilename,
        origVideoFilename: videoFilename.slice(0),  // Make a copy of the video filename string
        gpuIndex: -1,
        workerIp: "",
        priority: priority,
        progress: 0,
        progressText: "",
        batchId: batchId,
        frameCount: 0,
        videoDuration: 0.0
    };
    jobRecords.push(job);
    saveDirty = true;
    numWaitingJobs++;

    response.send('true' + ',' + jobId);

    if (!AttemptJobStarts()) {
        SendWorkerStatusesToClients(false);
        SendBasicStatusToClients(false);
        SendJobStatusesToClients(false);
    }
});

function endsWith(str, suffix) {
    return str.toLowerCase().indexOf(suffix, str.length - suffix.length) !== -1;
}

function startsWith(str, prefix) {
    return str.toLowerCase().indexOf(prefix.toLowerCase()) === 0;
}

var slashTokenString = "_^_";

function DecodeSlashes(str) {
    while (str.indexOf(slashTokenString) >= 0) {
        str = str.replace(slashTokenString, "\\");
    }
    return str;
}


app.get('/StartBatchGen/:ManifestName/:BatchId/:AutoRoundNum/:Parameters', function (request, response) {
    response.send();

    if (masterHasShutDown)
        return;

    var autoRoundNum = parseInt(request.params.AutoRoundNum);
    var manifestName = DecodeSlashes(request.params.ManifestName);
    var parameters = request.params.Parameters;

    var newBatch = false;
    var batchId = parseInt(request.params.BatchId);   // When a batch manifest calls another batch manifest, we want to share the same batch ID
    if (batchId < 0) {  // (-1 means 'assign a new batch id')
        batchId = ++nextBatchId;
        newBatch = true;
    }

    VGSLog(0, "Requested BATCH processing for " + manifestName + "; parameters:" + parameters);

    var manifestIsTextFile = true;
    if (!endsWith(manifestName, '.txt')) {
        VGSLog(0, "Batch file " + manifestName + " does not appear to be a text file");
        manifestIsTextFile = false;
    }

    if (newBatch) {
        var batch = {
            id: batchId,
            manifestName: manifestName,
            parameters: parameters,
            numJobsTotal: 0,    // This will be incremented as jobs get registered
            numJobsComplete: 0, // This will be incremented as jobs get completed or killed, etc.
            status: batchStatusEnum.WAITING,
            errorCode: 0,
            startTime: new Date(),
            completionTime: "",
            duration: -1,
            priority: -1,   // now defunct
            progress: 0,
            progressText: "Waiting",
            autoRoundNum: autoRoundNum  // The round number this batch is associated with if for the automatic per-round batch(es), or -1 if this batch is not related to automatic per-round batches
        };
        batchRecords.push(batch);
        saveDirty = true;
        SendBatchStatusesToClients(false);
    }

    if (manifestIsTextFile) {
        var childVideoGen = spawn('sh', ['DoBatchProcess.sh', manifestName, batchId, autoRoundNum, parameters], {});

        childVideoGen.stdout.on('data', function(data) {
            console.log("childBatchProcess: " + data);
        });

        childVideoGen.on('exit', function(exitCode) {
            if (exitCode === 2) {
                VGSLog(0, "Error:  Batch manifest \"" + manifestName + "\" was not found");
                BatchFailure(batchId, 9);
            } else {
                VGSLog(1, "Ending batch process for manifest: " + manifestName + "; exited with code: " + exitCode);
            }

            SendBasicStatusToClients(false);
        });
    } else {
        BatchFailure(batchId, 10);
    }
});

function BatchFailure(batchId, errorCode) {
    var index = BatchIndexFromId(batchId);
    batchRecords[index].status = batchStatusEnum.COMPLETED_FAIL;
    batchRecords[index].progress = 100;
    batchRecords[index].progressText = "";
    batchRecords[index].errorCode = errorCode;
    saveDirty = true;
    SendBatchStatusesToClients(false);
}

function GenerateWaitingJobsList(doSpecials) {
    var list = [];

    for (var i = 0, len = jobRecords.length; i < len; i++) {
        if (jobRecords[i].status === jobStatusEnum.WAITING) {
            if ((doSpecials === true  && jobRecords[i].priority >= specialPriorityThreshold) ||
                (doSpecials === false /*&& jobRecords[i].priority <  specialPriorityThreshold*/)) {
                list.push(i);
            }
        }
    }

    return list;
}

// remember this is just a list of job indexes, not the jobs themselves
function SortWaitingJobsList(jobsList) {
    jobsList.sort(function (a, b) {
        // Primary sort is by priority, in descending order
        if (jobRecords[a].priority < jobRecords[b].priority) {
            return 1;
        }
        if (jobRecords[a].priority > jobRecords[b].priority) {
            return -1;
        }
        // If priority equal, break tie with job ID (ascending), so FIFO
        if (jobRecords[a].id > jobRecords[b].id) {
            return 1;
        }
        if (jobRecords[a].id < jobRecords[b].id) {
            return -1;
        }
        return 0;
    });
    return jobsList;
}

function UpdateWorkerJobLoadRegular() {
    var bestWorker = null;
    var bestPct = 1;
    for (var w in workers) {
        var worker = workers[w];
        if (worker.connected && !worker.pendingRestartRequest && !worker.pendingShutdownRequest && !worker.paused) {
            worker.numAvailSlotsRegular = worker.maxJobsRegular - worker.numActiveJobsRegular;
            worker.jobLoadPctRegular = worker.maxJobsRegular > 0 ? worker.numActiveJobsRegular / worker.maxJobsRegular : 1;
            if (worker.jobLoadPctRegular < bestPct) {
                bestWorker = worker;
                bestPct = worker.jobLoadPctRegular;
            }
        }
    }
    return bestWorker;
}

function UpdateWorkerJobLoadSpecial() {
    var bestWorker = null;
    var bestPct = 1;
    for (var w in workers) {
        var worker = workers[w];
        if (worker.connected && !worker.pendingRestartRequest && !worker.pendingShutdownRequest && !worker.paused) {
            worker.numAvailSlotsSpecial = worker.maxJobsSpecial - worker.numActiveJobsSpecial;
            worker.jobLoadPctSpecial = worker.maxJobsSpecial > 0 ? worker.numActiveJobsSpecial / worker.maxJobsSpecial : 1;
            if (worker.jobLoadPctSpecial < bestPct) {
                bestWorker = worker;
                bestPct = worker.jobLoadPctSpecial;
            }
        }
    }
    return bestWorker;
}

function ChooseWorkerAndStartJob(jobIndex, isSpecial) {
    var bestWorker;
    if (isSpecial) {
        bestWorker = UpdateWorkerJobLoadSpecial();
    } else {
        bestWorker = UpdateWorkerJobLoadRegular();
    }

    if (bestWorker == null) {
        return false;
    } else {
        numWaitingJobs--;
        bestWorker.numActiveJobs++;
        if (isSpecial) {
            bestWorker.numActiveJobsSpecial++;
        } else {
            bestWorker.numActiveJobsRegular++;
        }
        StartVideoGenJob(jobRecords[jobIndex], bestWorker, isSpecial);
        return true;
    }
}

// Returns true if any jobs are started
function AttemptJobStarts() {
    if (numWaitingJobs === 0)
        return false;

    if (masterHasShutDown)
        return false;

    var numJobsStarted = 0;

    // "specials" (priority >= threshold) prefer 'special' slots, but if none available, can take 'regular' slots
    var specials = GenerateWaitingJobsList(true);
    if (specials.length > 0) {
        specials = SortWaitingJobsList(specials);

        for (var i = 0; i < specials.length; i++) {
            if (ChooseWorkerAndStartJob(specials[i], true)) {
                numJobsStarted++;
            } else {
                break;
            }
        }
    }

    // "regulars" (priority < threshold) can only take 'regular' slots
    var regulars = GenerateWaitingJobsList(false);
    if (regulars.length > 0) {
        regulars = SortWaitingJobsList(regulars);

        for (var i = 0; i < regulars.length; i++) {
            if (ChooseWorkerAndStartJob(regulars[i], false)) {
                numJobsStarted++;
            } else {
                break;
            }
        }
    }

    return (numJobsStarted > 0);
}


function StartVideoGenJob(job, worker, isSpecial) {
    job.status = jobStatusEnum.ACTIVE;
    job.startTime = new Date();
    job.workerIp = worker.ip;
    job.isSpecial = isSpecial;
    job.progressText = "Starting job";
    numActiveJobsTotal++;
    var HPName = job.HPName;
    var id = job.id;

    var msg = "Starting video generation job (id:" + id + ") for HP: " + HPName + "; on worker " + worker.friendlyName;
    VGSLog(1, msg);

    if (job.batchId >= 0) {
        var index = BatchIndexFromId(job.batchId);
        if (index < 0) {
            VGSLog(0, "ERROR:  Batch id associated with a job was not found; this should not happen");
        } else {
            batchRecords[index].status = batchStatusEnum.ACTIVE;
            saveDirty = true;
        }
    }

    // Potentially add parameters from global settings
    var extraParameters = "";
    if (gs.TraceApiUrl !== "")
        extraParameters += " -traceApiUrl=" + encodeURIComponent(gs.TraceApiUrl);
    if (gs.ScreenRes !== "")
        extraParameters += " -screenRes=" + gs.ScreenRes;
    if (gs.FullScreen !== "")
        extraParameters += " -fullScreen=" + gs.FullScreen;
    if (gs.CodecName !== "")
        extraParameters += " -videoCodec=" + gs.CodecName;
    if (gs.ExtraParameters !== "")
        extraParameters += " " + gs.ExtraParameters;
    if (gs.RealTime !== "")
        extraParameters += " -realTime=" + gs.RealTime;
    if (gs.FrameRate !== "")
        extraParameters += " -frameRate=" + gs.FrameRate;
    if (gs.DownScale !== "")
        extraParameters += " -downScale=" + gs.DownScale;

    // Send an HTTP request to the worker server
    var pathstring = '/VideoGen/' + job.HPName + '/' + job.parameters + extraParameters + '/' + job.id + '/' + eventSessionId + '/' + masterServerSessionId + '/' + worker.disk2DriveLetter + '/' + job.videoFilename;
    pathstring = pathstring.trim();
    pathstring = pathstring.replace(/ /g, "%20");
    if (endsWith(pathstring, '/')) {
        pathstring += "None";
    }
    console.log("pathstring = " + pathstring);
    var options = { hostname: worker.ip, port: workerPort, path: pathstring, method: 'GET' };

    var req = http.request(options, function(res) {});
    req.on('error', function(e) {
        VGSLog(0, 'problem with request: ' + e.message);
    });
    req.end();

    SendWorkerStatusesToClients(false);
    SendBasicStatusToClients(false);
    SendJobStatusesToClients(false);
}


function SendStatusViaEmail() {
    // If full job has succeeded, open and read the "LastBuildMade.txt" file, if it exists
    if (fullJobExitCode == 0) {
        var filename = process.env.CGC_LOCAL_BUILD_ROOT + "\\Haxxis\\LastBuildMade.txt";
        var buildFolderName = "";
        fs.readFile(filename, 'utf8', function(err, data) {
            if (!err)
                buildFolderName = data;
            DoSend(buildFolderName);
        });
    } else {
        DoSend(""); // Otherwise just continue
    }
}

function DoSend(buildFolderName) {
    var subjectText;
    var bodyHTML = "";
    if (fullJobExitCode == 0) {
        subjectText = 'Build Success:  CGC Haxxis Build Server';
        bodyHTML = "The CGC Haxxis Build Server was kicked off, and has completed successfully.<br><br>";
    } else {
        subjectText = '*** BUILD FAILURE ***  CGC Haxxis Build Server';
        bodyHTML = "The CGC Haxxis Build Server was kicked off, but did NOT complete successfully.<br><br>";
    }

    bodyHTML += '<br>Sincerely,<br>';
    bodyHTML += '--Haxxis Build Server<br><br>';


    var mailOptions = {
        from: 'Builds <builds@example.com>',
        to: [
            
        ],
        subject: subjectText,
        html: bodyHTML,
        attachments: []
    };

    /*transporter.sendMail(mailOptions, function (error, info) {
        if (error) {
            return console.log(error);
        }
        console.log('Message sent: ' + info.response);
    });*/
}

function MasterServerInit() {
    VGSLog(0, "Master server starting up");

    var filename = "VideoGenServerConfig.txt";
    fs.readFile(filename, 'utf8', function (err, data) {
        if (err) {
            VGSLog(0, "Problem finding/reading " + filename);
            throw err;
        }
        var lines = data.split("\n");
        lines.forEach(function (line) {
            line = line.trim();
            //line = line.toLowerCase();

            if (startsWith(line, 'worker:')) {
                line = line.substring('worker:'.length);
                var fields = line.split(',');
                var worker = {
                    ip: fields[0],
                    friendlyName: fields[1],
                    maxJobsRegular: parseInt(fields[2]),
                    maxJobsSpecial: parseInt(fields[3]),
                    paused: false,
                    hardPaused: false,
                    numActiveJobs: 0,
                    numActiveJobsRegular: 0,
                    numActiveJobsSpecial: 0,
                    numAvailSlotsRegular: parseInt(fields[2]),
                    numAvailSlotsSpecial: parseInt(fields[3]),
                    jobLoadPctRegular: 0,
                    jobLoadPctSpecial: 0,
                    loadCPU: 0,
                    loadCPUArray: [],
                    loadMem: 0,
                    loadGPU: 0,
                    loadGPUArray: [],
                    numGPUs: 0,
                    disk1DriveLetter: fields[4],
                    disk1SpaceUsed: 0,
                    disk1SpaceTotal: 0,
                    disk2DriveLetter: fields[5],
                    disk2SpaceUsed: 0,
                    disk2SpaceTotal: 0,
                    loadRequestTimeout: null,
                    connected: false,
                    buildVersion: "Unknown",
                    pendingGetBuildRequest: false,
                    packagesVersion: "Unknown",
                    pendingGetPackagesRequest: false,
                    pendingRestartRequest: false,
                    pendingShutdownRequest: false
                };
                workers[worker.ip] = worker;
                VGSLog(0, "Worker registered:  IP:" + worker.ip + "; max regular jobs:" + worker.maxJobsRegular + "; max special jobs:" + worker.maxJobsSpecial);
                numWorkers++;
            }

            if (startsWith(line, 'stresstest:')) {
                line = line.substring('stresstest:'.length);
                StressTestCount = parseInt(line);
            }

            if (startsWith(line, 'itemsperpage:')) {
                line = line.substring('itemsperpage:'.length);
                DefaultItemsPerPage = parseInt(line);
            }

            if (startsWith(line, 'supresschatnotifications:')) {
                line = line.substring('supresschatnotifications:'.length);
                SupressChatNotifications = (line.toLowerCase() === 'true');
            }

            // I could probably make the below code better by going through the elements of the gs object,
            // and using the element names as match
            if (startsWith(line, 'traceapiurl:')) {
                line = line.substring('traceapiurl:'.length);
                gs.TraceApiUrl = line.trim();
            }

            if (startsWith(line, 'screenresolution:')) {
                line = line.substring('screenresolution:'.length);
                gs.ScreenRes = line.trim();
            }

            if (startsWith(line, 'fullscreen:')) {
                line = line.substring('fullscreen:'.length);
                gs.FullScreen = line.trim();
            }

            if (startsWith(line, 'videocodecname:')) {
                line = line.substring('videocodecname:'.length);
                gs.CodecName = line.trim();
            }

            if (startsWith(line, 'extraparameters:')) {
                line = line.substring('extraparameters:'.length);
                gs.ExtraParameters = line.trim();
            }

            if (startsWith(line, 'realtime:')) {
                line = line.substring('realtime:'.length);
                gs.RealTime = line.trim();
            }

            if (startsWith(line, 'framerate:')) {
                line = line.substring('framerate:'.length);
                gs.FrameRate = line.trim();
            }

            if (startsWith(line, 'downscale:')) {
                line = line.substring('downscale:'.length);
                gs.DownScale = line.trim();
            }

            if (startsWith(line, 'currentround:')) {
                line = line.substring('currentround:'.length);
                gs.CurrentRound = line.trim();
            }

            if (startsWith(line, 'autoroundbatch:')) {
                line = line.substring('autoroundbatch:'.length);
                gs.AutoRoundBatch = line.trim();
            }
        })

        LoadEventSession();

        AttemptJobStarts(); // If there any jobs now waiting (due to the load), try to start them
        // Note the above will generally not start any jobs, because we JUST started the master server
        // and the workers have not had a chance to connect.  So we call AttemptJobStarts on worker connection.

        StressTestInit();

        for (var workerip in workers) {
            ConnectToWorker(workers[workerip]);
        }

        if (gs['AutoRoundBatch'].toLowerCase() === 'on')
            AutoRoundBatchCheckTimeout = setTimeout(PeriodicAutoRoundBatchCheck, 500); // Do this pretty soon after starting

        if (gs['AutoSaveFrequencyMs'] !== 0)
            AutoSaveTimeout = setTimeout(PeriodicAutoSave, 1000);  // Also, soon after starting

        setTimeout(PeriodicGetLatestBuildVersions, 1000);  // On startup, get this relatively quickly

        PostToStatusChat("VGS Master server has been started", ':grinning:', []);
    })
}

var GetLatestBuildVersionsFreqMs = 30000;

function PeriodicGetLatestBuildVersions() {
    //console.log("PeriodicGetLatestBuildVersions");
    setTimeout(PeriodicGetLatestBuildVersions, GetLatestBuildVersionsFreqMs);
    GetLatestBuildVersions();
}

function GetLatestBuildVersions() {
    //console.log("Getting latest available build versions");

    var keywordVersion = "Version:";
    var keywordVersionLen = keywordVersion.length;

    var keywordPackagesVersion = "PackagesVersion:";
    var keywordPackagesVersionLen = keywordPackagesVersion.length;

    var childGetVersionInfo = spawn('sh', ['DoGetHaxxisBuildVersion.sh', process.env.CGC_REMOTE_BUILD_ROOT], {});

    childGetVersionInfo.stdout.on('data', function (data) {
        var stringIn = String(data);
        if (stringIn.substring(0, keywordVersionLen) === keywordVersion) {
            latestBuildVersion = stringIn.substring(keywordVersionLen, stringIn.length);
            //console.log("GOT latestBuildVersion " + latestBuildVersion);
        } else if (stringIn.substring(0, keywordPackagesVersionLen) === keywordPackagesVersion) {
            latestPackagesVersion = stringIn.substring(keywordPackagesVersionLen, stringIn.length);
            //console.log("GOT latestPackagesVersion " + latestPackagesVersion);
        } else {
            console.log("childGetVersionInfo: " + data);
        }
    });

    childGetVersionInfo.on('exit', function(exitCode) {
        SendWorkerStatusesToClients(true);
    });

}

function StressTestInit() {
    VGSLog(0, "Stress test:  Adding " + StressTestCount + " items");
    for (var i = 0; i < StressTestCount; i++) {
        nextJobId++;
        var xStatus;
        if (Math.random() < 0.50) {
            xStatus = jobStatusEnum.COMPLETED_SUCCESS;
            numSuccessfullyCompletedJobs++;
        } else {
            xStatus = jobStatusEnum.COMPLETED_FAIL;
            numFailedJobs++;
        }
        var fakeDuration = 20 + (Math.round((Math.random() * 300)) / 10);
        var job = {
            HPName: "FakePackage_" + Math.round(Math.random() * 999999) + ".json",
            parameters: "-round=" + Math.round(Math.random() * 90) + " -test=" + Math.round(Math.random() * 999999),
            id: nextJobId,
            status: xStatus,
            errorCode: 0,
            startTime: new Date(),
            completionTime: nowTime(),
            duration: fakeDuration,
            videoFilename: /*"V_" +*/ nextJobId + "_20160804_" + Math.round(Math.random() * 999999) + ".avi",
            gpuIndex: Math.round(Math.random() * 3),
            workerIp: "TotesFake",
            priority: Math.round(Math.random() * 99),
            progress: 1,
            progressText: "Complete Fake",
            batchJobId: -1
        };
        jobRecords.push(job);
        saveDirty = true;
    }
}

function DecrementActiveJobs(jobIndex) {
    saveDirty = true;
    numActiveJobsTotal--;
    var worker = jobRecords[jobIndex].workerIp;
    workers[worker].numActiveJobs--;
    if (jobRecords[jobIndex].isSpecial) {
        workers[worker].numActiveJobsSpecial--;
    } else {
        workers[worker].numActiveJobsRegular--;
    }
}

function KillJob(index) {
    jobRecords[index].status = jobStatusEnum.KILLED;
    jobRecords[index].errorCode = -1;
    jobRecords[index].completionTime = nowTime();
    jobRecords[index].videoFilename = "";
    jobRecords[index].progress = 100;
    jobRecords[index].progressText = "Killed";
    numKilledJobs++;
    DecrementActiveJobs(index);
    saveDirty = true;

    var workerClient = workers[jobRecords[index].workerIp].ioc;
    workerClient.emit('kill job', { jobIdKey: jobRecords[index].id, MSSIdKey: masterServerSessionId }, function (message) {
        VGSLog(0, "Callback from request to kill job on worker");
    });
}

var fileCurEventSession = 'Public/VGSData/CurrentEventSession.json';
var saveDirty = true;
var AutoSaveTimeout;

function PeriodicAutoSave() {
    //VGSLog(3, "PeriodicAutoSave; freq set to " + gs['AutoSaveFrequencyMs']);
    SaveEventSession(false);

    if (gs['AutoSaveFrequencyMs'] !== 0)
        AutoSaveTimeout = setTimeout(PeriodicAutoSave, gs['AutoSaveFrequencyMs']);
}

function SaveEventSession(forceSave) {
    if (forceSave === false && saveDirty === false)
        return;
    saveDirty = false;

    //var start = new Date().getTime();

    var gsString = JSON.stringify(gs);  // Objects must be stringified; arrays and simple vars don't

    var obj = {
        nextJobIdKey: nextJobId,
        nextBatchIdKey: nextBatchId,
        masterServerSessionIdKey: masterServerSessionId,
        eventSessionIdKey: eventSessionId,
        nextUniqueClientIdKey: nextUniqueClientId,
        gsKey: gsString,
        jobRecordsKey: jobRecords,
        batchRecordsKey: batchRecords
    };

    jsonfile.writeFileSync(fileCurEventSession, obj, { spaces: 1 });

    //var end = new Date().getTime();
    //var time = end - start;
    //console.log('SaveEventSession took: ' + time + " ms");

    SendGlobalSettingsToClients();  // This is so the clients have an indication that the save is no longer dirty
}

function ResetMiscJobCounts() {
    numWaitingJobs = 0;
    numActiveJobsTotal = 0;
    numSuccessfullyCompletedJobs = 0;
    numFailedJobs = 0;
    numCancelledJobs = 0;
    numKilledJobs = 0;
}

function LoadEventSession() {
    var start = new Date().getTime();

    ResetMiscJobCounts();

    var obj = null;
    try {
        obj = jsonfile.readFileSync(fileCurEventSession);
    } catch (err) {
        VGSLog(0, "Trouble opening file " + fileCurEventSession + "; proceeding with sensible defaults");
        SaveEventSession(true);

        return;
    }

    nextJobId = obj['nextJobIdKey'];
    nextBatchId = obj['nextBatchIdKey'];
    masterServerSessionId = obj['masterServerSessionIdKey'];
    eventSessionId = obj['eventSessionIdKey'];
    nextUniqueClientId = obj['nextUniqueClientIdKey'];
    gs = JSON.parse(obj['gsKey']);
    jobRecords = obj['jobRecordsKey'];
    batchRecords = obj['batchRecordsKey'];

    masterServerSessionId++;    // We are in a new master server session

    // Restoration:  Here we go through the jobs database and revert any 'active' back to 'waiting'
    for (var i = 0, len = jobRecords.length; i < len; i++) {
        switch (jobRecords[i].status) {
            case jobStatusEnum.WAITING:
                numWaitingJobs++;
                break;
            case jobStatusEnum.ACTIVE:
                jobRecords[i].status = jobStatusEnum.WAITING;
                numWaitingJobs++;
                break;
            case jobStatusEnum.COMPLETED_SUCCESS:
                numSuccessfullyCompletedJobs++;
                break;
            case jobStatusEnum.COMPLETED_FAIL:
                numFailedJobs++;
                break;
            case jobStatusEnum.CANCELLED:
                numCancelledJobs++;
                break;
            case jobStatusEnum.KILLED:
                numKilledJobs++;
                break;
        }
    }

    saveDirty = false;

    var end = new Date().getTime();
    var time = end - start;
    console.log('LoadEventSession took: ' + time + " ms");
}

function JobIndexFromId(id) {
    for (var index = 0, len = jobRecords.length; index < len; index++) {
        if (jobRecords[index].id == id) {
            return index;
        }
    }
    return -1;
}

function BatchIndexFromId(id) {
    for (var index = 0, len = batchRecords.length; index < len; index++) {
        if (batchRecords[index].id == id) {
            return index;
        }
    }
    return -1;
}

function RegisterJobAsDoneInBatch(index) {
    var batchId = jobRecords[index].batchId;
    if (batchId >= 0) {
        var index = BatchIndexFromId(batchId);
        if (index < 0) {
            VGSLog(0, "ERROR:  Batch id associated with a completed job was not found; this should not happen");
        } else {
            batchRecords[index].numJobsComplete++;
            if (batchRecords[index].numJobsComplete == batchRecords[index].numJobsTotal) {
                batchRecords[index].progress = 100;
                batchRecords[index].progressText = "Finished";

                batchRecords[index].status = batchStatusEnum.COMPLETED_SUCCESS;
                var succeeded = true;
                for (var i = 0, len = jobRecords.length; i < len; i++) {
                    if (jobRecords[i].batchId == batchId) {
                        if (jobRecords[i].errorCode != 0 && jobRecords[i].errorCode != 127) {
                            batchRecords[index].status = batchStatusEnum.COMPLETED_FAIL;
                            batchRecords[index].errorCode = jobRecords[i].errorCode;    // Just take the error code from the first job that failed, was killed, cancelled, etc.
                            succeeded = false;
                            break;
                        }
                    }
                }

                batchRecords[index].completionTime = nowTime();
                batchRecords[index].duration = ((new Date() - batchRecords[index].startTime) / 1000).toFixed(1);

                // Post in Production chat
                var msg = 'Video BATCH ' + batchId + ' has finished, ';
                if (succeeded) {
                    msg += ' and all ' + batchRecords[index].numJobsTotal + ' videos are ready for retrieval.';
                } else {
                    msg += ' but there was at least one failed video job (of the ' + batchRecords[index].numJobsTotal + ' jobs total) in the batch.';
                }
                PostToProductionChat(msg, (succeeded ? ':smiley:' : ':rage:'), []);
            } else {
                var pct = batchRecords[index].numJobsComplete * 100 / batchRecords[index].numJobsTotal;
                batchRecords[index].progress = pct;
            }
            saveDirty = true;
        }
    }
}

function RevertAllJobsForWorker(worker) {
    for (var i = 0, len = jobRecords.length; i < len; i++) {
        if (jobRecords[i].status === jobStatusEnum.ACTIVE &&
            jobRecords[i].workerIp === worker.ip) {
            VGSLog(0, "Due to disabling of worker " + worker.friendlyName + ", job with id " + jobRecords[i].id + " was ACTIVE but placed back in the WAITING state");
            jobRecords[i].status = jobStatusEnum.WAITING;
            jobRecords[i].progress = 0;
            jobRecords[i].progressText = "";
            numActiveJobsTotal--;
            numWaitingJobs++;
        }
    }
    worker.numActiveJobs = 0;
    worker.numActiveJobsRegular = 0;
    worker.numActiveJobsSpecial = 0;
    worker.numAvailSlotsRegular = worker.maxJobsRegular;
    worker.numAvailSlotsSpecial = worker.maxJobsSpecial;
}

function WorkerStatusesText() {
    var text = "Current worker statuses:  ";
    var count = 0;
    for (var i in workers) {
        text += "Worker " + i + ":" + (workers[i].connected ? "CONNECTED" : "Disconnected") + (++count > numWorkers ? "" : "; ");
    }
    return text;
}

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

function ConnectToWorker(worker) {
    var address = "http://" + worker.ip + ":" + workerPort;
    VGSLog(0, "Attempting to connect to worker " + worker.friendlyName + " at " + address);

    worker.ioc = ioc.connect(address);
    var workerClient = worker.ioc;
    worker.connected = false;

    var WorkerLoadRequestFreqMs = 2000;
    var WorkerVersionRequestFreqMs = 30000; // Very infrequently

    workerClient.once("connect", function () {
        VGSLog(0, "Connected to worker " + worker.friendlyName + " at " + address);
        worker.connected = true;

        workerClient.emit('master assigns drives to monitor', { drive1Key: worker.disk1DriveLetter, drive2Key: worker.disk2DriveLetter }, function (message) {});

        // As soon as a worker comes online, attempt to use it because there may be waiting jobs
        // This is also important because when we restart the master server, we immediately try
        // (in MasterServerInit) to start any waiting jobs, but at that point no workers have
        // had a chance to connect yet.  So we do this here, on connection of worker:
        AttemptJobStarts();

        var attachmentText = WorkerStatusesText();
        PostToStatusChat('VSG Worker server ' + worker.friendlyName + ' at ' + address + ' has connected', ':relaxed:', [{ text: attachmentText }]);

        workerClient.emit('echo', "Hello World", function (message) {
            console.log('Echo received: ', message);
        })

        workerClient.on('reply', function (data) {
            VGSLog(0, "reply received from " + address);
        })

        workerClient.on('disconnect', function (data) {
            VGSLog(0, "Worker " + worker.friendlyName + " has DISCONNECTED");
            worker.connected = false;

            // The following timeout is here so that if the worker server goes down AFTER it receives the request, but BEFORE it replies,
            // (which can happen because the load measurement for CPU takes a full second or so), we'd never get the reply.
            clearTimeout(worker.loadRequestTimeout);

            // Find all jobs that (were) running on the worker that disconnected, and put them back in the waiting queue
            RevertAllJobsForWorker(worker);

            AttemptJobStarts();

            SendJobStatusesToClients(true);
            SendBatchStatusesToClients(true);

            SendWorkerStatusesToClients(true);

            var attachmentText = WorkerStatusesText();
            PostToStatusChat('VGS Worker server ' + worker.friendlyName + ' at ' + address + ' has disconnected', ':rage:', [{ text: attachmentText }]);
        })

        workerClient.on('reconnect', function (data) {
            VGSLog(0, "Worker " + worker.friendlyName + " has RECONNECTED");
            worker.connected = true;
            worker.pendingRestartRequest = false;
            worker.pendingShutdownRequest = false;

            worker.loadRequestTimeout = setTimeout(PeriodicWorkerLoadRequest, 500); // On RE-connection, get this relatively quickly

            AttemptJobStarts();

            SendWorkerStatusesToClients(true);

            var attachmentText = WorkerStatusesText();
            PostToStatusChat('VGS Worker server ' + worker.friendlyName + ' at ' + address + ' has reconnected', ':relaxed:', [{ text: attachmentText }]);
        })

        function PeriodicWorkerLoadRequest() {
            //VGSLog(3, "PeriodicWorkerLoadRequest for worker " + workerIndex);

            workerClient.emit('master requests load info from worker', function (message) {});
        }
        
        worker.loadRequestTimeout = setTimeout(PeriodicWorkerLoadRequest, 500); // On connection, get this relatively quickly

        workerClient.on('worker reply with load info', function (data) {
            //VGSLog(3, "load info received from worker " + workerIndex);

            // We just store the payload in the worker array, and set the timer to do it again later
            worker.loadMem = data['memKey'];

            worker.loadCPUArray = data['cpuLoadPctArrayKey'];
            var cpuLoadPctArray = worker.loadCPUArray;

            var cpuLoadPct = 0;
            var len = cpuLoadPctArray.length;
            for (var i = 0; i < len; i++)
                cpuLoadPct += cpuLoadPctArray[i];
            if (len > 0)
                cpuLoadPct /= len;

            worker.loadCPU = cpuLoadPct;

            worker.loadGPUArray = data['gpuLoadPctArrayKey'];
            var gpuLoadPctArray = worker.loadGPUArray;

            var gpuLoadPct = 0;
            var len = gpuLoadPctArray.length;
            for (var i = 0; i < len; i++)
                gpuLoadPct += gpuLoadPctArray[i].load;
            if (len > 0)
                gpuLoadPct /= len;

            worker.loadGPU = gpuLoadPct;
            worker.numGPUs = gpuLoadPctArray.length;

            var diskArray = data['diskSpaceArrayKey'];  // Objects must be stringified; arrays and simple vars don't
            if (diskArray[0] !== undefined) { // Was getting a crash occasionally
                worker.disk1SpaceUsed = diskArray[0].used;
                worker.disk1SpaceTotal = diskArray[0].size;
            }
            if (diskArray[1] !== undefined) { // Was getting a crash occasionally
                worker.disk2SpaceUsed = diskArray[1].used;
                worker.disk2SpaceTotal = diskArray[1].size;
            }

            worker.loadRequestTimeout = setTimeout(PeriodicWorkerLoadRequest, WorkerLoadRequestFreqMs);
        })

        function PeriodicWorkerVersionRequest() {
            workerClient.emit('master requests build version from worker', function (message) {});
        }

        setTimeout(PeriodicWorkerVersionRequest, 500);  // On connection, get this relatively quickly

        workerClient.on('worker reply with build version', function (data) {
            //VGSLog(3, "build version received from worker " + workerIndex);
            // We just store the payload in the worker array, and set the timer to do it again later
            worker.buildVersion = data['buildVersionKey'];
            worker.packagesVersion = data['packagesVersionKey'];

            setTimeout(PeriodicWorkerVersionRequest, WorkerVersionRequestFreqMs);
        })

        workerClient.on('worker reply got latest build', function (data) {
            VGSLog(0, "Worker " + worker.friendlyName + " reports it has completed its 'get latest build' request");
            worker.buildVersion = data['buildVersionKey'];
            worker.pendingGetBuildRequest = false;
            SendWorkerStatusesToClients(true);  // Send this to all clients so they see immediately that the request is done
        })

        workerClient.on('worker reply got latest packages', function (data) {
            VGSLog(0, "Worker " + worker.friendlyName + " reports it has completed its 'get latest packages' request");
            worker.packagesVersion = data['packagesVersionKey'];
            worker.pendingGetPackagesRequest = false;
            SendWorkerStatusesToClients(true);  // Send this to all clients so they see immediately that the request is done
        })

        workerClient.on('worker reply hp parameters', function (data) {
            VGSLog(1, "Worker " + worker.friendlyName + " has replied to 'get hp parameters' request");
            var hpName = data['hpName'];
            var parameters = data['parameters'];
            var requestingClientId = data['requestingClientId'];

            var clientIndex = ClientIndexFromId(requestingClientId);
            if (clientIndex >= 0) { // (Ignore if client is no longer connected)
                var client = clients[clientIndex];
                client.socket.emit('hp parameters', { hpName: hpName, parameters: parameters });
            }
        })

        workerClient.on('worker reply hp list', function (data) {
            VGSLog(1, "Worker " + worker.friendlyName + " has replied to 'get hp list' request");
            var requestingClientId = data['requestingClientId'];
            var list = data['list'];

            var clientIndex = ClientIndexFromId(requestingClientId);
            if (clientIndex >= 0) { // (Ignore if client is no longer connected)
                var client = clients[clientIndex];

                var specialList = DirSync(__dirname + "/Public/SpecialPackages", __dirname + "/Public/SpecialPackages", []);
                specialList.forEach(function(item, index) {
                    specialList[index] = "Specials/" + item;
                })
                var specialIndex = list.findIndex(function(s) { return s.startsWith('Specials/');})
                if(specialIndex > 0) {
                    list = list.filter(function(s) { return !s.startsWith('Specials/');});
                    list = list.slice(0, specialIndex-1).concat(specialList,list.slice(specialIndex));
                } else {
                    specialIndex = list.findIndex(function(s) { return s > specialList[0];});
                    list = list.slice(0, specialIndex).concat(specialList,list.slice(specialIndex));
                }

                client.socket.emit('hp list', { list: list });
            }
        })

        workerClient.on('worker job partial info', function (data) {
            var id = parseInt(data['jobIdKey']);
            var MSSID = parseInt(data['MSSIDKey']);
            var videoFilename = data['videoFilenameKey'];
            var gpuIndex = data['gpuIndexKey'];

            if (MSSID != masterServerSessionId) {
                VGSLog(1, "Ignoring job message received from worker, because it was a job not started in the current master server session");
                return;
            }

            if (worker.hardPaused) {
                VGSLog(1, "Ignoring job message received from worker, because the worker has just been hard-paused");
                return;
            }

            // Find the record (by id) in the master list:
            var index = JobIndexFromId(id);
            if (index < 0 || index >= jobRecords.length) {
                // This would be very rare
                VGSLog(2, "PROBLEM:  ID was not found in jobRecords (on job partial info); ignoring this message");
            } else {
                if (workers[jobRecords[index].workerIp].pendingRestartRequest || workers[jobRecords[index].workerIp].pendingShutdownRequest)
                    return;

                if (jobRecords[index].status != jobStatusEnum.KILLED) {
                    saveDirty = true;
                    // The next two lines are my attempt to trim off an apparent newline of some sort
                    videoFilename = videoFilename.replace(/(\r\n|\n\r)/gm, "");
                    videoFilename = videoFilename.substring(0, videoFilename.length - 1);
                    jobRecords[index].videoFilename = videoFilename;
                    jobRecords[index].gpuIndex = gpuIndex;
                    jobRecords[index].progressText = "Launching";
                }
                SendJobStatusesToClients(false);
            }
        })

        workerClient.on('worker job progress info', function (data) {
            var id = parseInt(data['jobIdKey']);
            var MSSID = parseInt(data['MSSIDKey']);
            var progress = data['progressKey'];
            var progressText = data['progressTextKey'];

            if (MSSID != masterServerSessionId) {
                VGSLog(1, "Ignoring job message received from worker, because it was a job not started in the current master server session");
                return;
            }

            if (worker.hardPaused) {
                VGSLog(1, "Ignoring job message received from worker, because the worker has just been hard-paused");
                return;
            }

            // Find the record (by id) in the master list:
            var index = JobIndexFromId(id);
            if (index < 0 || index >= jobRecords.length) {
                // This would be very rare.  Currently, it would happen if job was killed, though
                VGSLog(2, "PROBLEM:  ID was not found in jobRecords (on job progress info); ignoring this message");
            } else {
                if (workers[jobRecords[index].workerIp].pendingRestartRequest || workers[jobRecords[index].workerIp].pendingShutdownRequest)
                    return;

                if (jobRecords[index].status !== jobStatusEnum.KILLED) {   // Don't take a progress update if the job has already been killed
                    saveDirty = true;
                    jobRecords[index].progress = progress;
                    jobRecords[index].progressText = progressText;

                    SendJobStatusesToClients(false);
                }
            }
        })

        workerClient.on('worker job error code', function (data) {
            var id = parseInt(data['jobIdKey']);
            var MSSID = parseInt(data['MSSIDKey']);
            var errorCode = parseInt(data['errorCodeKey']);

            if (MSSID != masterServerSessionId) {
                VGSLog(1, "Ignoring job message received from worker, because it was a job not started in the current master server session");
                return;
            }

            // Find the record (by id) in the master list:
            var index = JobIndexFromId(id);
            if (index < 0 || index >= jobRecords.length) {
                VGSLog(2, "PROBLEM:  ID was not found in jobRecords (on job error code); ignoring this message");
            } else {
                if (workers[jobRecords[index].workerIp].pendingRestartRequest || workers[jobRecords[index].workerIp].pendingShutdownRequest)
                    return;

                saveDirty = true;
                jobRecords[index].errorCode = errorCode;

                SendJobStatusesToClients(false);
            }
        })

        workerClient.on('worker job video duration', function (data) {
            var id = parseInt(data['jobIdKey']);
            var MSSID = parseInt(data['MSSIDKey']);
            var frameCount = parseInt(data['frameCount']);
            var duration = parseFloat(data['duration']);

            if (MSSID != masterServerSessionId) {
                VGSLog(1, "Ignoring job message received from worker, because it was a job not started in the current master server session");
                return;
            }

            // Find the record (by id) in the master list:
            var index = JobIndexFromId(id);
            if (index < 0 || index >= jobRecords.length) {
                VGSLog(2, "PROBLEM:  ID was not found in jobRecords (on job error code); ignoring this message");
            } else {
                if (workers[jobRecords[index].workerIp].pendingRestartRequest || workers[jobRecords[index].workerIp].pendingShutdownRequest)
                    return;

                saveDirty = true;
                jobRecords[index].frameCount = frameCount;
                jobRecords[index].videoDuration = duration;

                SendJobStatusesToClients(false);
            }
        })

        workerClient.on('worker job result', function (data) {
            var id = parseInt(data['jobIdKey']);
            var MSSID = parseInt(data['MSSIDKey']);
            var exitCode = data['exitCodeKey'];

            if (MSSID != masterServerSessionId) {
                VGSLog(1, "Ignoring job message received from worker, because it was a job not started in the current master server session");
                return;
            }

            if (worker.hardPaused) {
                VGSLog(1, "Ignoring job message received from worker, because the worker has just been hard-paused");
                return;
            }

            VGSLog(2, "End job reported for id " + id + "; exitCode: " + exitCode);

            // Find the record (by id) in the master list:
            var index = JobIndexFromId(id);
            if (index < 0 || index >= jobRecords.length) {
                // This could occur if a job was "killed", and then deleted by the user before the job actually returned.
                // For now, we just silently do nothing.  We COULD introduce a 'pending' state that 
                // waits until the job comes back, and then deletes the job.  Or something like that.
                VGSLog(2, "PROBLEM:  ID was not found in jobRecords (on job completion); ignoring this message");
            } else {
                if (workers[jobRecords[index].workerIp].pendingRestartRequest || workers[jobRecords[index].workerIp].pendingShutdownRequest)
                    return;

                if (jobRecords[index].status != jobStatusEnum.KILLED) {
                    saveDirty = true;
                    DecrementActiveJobs(index);
                    var succeeded = true;
                    if (exitCode === 0 || exitCode === 127) {     // 127 now used as Haxxis kills itself when done with video gen job (2016/03/01)
                        numSuccessfullyCompletedJobs++;
                        jobRecords[index].status = jobStatusEnum.COMPLETED_SUCCESS;
                    } else {
                        numFailedJobs++;
                        jobRecords[index].status = jobStatusEnum.COMPLETED_FAIL;
                        succeeded = false;
                    }
                    jobRecords[index].errorCode = exitCode;
                    jobRecords[index].completionTime = nowTime();
                    jobRecords[index].duration = ((new Date() - jobRecords[index].startTime) / 1000).toFixed(1);
                    jobRecords[index].progressText = "";

                    if (jobRecords[index].batchId < 0) {
                        var msg = 'Video generation job #' + id + " has ";
                        msg += (succeeded ? 'completed successfully and the video is ready for retrieval.' : 'FAILED.');
                        PostToProductionChat(msg, (succeeded ? ':relaxed:' : ':astonished:'), []);
                    }
                }

                RegisterJobAsDoneInBatch(index);

                SendWorkerStatusesToClients(false);
                SendBasicStatusToClients(false);
                SendJobStatusesToClients(false);
                SendBatchStatusesToClients(false);

                AttemptJobStarts();
            }
        })

        workerClient.on('fetch special', function (data, fn) {
            fs.readFile(__dirname + "/Public/SpecialPackages/" + data.name, function (err, file) {
                if(err) {
                    data.success = false;
                    fn(data);
                    VGSLog(0, 'ERROR: Worker ' + worker.friendlyName + ' just requested Special Package ' + data.name + ' but we failed it, because ' + err.message)
                } else {
                    data.success = true;
                    data.file = file;
                    fn(data);
                }
            })
        })
    });
}

var AutoRoundBatchCheckTimeout;

function PeriodicAutoRoundBatchCheck() {
    //VGSLog(3, "PeriodicAutoRoundBatchCheck");

    // Send an HTTP request to the TraceAPI
    var options = { method: 'GET', path: '/complete/after/' + gs['CurrentRound'] };
    var fields = gs['TraceApiUrl'].split(':');
    if (gs['TraceApiUrl'].startsWith("db:")) {
        var otherFields = fields[1].split('/'); // If there's the new obfuscation part of the URL, split that off from the port
        options.path = "/" + otherFields[1] + options.path;
        options.hostname = fields[fields.length - 1];
        options.port = otherFields[0];
    } else {
        options.port = fields[2];
        options.hostname = fields[1].substring(2);  // fields[1] will have the two slashes at the start that need to be pitched
    }

    var req = http.request(options, function (res) {
        res.on('data', function (d) {
            var obj = JSON.parse(d);
            var complete = obj.complete;
            var newRound = parseInt(obj.round);
            //VGSLog(3, 'received from traceapi:  complete=' + complete + "; round=" + newRound);

            if (newRound > gs['CurrentRound']) {
                VGSLog(1, 'Detected new round available, so kicking off auto batch process; new round is ' + newRound + " (current round was " + gs['CurrentRound'] + ")");
                
                gs['CurrentRound'] = newRound;
                saveDirty = true;
                SendGlobalSettingsToClients();

                KickOffAutoRoundBatch();

                gs['PreviousRound'] = newRound;
            }

            AutoRoundBatchCheckTimeout = setTimeout(PeriodicAutoRoundBatchCheck, gs.AutoRoundCheckFrequency * 1000);
        });
    });
    req.on('error', function (e) {
        VGSLog(0, 'problem with request: ' + e.message);
    });
    req.end();
}

function KickOffAutoRoundBatch() {
    if (masterHasShutDown)
        return;

    // Send an HTTP request ourself, to kick off the batch process

    var pathstring = '/StartBatchGen/BatchPerRoundAuto.txt/-1/' + gs['CurrentRound'] + '/'
        + (gs['PreviousRound'] >= 0 ? ('-prevround=' + gs['PreviousRound'] + '%20') : "") + '-round=' + gs['CurrentRound'] + '%20';
    pathstring += '-rounds=0..' + gs['CurrentRound'] + '%20' + gs['ExtraParameters'];
    //pathstring = encodeURIComponent(pathstring);

    VGSLog(3, pathstring);

    var options = { hostname: "localhost", port: port, path: pathstring, method: 'GET' };

    var req = http.request(options, function (res) {
        res.on('data', function (d) {
            //var obj = JSON.parse(d);
        });
    });
    req.on('error', function (e) {
        VGSLog(0, 'problem with request: ' + e.message);
    });
    req.end();
}

// level is a number:
//    0 = Highest importance
//    1 = Important
//    2 = Not so important
//    3 = Informational only (verbose)

var logFileName = 'Public/VGSData/CurrentLog.txt';
var curMaxLogFileFilterLevel = 99;  // Anything below this level gets written to the log file

function AddLeadingZeroes(number, length) {
    var str = '' + number;
    while (str.length < length) {
        str = '0' + str;
    }
    return str;
}

function VGSLog(level, message) {
    console.log("VGS LOG: " + message);
     
    var d = new Date();
    var dtStr = String(d);
    // Strip out day of week, year, and the time zone
    dtStr = dtStr.substring(4, 11) + dtStr.substring(16, 24) + "." + AddLeadingZeroes(d % 1000, 3);
    var formattedMsg = level + ": " + dtStr + ": " + message + "\r\n";

    // Send to clients
    for (var i = 0; i < clients.length; i++) {
        if (clients[i] !== undefined) {
            if (clients[i].socket !== undefined) { // Checking this here because if a machine with 2 or more clients disconnects, we log those facts, and on the first disconnect, we send to all other clients, including the second client on that machine
                clients[i].socket.emit('log event', { levelKey: level, msgKey: formattedMsg });
            }
        }
    }

    // Append to file on disk
    if (level <= curMaxLogFileFilterLevel) {
        fs.appendFileSync(logFileName, formattedMsg);
    }

    // Post to chat
//    PostToChat(formattedMsg, ":smiley:", []);
}

var chatRoomEnum = {
    CHAT_PRODUCTION: 0,
    CHAT_STATUS: 1,
};

var chatRoomTokens = [
    'mqRxWZyvYPEBPTgp2/88iqRjgywu3z4GwcpmdSd88QMYW4stsrpECGFBQTtwTsmZsy',
    'nbwJKFfJRSWxnkqCx/y9Tt6rT7P8AmrqYSm888skRpPa35Y4btgM7JdSgbgmo2erf9',
];

function PostToProductionChat(msg, emoji, attachments) {
    PostToChat(chatRoomEnum.CHAT_PRODUCTION, msg, emoji, attachments);
}

function PostToStatusChat(msg, emoji, attachments) {
    PostToChat(chatRoomEnum.CHAT_STATUS, msg, emoji, attachments);
}

function PostToChat(roomEnum, msg, emoji, attachments) {
    if (SupressChatNotifications)
        return;

    request.post(
        'http://chat:3000/hooks/' + chatRoomTokens[roomEnum],
        {
            json: {
                "username": "VGS",
                "text": msg,
                "emoji": emoji,
                "attachments": attachments
            }
        },
        function (error, response, body) {
            if (!error && response.statusCode == 200) {
                //console.log(body);
            }
        }
    );
}

MasterServerInit();

server.listen(port);
