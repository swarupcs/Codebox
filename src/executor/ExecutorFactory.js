import fs from 'fs';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import DockerExecutor from './DockerExecutor.js';
import FirecrackerExecutor from './FirecrackerExecutor.js';

let executorInstance = null;
let executorType = null;

/**
 * Detect if Firecracker is available on the system
 */
function isFirecrackerAvailable() {
  // Check if we're on Linux
  if (process.platform !== 'linux') {
    return { available: false, reason: `Not Linux (${process.platform})` };
  }

  // Check for KVM
  if (!fs.existsSync('/dev/kvm')) {
    return { available: false, reason: '/dev/kvm not found' };
  }

  // Check for firecracker binary
  const fcPaths = ['/usr/local/bin/firecracker', '/usr/bin/firecracker'];
  const fcExists = fcPaths.some(p => fs.existsSync(p));
  if (!fcExists) {
    return { available: false, reason: 'Firecracker binary not found' };
  }

  // Check for kernel
  if (!fs.existsSync('/var/lib/codebox/firecracker/kernels/vmlinux')) {
    return { available: false, reason: 'Firecracker kernel not found' };
  }

  // Check for at least one rootfs
  const rootfsDir = '/var/lib/codebox/firecracker/rootfs';
  if (!fs.existsSync(rootfsDir)) {
    return { available: false, reason: 'Firecracker rootfs directory not found' };
  }

  const rootfsFiles = fs.readdirSync(rootfsDir).filter(f => f.endsWith('.ext4'));
  if (rootfsFiles.length === 0) {
    return { available: false, reason: 'No Firecracker rootfs images found' };
  }

  return { available: true, reason: null };
}

/**
 * Get the appropriate executor based on configuration and system capabilities
 */
export function getExecutor() {
  if (executorInstance) {
    return executorInstance;
  }

  const configuredType = config.executor?.type || 'auto';

  if (configuredType === 'firecracker') {
    // Forced Firecracker mode
    const fc = isFirecrackerAvailable();
    if (!fc.available) {
      throw new Error(`Firecracker requested but not available: ${fc.reason}`);
    }
    executorType = 'firecracker';
    executorInstance = new FirecrackerExecutor();
  } else if (configuredType === 'docker') {
    // Forced Docker mode
    executorType = 'docker';
    executorInstance = new DockerExecutor();
  } else {
    // Auto-detect: prefer Firecracker if available
    const fc = isFirecrackerAvailable();
    if (fc.available) {
      executorType = 'firecracker';
      executorInstance = new FirecrackerExecutor();
      logger.info('Auto-selected Firecracker executor (faster, stronger isolation)');
    } else {
      executorType = 'docker';
      executorInstance = new DockerExecutor();
      logger.info({ reason: fc.reason }, 'Auto-selected Docker executor');
    }
  }

  logger.info({ executorType }, 'Executor initialized');
  return executorInstance;
}

/**
 * Get the current executor type
 */
export function getExecutorType() {
  if (!executorType) {
    getExecutor(); // Initialize
  }
  return executorType;
}

/**
 * Check system capabilities and return info
 */
export function getSystemCapabilities() {
  const docker = {
    available: fs.existsSync(config.docker.socketPath),
    socketPath: config.docker.socketPath,
  };

  const firecracker = isFirecrackerAvailable();

  return {
    platform: process.platform,
    arch: process.arch,
    docker,
    firecracker: {
      available: firecracker.available,
      reason: firecracker.reason,
    },
    recommended: firecracker.available ? 'firecracker' : 'docker',
    current: executorType || 'not initialized',
  };
}

export default {
  getExecutor,
  getExecutorType,
  getSystemCapabilities,
};
