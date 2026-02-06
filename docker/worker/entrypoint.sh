#!/bin/bash
set -e

# Create isolate directories
mkdir -p /var/local/lib/isolate /run/isolate

# Set up cgroup v2 for isolate
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    # Create a leaf cgroup for the worker process
    mkdir -p /sys/fs/cgroup/worker

    # Move current shell (and future children) into the worker cgroup
    # so the root cgroup has no direct processes
    echo $$ > /sys/fs/cgroup/worker/cgroup.procs 2>/dev/null || true

    # Enable controllers at root level (needs no processes in root)
    echo "+cpu +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true

    # Create dedicated cgroup subtree for isolate boxes
    mkdir -p /sys/fs/cgroup/isolate
    echo "+cpu +memory +pids" > /sys/fs/cgroup/isolate/cgroup.subtree_control 2>/dev/null || true
fi

exec "$@"
