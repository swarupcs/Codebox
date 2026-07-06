#!/bin/bash
set -e

# Create isolate directories
mkdir -p /var/local/lib/isolate /run/isolate

# Set up cgroup v2 for isolate
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    # Create a leaf cgroup for the worker process
    mkdir -p /sys/fs/cgroup/worker

    # Move current shell into the worker cgroup
    # so the root cgroup has no direct processes
    if ! echo $$ > /sys/fs/cgroup/worker/cgroup.procs 2>/dev/null; then
        echo "WARNING: Failed to move process to worker cgroup" >&2
    fi

    # Enable controllers at root level (needs no processes in root)
    if ! echo "+cpu +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null; then
        echo "WARNING: Failed to enable cgroup controllers at root" >&2
    fi

    # Create dedicated cgroup subtree for isolate boxes
    mkdir -p /sys/fs/cgroup/isolate
    if ! echo "+cpu +memory +pids" > /sys/fs/cgroup/isolate/cgroup.subtree_control 2>/dev/null; then
        echo "WARNING: Failed to enable cgroup controllers for isolate" >&2
    fi

    echo "Cgroup v2 setup complete for isolate"
else
    echo "WARNING: cgroup v2 not detected, assuming cgroup v1. Setting up isolate for cgroup v1." >&2
    
    # Isolate requires the cg_root to exist. For cgroup v1, it uses subdirectories in each controller.
    # We create the base directory anyway to prevent "Control group root does not exist" errors,
    # and also create it under the main controllers.
    mkdir -p /sys/fs/cgroup/isolate
    
    for ctrl in memory cpu cpuset pids cpuacct; do
        if [ -d "/sys/fs/cgroup/$ctrl" ]; then
            mkdir -p "/sys/fs/cgroup/$ctrl/isolate"
            # Try to inherit settings from parent if needed (e.g., cpuset)
            if [ "$ctrl" = "cpuset" ] && [ -f "/sys/fs/cgroup/$ctrl/cpuset.cpus" ]; then
                cat "/sys/fs/cgroup/$ctrl/cpuset.cpus" > "/sys/fs/cgroup/$ctrl/isolate/cpuset.cpus" 2>/dev/null || true
                cat "/sys/fs/cgroup/$ctrl/cpuset.mems" > "/sys/fs/cgroup/$ctrl/isolate/cpuset.mems" 2>/dev/null || true
            fi
        fi
    done
    
    # Update isolate configuration to use cgroup v1 syntax (cg_root = isolate)
    # The Dockerfile sets cg_root = /sys/fs/cgroup/isolate which is only valid for v2
    if [ -f /usr/local/etc/isolate ]; then
        sed -i 's|^cg_root = .*|cg_root = isolate|' /usr/local/etc/isolate
    fi
fi

exec "$@"
