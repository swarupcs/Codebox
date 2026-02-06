import { spawn, execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { promisify } from 'util';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { getStatusById } from '../languages/index.js';
import ResultParser from './ResultParser.js';

const execFileAsync = promisify(execFile);

const FC_BASE_DIR = '/var/lib/codebox/firecracker';
const KERNEL_PATH = `${FC_BASE_DIR}/kernels/vmlinux`;
const ROOTFS_DIR = `${FC_BASE_DIR}/rootfs`;
const SOCKETS_DIR = `${FC_BASE_DIR}/sockets`;

const MULTI_FILE_LANGUAGE_ID = 89;

// Map language images to rootfs names
const IMAGE_TO_ROOTFS = {
  'codebox/python:3.8': 'python',
  'codebox/node:18': 'node',
  'codebox/gcc:9': 'gcc',
  'codebox/java:17': 'java',
  'codebox/typescript:5': 'typescript',
  'codebox/multi:latest': 'multi',
};

class FirecrackerExecutor {
  constructor() {
    this.resultParser = new ResultParser();
  }

  /**
   * Execute a submission using Firecracker microVM
   */
  async execute(submission) {
    const { language } = submission;
    const vmId = uuidv4().slice(0, 8);
    const socketPath = `${SOCKETS_DIR}/${vmId}.sock`;
    const rootfsName = IMAGE_TO_ROOTFS[language.image];

    if (!rootfsName) {
      return {
        status: getStatusById(13),
        message: `No rootfs found for image: ${language.image}`,
        time: null,
        wall_time: null,
        memory: null,
        stdout: null,
        stderr: null,
        compile_output: null,
        exit_code: null,
        exit_signal: null,
      };
    }

    let fcProcess = null;

    try {
      // Create a copy-on-write overlay for the rootfs
      const overlayPath = await this.createOverlay(vmId, rootfsName);

      // Write source code to overlay
      await this.writeSourceCode(overlayPath, submission);

      // Create Firecracker config
      const fcConfig = this.createConfig(vmId, overlayPath, submission);
      const configPath = `${SOCKETS_DIR}/${vmId}-config.json`;
      await fs.writeFile(configPath, JSON.stringify(fcConfig, null, 2));

      // Start Firecracker
      fcProcess = await this.startFirecracker(vmId, socketPath, configPath);

      // Wait for boot and execute
      const result = await this.executeInVm(
        socketPath,
        submission,
        fcProcess
      );

      return this.resultParser.parse(result, submission);
    } catch (error) {
      logger.error({
        event: 'firecracker_execution_error',
        token: submission.token,
        error: error.message,
      });

      return {
        status: getStatusById(13),
        message: error.message,
        time: null,
        wall_time: null,
        memory: null,
        stdout: null,
        stderr: null,
        compile_output: null,
        exit_code: null,
        exit_signal: null,
      };
    } finally {
      // Cleanup
      await this.cleanup(vmId, fcProcess);
    }
  }

  /**
   * Create a copy-on-write overlay for the rootfs
   */
  async createOverlay(vmId, rootfsName) {
    const baseRootfs = `${ROOTFS_DIR}/${rootfsName}.ext4`;
    const overlayPath = `${SOCKETS_DIR}/${vmId}-rootfs.ext4`;

    // Create a sparse copy (copy-on-write)
    await this.runCommand('cp', ['--reflink=auto', baseRootfs, overlayPath]);

    return overlayPath;
  }

  /**
   * Write source code to the overlay rootfs
   */
  async writeSourceCode(overlayPath, submission) {
    const { language, source_code, stdin } = submission;
    const mountDir = `${SOCKETS_DIR}/mount-${path.basename(overlayPath, '.ext4')}`;

    await fs.mkdir(mountDir, { recursive: true });

    // Mount the overlay
    await this.runCommand('sudo', ['mount', '-o', 'loop', overlayPath, mountDir]);

    try {
      // Write source code (skip for multi-file programs)
      if (language.id !== MULTI_FILE_LANGUAGE_ID && source_code) {
        const sourcePath = `${mountDir}/box/${language.source_file}`;
        await fs.writeFile(sourcePath, source_code);
        await this.runCommand('sudo', ['chown', '1001:1001', sourcePath]);
      }

      // Write stdin if provided
      if (stdin) {
        const stdinPath = `${mountDir}/box/stdin.txt`;
        await fs.writeFile(stdinPath, stdin);
        await this.runCommand('sudo', ['chown', '1001:1001', stdinPath]);
      }

      // Extract additional files (base64-encoded ZIP) if provided
      if (submission.additional_files) {
        await this.writeAdditionalFiles(`${mountDir}/box`, submission);
      }

      // Write execution script
      const script = this.createExecutionScript(submission);
      const scriptPath = `${mountDir}/box/run.sh`;
      await fs.writeFile(scriptPath, script);
      await this.runCommand('sudo', ['chmod', '+x', scriptPath]);
      await this.runCommand('sudo', ['chown', '1001:1001', scriptPath]);
    } finally {
      // Unmount
      await this.runCommand('sudo', ['umount', mountDir]);
      await fs.rmdir(mountDir);
    }
  }

  /**
   * Write additional files (base64-encoded ZIP) to the box directory
   */
  async writeAdditionalFiles(boxDir, submission) {
    const tmpZip = `${boxDir}/_additional.zip`;

    try {
      const zipBuffer = Buffer.from(submission.additional_files, 'base64');

      await fs.writeFile(tmpZip, zipBuffer);

      // Check for path traversal attempts before extracting
      const { stdout: listing } = await execFileAsync('unzip', ['-l', tmpZip]);
      if (listing.includes('../') || listing.includes('/..')) {
        throw new Error('ZIP archive contains path traversal entries');
      }

      await execFileAsync('unzip', ['-n', '-qq', tmpZip, '-d', boxDir]);
      await this.runCommand('sudo', ['chown', '-R', '1001:1001', boxDir]);
      await fs.unlink(tmpZip);

      logger.info({
        event: 'additional_files_extracted',
        token: submission.token,
        size: zipBuffer.length,
      });
    } catch (error) {
      // Clean up temp file on failure
      try { await fs.unlink(tmpZip); } catch {}
      logger.error({
        event: 'additional_files_extract_failed',
        token: submission.token,
        error: error.message,
      });
      throw new Error(`Failed to extract additional files: ${error.message}`);
    }
  }

  /**
   * Create the execution script that runs inside the VM
   */
  createExecutionScript(submission) {
    const { language, stdin } = submission;
    const stdinRedirect = stdin ? '< /box/stdin.txt' : '';

    let script = '#!/bin/sh\n';
    script += 'cd /box\n';
    script += 'exec 2>&1\n'; // Redirect stderr to stdout for capture

    if (language.id === MULTI_FILE_LANGUAGE_ID) {
      // Multi-file program: use compile/run scripts from ZIP
      script += 'if [ ! -f /box/run ]; then\n';
      script += '  echo "Multi-file program requires a \\"run\\" script in the ZIP archive" >&2\n';
      script += '  exit 100\n';
      script += 'fi\n';
      script += 'if [ -f /box/compile ]; then\n';
      script += '  bash /box/compile 2>/box/compile_error.txt\n';
      script += '  if [ $? -ne 0 ]; then\n';
      script += '    cat /box/compile_error.txt\n';
      script += '    exit 100\n';
      script += '  fi\n';
      script += 'fi\n';
      script += `timeout ${submission.wall_time_limit} bash /box/run ${stdinRedirect}\n`;
      script += 'exit $?\n';
    } else {
      // Standard language: use compile_cmd/run_cmd from language config
      if (language.compile_cmd) {
        script += `${language.compile_cmd} 2>/box/compile_error.txt\n`;
        script += 'if [ $? -ne 0 ]; then\n';
        script += '  cat /box/compile_error.txt\n';
        script += '  exit 100\n'; // Special exit code for compilation error
        script += 'fi\n';
      }

      // Run step
      script += `timeout ${submission.wall_time_limit} ${language.run_cmd} ${stdinRedirect}\n`;
      script += 'exit $?\n';
    }

    return script;
  }

  /**
   * Create Firecracker VM configuration
   */
  createConfig(vmId, rootfsPath, submission) {
    const effectiveMemory = Math.max(submission.memory_limit, submission.language.min_memory || 0);
    const memSizeMib = Math.ceil(effectiveMemory / 1024); // Convert KB to MB

    return {
      'boot-source': {
        kernel_image_path: KERNEL_PATH,
        boot_args: 'console=ttyS0 reboot=k panic=1 pci=off init=/box/run.sh',
      },
      'drives': [
        {
          drive_id: 'rootfs',
          path_on_host: rootfsPath,
          is_root_device: true,
          is_read_only: false,
        },
      ],
      'machine-config': {
        vcpu_count: 1,
        mem_size_mib: Math.max(memSizeMib, 128), // Minimum 128MB
        smt: false,
      },
      'logger': {
        log_path: `${SOCKETS_DIR}/${vmId}.log`,
        level: 'Warning',
      },
    };
  }

  /**
   * Start Firecracker process
   */
  async startFirecracker(vmId, socketPath, configPath) {
    return new Promise((resolve, reject) => {
      const fc = spawn('firecracker', [
        '--api-sock', socketPath,
        '--config-file', configPath,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      fc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      fc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      fc.on('error', (err) => {
        reject(new Error(`Failed to start Firecracker: ${err.message}`));
      });

      // Give it a moment to start
      setTimeout(() => resolve(fc), 100);
    });
  }

  /**
   * Execute code in the VM and capture output
   */
  async executeInVm(socketPath, submission, fcProcess) {
    const startTime = Date.now();
    const timeoutMs = (submission.wall_time_limit + 2) * 1000; // Add 2s buffer

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let exitCode = 0;

      const timeout = setTimeout(() => {
        timedOut = true;
        fcProcess.kill('SIGKILL');
      }, timeoutMs);

      fcProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      fcProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      fcProcess.on('close', (code) => {
        clearTimeout(timeout);

        const wallTime = (Date.now() - startTime) / 1000;

        // Exit code 100 = compilation error (from our script)
        if (code === 100) {
          exitCode = 100;
        } else {
          exitCode = code || 0;
        }

        resolve({
          stdout,
          stderr,
          exitCode: timedOut ? 124 : exitCode,
          wallTime,
          time: wallTime,
          memory: null,
          timedOut,
        });
      });
    });
  }

  /**
   * Cleanup VM resources
   */
  async cleanup(vmId, fcProcess) {
    try {
      // Kill process if still running
      if (fcProcess && !fcProcess.killed) {
        fcProcess.kill('SIGKILL');
      }

      // Remove socket and config files
      const files = [
        `${SOCKETS_DIR}/${vmId}.sock`,
        `${SOCKETS_DIR}/${vmId}-config.json`,
        `${SOCKETS_DIR}/${vmId}-rootfs.ext4`,
        `${SOCKETS_DIR}/${vmId}.log`,
      ];

      for (const file of files) {
        try {
          await fs.unlink(file);
        } catch (e) {
          // Ignore if doesn't exist
        }
      }
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to cleanup Firecracker VM');
    }
  }

  /**
   * Helper to run a command
   */
  runCommand(cmd, args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Command ${cmd} failed with code ${code}`));
      });
      proc.on('error', reject);
    });
  }
}

export default FirecrackerExecutor;
