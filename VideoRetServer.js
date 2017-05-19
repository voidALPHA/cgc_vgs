var port = 8005;
//var workerVGSPort = 8004;
//var masterVGSPort = 8003;
//var ftpServerPort = 8006;

"use strict";

var express = require('express');
var app = express();
var http = require('http');
var server = http.Server(app);
var io = require('socket.io')(server);
var ioc = require('socket.io-client');
var jsonfile = require('jsonfile');
var favicon = require('serve-favicon');

//var mailer = require('nodemailer');
var path = require("path");
var fs = require('fs');
require('log-timestamp');
var spawn = require('child_process').spawn;
var os = require('os');
var ftpClient = require('ftp');
var ip = require('ip');


var firstMasterServerSessionId = masterServerSessionId = 10;

var jobRecords = [];    // Master array of all jobs

var jobStatusEnum = {
    WAITING: 0,
    ACTIVE: 1,
    COMPLETED_SUCCESS: 2,
    COMPLETED_FAIL: 3,
    CANCELLED: 4,
    KILLED: 5,
};

var DefaultItemsPerPage = 30;
var VGSMasterHostName = "";

var masterHasShutDown = false;


app.use(express.static('public'));

app.use(favicon(__dirname + '/favicon_vrs.png'));

app.get('/VRS', function (request, response) {
    response.sendFile(path.join(__dirname + '/VideoRetServer.html'));
});

app.get('/VideoRetServer.css', function (request, response) {
    response.sendFile(path.join(__dirname + '/VideoRetServer.css'));
})

app.get('/Test/:Version', function (request, response) {
    response.send("Test called with just version");
    console.log(request.params.Version);
});

app.get('/Test/:Version/:SecondVersion', function (request, response) {
    response.send("Test called with TWO versions");
    console.log(request.params.Version);
});


function ClientIndexFromId(clientId) {
    for (var i = 0, len = clients.length; i < len; i++) {
        if (clients[i].clientId == clientId) {
            return i;
        }
    }
    return -1;
}

var nextUniqueClientId = 101;
var clients = [];

io.on('connection', function (socket) {
    console.log("In server's connection handler");

    // Per-client variables:
    var clientId = nextUniqueClientId++;

    // Register the client so we can talk to it individually later
    var clientInfo = {
        clientId: clientId,
        socket: socket,
        curPage: 0,
        itemsPerPage: DefaultItemsPerPage,
        jobStatusFilter: -1, // Bit-wise filter flags for the various job statuses; -1 means 'all'
        jobSortField: 'id',
        jobSortAscending: true,
        jobTableSendDirty: false,
    };
    clients.push(clientInfo);

    SendJobStatusPageToClient(ClientIndexFromId(clientId));

    socket.emit('send vgs host name to client', { VGShostname: VGSMasterHostName });

    var JobTableSendFrequencyMs = 750;

    setTimeout(PeriodicJobTableSend, JobTableSendFrequencyMs);

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

    socket.on('get jobs status', function (data) {
        SendJobStatusPageToClient(ClientIndexFromId(clientId));
    })

    //socket.on('get video', function (data) {

    // OLDER ATTTEMPTS:

        //var ftpc = new ftpClient();

        //ftpc.on('ready', function () {
        //    var filename = "Public/GeneratedVideos/EventSession_" + eventSessionId + "/" + videoFilename;
        //    console.log("READY...now requesting to get file: " + filename);
        //    ftpc.size(filename, function (err, numBytes) {
        //        if (err) throw err;
        //        var sizeMB = (numBytes / 1024 / 1024).toFixed(2);
        //        console.log('size returned: ' + numBytes + ' bytes (' + sizeMB + " MB)");
        //    })
        //    ftpc.get(filename, function (err, stream) {
        //        if (err) throw err;
        //        stream.setEncoding('binary');
        //        stream.once('close', function () {
        //            ftpc.end();
        //            //console.log('after "end" in close');
        //        });

        //        var targetFolder = 'Public/RetrievedVideos/EventSession_' + eventSessionId;
        //        if (!fs.existsSync(targetFolder))
        //            fs.mkdirSync(targetFolder);

        //        var videoFileExtension = videoFilename.substring(videoFilename.indexOf("."), videoFilename.length);
        //        var simpleVideoFilename = 'V_' + jobId + videoFileExtension;

        //        var writer = fs.createWriteStream(targetFolder + '/' + simpleVideoFilename, { defaultEncoding: 'binary' });
        //        stream.pipe(writer);
        //        //console.log("after stream.pipe");
        //    })
        //})
        //ftpc.on('greeting', function (msg) {
        //    console.log("GREETING event: " + msg);
        //})
        //ftpc.on('end', function () {
        //    //console.log("END event");
        //})
        //ftpc.on('close', function (hadError) {
        //    console.log("CLOSE event: hadError is " + hadError);
        //    var end = new Date().getTime();
        //    var time = end - start;
        //    console.log('Time to transfer video from worker to master: ' + time + " ms");
        //})

        //ftpc.connect({ host: workerIp, port: ftpServerPort });
    //})

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
        //VRSLog(1, "received request to jump to page " + newPage);
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
        VRSLog(1, "new items per page (jobs table) is " + data["newItemsPerPage"]);
        SendJobStatusPageToClient(index);
    })

    // Disconnect
    socket.on('disconnect', function () {
        VRSLog(0, "Client " + clientId + " has disconnected from the VRS server");
        var index = ClientIndexFromId(clientId);
        clients.splice(index, 1);   // Unregister the client by removing it from the list of clients
    })
})

var sort_by = function (field, reverse, primer) {
    var key = function (x) { return primer ? primer(x[field]) : x[field] };

    return function (a, b) {
        var A = key(jobRecords[a]), B = key(jobRecords[b]);
        return ((A < B) ? -1 : ((A > B) ? 1 : 0)) * [-1, 1][+!!reverse];
    }
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

    var data = "";
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

        // Now package up the jobs data for the page
        var endIndex = (clients[clientIndex].curPage + 1) * itemsPerPage;
        if (endIndex > jobs.length)
            endIndex = jobs.length;
        for (var j = (clients[clientIndex].curPage * clients[clientIndex].itemsPerPage), firstItem = true; j < endIndex; j++) {
            if (!firstItem) {
                data += "|";
            }
            firstItem = false;
            var jobRecord = jobRecords[jobs[j]];
            data += jobRecord.id + "," + jobRecord.status + "," + jobRecord.HPName + "," + jobRecord.parameters
                + "," + jobRecord.errorCode + "," + jobRecord.videoName + "," + jobRecord.completionTime + "," + jobRecord.duration
                + "," + jobRecord.worker + "," + jobRecord.priority + "," + jobRecord.gpuIndex + "," + jobRecord.progress + "," + jobRecord.progressText
                + "," + jobRecord.batchId;
        }
    } else {
        clients[clientIndex].curPage = 0;
    }

    //var emptyJobsToAdd = (jobs.length == 0 ? itemsPerPage : itemsPerPage - (jobs.length % itemsPerPage));
    //console.log("Adding empty jobs: " + emptyJobsToAdd);
    //while (emptyJobsToAdd-- > 0) {
    //    data += "0,jobStatusEnum.WAITING,'','','',0,'','',0,0,0,0,0,'',0";
    //}

    var client = clients[clientIndex];
    client.jobTableSendCount++;
    client.socket.emit('update jobs', {
        curPageKey: client.curPage, itemsPerPageKey: client.itemsPerPage, totalJobsKey: jobRecords.length, totalFilteredItemsKey: jobs.length,
        jobStatusFilterKey: client.jobStatusFilter, sortFieldKey: sortField, ascendingKey: ascending, dataKey: data, sendCountKey: client.jobTableSendCount
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

function nowTime() {
    var dt = String(new Date());
    // Strip out day of week, year, and the time zone
    return dt.substring(4, 11) + dt.substring(16, 24);
}

function endsWith(str, suffix) {
    return str.toLowerCase().indexOf(suffix, str.length - suffix.length) !== -1;
}

function startsWith(str, prefix) {
    return str.toLowerCase().indexOf(prefix.toLowerCase()) === 0;
}

function MasterServerInit() {
    VRSLog(0, "VRS server starting up");

    var filename = "VideoRetServerConfig.txt";
    fs.readFile(filename, 'utf8', function (err, data) {
        if (err) {
            VRSLog(0, "Problem finding/reading " + filename);
            throw err;
        }
        var lines = data.split("\n");
        lines.forEach(function (line) {
            line = line.trim();

            if (startsWith(line, 'vgsmasterhostname:')) {
                line = line.substring('vgsmasterhostname:'.length);
                VGSMasterHostName = line;
                console.log('VGS master host name set to ' + VGSMasterHostName);
            }

            if (startsWith(line, 'itemsperpage:')) {
                line = line.substring('itemsperpage:'.length);
                DefaultItemsPerPage = parseInt(line);
            }
        })
    })
}


// level is a number:
//    0 = Highest importance
//    1 = Important
//    2 = Not so important
//    3 = Informational only (verbose)

var logFileName = 'Public/VGSData/CurrentVRSLog.txt';
var curMaxLogFileFilterLevel = 99;  // Anything below this level gets written to the log file

function AddLeadingZeroes(number, length) {
    var str = '' + number;
    while (str.length < length) {
        str = '0' + str;
    }
    return str;
}

function VRSLog(level, message) {
    console.log("VRS LOG: " + message);

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
}


MasterServerInit();

server.listen(port);
