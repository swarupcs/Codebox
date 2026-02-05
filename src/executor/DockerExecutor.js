import Docker from 'dockerode';
import { Readable } from 'stream';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { getStatusById } from '../languages/index.js';
import ResultParser from './ResultParser.js';

class DockerExecutor {
  constructor() {
    this.docker = new Docker({ socketPath: config.docker.socketPath });
    this.resultParser = new ResultParser();
  }

  /**
   * Execute a submission
   * @param {object} submission - The submission object
   * @returns {object} Execution result
   */
  async execute(submission) {
    const { language } = submission;
    let container = null;

    try {
      // Create container with security limits
      container = await this.createContainer(submission);

      // Start container
      await container.start();

      // Copy source code to container
      await this.copySourceCode(container, submission);

      // If compiled language, run compilation first
      if (language.compile_cmd) {
        const compileResult = await this.runCommand(
          container,
          language.compile_cmd,
          submission.compiler_options,
          submission.cpu_time_limit + submission.cpu_extra_time,
          ''
        );

        if (compileResult.exitCode !== 0) {
          return {
            status: getStatusById(6), // Compilation Error
            compile_output: compileResult.stderr || compileResult.stdout,
            time: null,
            wall_time: null,
            memory: null,
            stdout: null,
            stderr: null,
            exit_code: compileResult.exitCode,
            exit_signal: null,
          };
        }
      }

      // Run the program
      const runCmd = this.buildRunCommand(language.run_cmd, submission.command_line_arguments);
      const result = await this.runCommand(
        container,
        runCmd,
        null,
        submission.wall_time_limit,
        submission.stdin
      );

      // Parse and return result
      return this.resultParser.parse(result, submission);
    } catch (error) {
      logger.error({
        event: 'execution_error',
        token: submission.token,
        error: error.message,
      });

      return {
        status: getStatusById(13), // Internal Error
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
      // Cleanup container
      if (container) {
        try {
          await container.stop({ t: 1 }).catch(() => {});
          await container.remove({ force: true });
        } catch (err) {
          logger.warn({ err }, 'Failed to cleanup container');
        }
      }
    }
  }

  /**
   * Create a Docker container with security limits
   */
  async createContainer(submission) {
    const { language, memory_limit, max_processes_and_or_threads, enable_network } = submission;

    const containerConfig = {
      Image: language.image,
      Cmd: ['/bin/sh', '-c', 'sleep 3600'], // Keep container alive
      WorkingDir: '/box',
      // User is set in Dockerfile for each language image
      NetworkDisabled: !enable_network,
      HostConfig: {
        Memory: memory_limit * 1024, // Convert KB to bytes
        MemorySwap: memory_limit * 1024, // Disable swap
        CpuPeriod: 100000,
        CpuQuota: 100000, // 1 CPU
        PidsLimit: max_processes_and_or_threads,
        NetworkMode: enable_network ? 'bridge' : 'none',
        ReadonlyRootfs: false, // Need write for compilation
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        Tmpfs: {
          '/tmp': 'rw,noexec,nosuid,size=64m',
        },
        Binds: [],
      },
      Tty: false,
      OpenStdin: true,
      StdinOnce: true,
    };

    return await this.docker.createContainer(containerConfig);
  }

  /**
   * Copy source code into the container
   */
  async copySourceCode(container, submission) {
    const { language, source_code } = submission;
    const fileName = language.source_file;

    // Create a tar archive with the source file
    const tarStream = this.createTarStream(fileName, source_code);

    await container.putArchive(tarStream, { path: '/box' });
  }

  /**
   * Create a simple tar stream with a single file
   */
  createTarStream(fileName, content) {
    const contentBuffer = Buffer.from(content, 'utf-8');
    const fileNameBuffer = Buffer.from(fileName);

    // TAR header (512 bytes)
    const header = Buffer.alloc(512, 0);

    // File name (0-99)
    fileNameBuffer.copy(header, 0, 0, Math.min(fileNameBuffer.length, 100));

    // File mode (100-107) - 0644 (world readable)
    Buffer.from('0000644\0').copy(header, 100);

    // UID (108-115) - root
    Buffer.from('0000000\0').copy(header, 108);

    // GID (116-123) - root
    Buffer.from('0000000\0').copy(header, 116);

    // File size in octal (124-135)
    const sizeOctal = contentBuffer.length.toString(8).padStart(11, '0') + '\0';
    Buffer.from(sizeOctal).copy(header, 124);

    // Modification time (136-147)
    const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
    Buffer.from(mtime).copy(header, 136);

    // Checksum placeholder (148-155) - spaces
    Buffer.from('        ').copy(header, 148);

    // Type flag (156) - '0' for regular file
    header[156] = 48; // ASCII '0'

    // Calculate checksum
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }
    const checksumOctal = checksum.toString(8).padStart(6, '0') + '\0 ';
    Buffer.from(checksumOctal).copy(header, 148);

    // Content padding (512-byte blocks)
    const paddingSize = 512 - (contentBuffer.length % 512);
    const contentPadding = paddingSize < 512 ? Buffer.alloc(paddingSize, 0) : Buffer.alloc(0);

    // End of archive (two 512-byte zero blocks)
    const endBlocks = Buffer.alloc(1024, 0);

    // Combine all parts
    const tarBuffer = Buffer.concat([header, contentBuffer, contentPadding, endBlocks]);

    return Readable.from(tarBuffer);
  }

  /**
   * Build run command with arguments
   */
  buildRunCommand(baseCmd, args) {
    if (!args) return baseCmd;
    return `${baseCmd} ${args}`;
  }

  /**
   * Run a command inside the container
   */
  async runCommand(container, command, extraOptions, timeoutSecs, stdin) {
    const startTime = Date.now();
    const startMemory = process.memoryUsage().heapUsed;

    // Create exec instance
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: !!stdin,
      WorkingDir: '/box',
    });

    return new Promise((resolve, reject) => {
      const timeoutMs = timeoutSecs * 1000;
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        // Kill the container to stop execution
        container.kill().catch(() => {});
      }, timeoutMs);

      exec.start({ hijack: true, stdin: !!stdin }, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          return reject(err);
        }

        // Send stdin if provided
        if (stdin) {
          stream.write(stdin);
          stream.end();
        }

        // Demux stdout and stderr
        const stdoutChunks = [];
        const stderrChunks = [];

        stream.on('data', (chunk) => {
          // Docker multiplexes stdout/stderr with 8-byte header
          // Header: [stream type (1 byte), 0, 0, 0, size (4 bytes)]
          let offset = 0;
          while (offset < chunk.length) {
            if (offset + 8 > chunk.length) break;

            const streamType = chunk[offset];
            const size = chunk.readUInt32BE(offset + 4);

            if (offset + 8 + size > chunk.length) break;

            const data = chunk.slice(offset + 8, offset + 8 + size);

            if (streamType === 1) {
              stdoutChunks.push(data);
            } else if (streamType === 2) {
              stderrChunks.push(data);
            }

            offset += 8 + size;
          }
        });

        stream.on('end', async () => {
          clearTimeout(timeout);

          stdout = Buffer.concat(stdoutChunks).toString('utf-8');
          stderr = Buffer.concat(stderrChunks).toString('utf-8');

          const endTime = Date.now();
          const wallTime = (endTime - startTime) / 1000;

          // Get exit code
          let exitCode = 0;
          try {
            const inspection = await exec.inspect();
            exitCode = inspection.ExitCode;
          } catch (e) {
            exitCode = timedOut ? 124 : -1;
          }

          resolve({
            stdout,
            stderr,
            exitCode,
            wallTime,
            time: wallTime, // Approximate CPU time
            memory: null, // Would need cgroup stats for accurate memory
            timedOut,
          });
        });

        stream.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    });
  }
}

export default DockerExecutor;
