== voidALPHA Video Generation Server ==

Copyright 2017 voidALPHA, Inc.
This software is part of the Haxxis video generation system and is provided
by voidALPHA in support of the Cyber Grand Challenge.
Haxxis is free software: you can redistribute it and/or modify it under the terms
of the GNU General Public License as published by the Free Software Foundation.
Haxxis is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.
You should have received a copy of the GNU General Public License along with
Haxxis. If not, see <http://www.gnu.org/licenses/>.


Prerequisite installations:
- Node.JS v6.10.0; a copy of the installer is made available in the Installs directory
- A BASH Terminal like cygwin or mingw; a portable version is made available via the PortableBash/bin folder


Installation procedure:
1. Run the InstallationScript.bat batch file as an administrator to automate additional steps that allow the VGS to function.

2. In a shell of your choice active within the folder, execute "npm install -g nodemon" and "npm install" to install node.js dependencies for the VGS.

3. Modify the VideoGenServerConfig.txt text file to provide the default configuration for the VGS Master:
    Workers may be pre-registered here, using either a direct IP address or a resolvable host name.
    If you plan to use a different Trace API instance than the one with information from the CGC CFE, provide its address in that file as well.
    Note that, beyond the worker registration, these settings are only first-run defaults; modified settings will be saved with the Event Session.
    
4. Modify the VideoGenServerConfig.txt text file to provide the configuration for a late-registered VGS Worker:
    Provide the address of the Master Server, using either a direct IP address or a resolvable host name.
    If you plan to only use this Worker Server as a pre-registered server, delete the VideoGenServerConfig.txt file.
    Do not allow more than one late-registered server to have the same friendly name; that field is used to determine whether a Worker Server is already registered.
    
5. If you want your VGS installation to be accessible from outside of the local network, forward the port 8003 through your firewall and/or router.


Initialization procedure:
- Start the Master Server script before starting any late-registration Worker Server

- Run the StartVideoGenServer.sh shell script either directly (using your own BASH Terminal)
    or via the accompanying StartVideoGenServer.bat batch script (using the provided portable version)
    to allow the machine to act as the VGS master
    
- Run the StartVideoGenWorkerServer.sh shell script either directly (using your own BASH Terminal)
    or via the accompanying StartVideoGenWorkerServer.bat batch script (using the provided portable version)
    to allow the machine to act as a worker for the VGS


Utilization procedure:
1. Point a web browser to http://[machineAddress]:8003/vgs, where [machineAddress] is the address of the machine the VGS Master is on.