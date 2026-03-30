#!/bin/bash
cd "$(dirname "$0")"
nohup node server.js >> server.log 2>&1 &
echo "Server started (PID $!), logging to server.log"
