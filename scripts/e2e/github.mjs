/**
 * Reliable subprocess boundary for GitHub CLI and local commands.
 *
 * Every gh invocation in the release suite goes through createGhClient().
 * Native executables are spawned without a shell; the sole Windows shell
 * exception is the controlled npm.cmd/npm.bat wrapper used for local gates.
 * Output is captured for diagnostics, every call has a timeout, and secrets
 * are never included in errors because arguments are redacted before rendering.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

export class E2EError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'E2EError';
  }
}

export class ProcessError extends E2EError {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProcessError';
    Object.assign(this, details);
  }
}

function commandFor(program) {
  if (process.platform !== 'win32') return program;
  if (program === 'gh') return 'gh.exe';
  if (program === 'npm') return 'npm.cmd';
  return program;
}

function usesControlledWindowsShell(program, executable) {
  const npmProgram = program === 'npm' || /^(?:npm\.(?:cmd|bat))$/i.test(program);
  return process.platform === 'win32'
    && npmProgram
    && /\.(?:cmd|bat)$/i.test(executable);
}

function safeArgs(args) {
  return args.map((arg) => {
    const value = String(arg);
    if (/token|password|secret|authorization/i.test(value)) return '<redacted>';
    return value;
  });
}

function commandText(program, args) {
  return [program, ...safeArgs(args)].join(' ');
}

function diagnostic(value, redact) {
  return redact ? '<redacted>' : value.trim() || '(empty)';
}

/** Run one executable without a shell and reject with stdout/stderr context. */
export function runProcess(program, args = [], options = {}) {
  const timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new ProcessError(`${program} requires a positive timeoutMs`));
  }
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const executable = options.executable ?? commandFor(program);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args.map(String), {
        cwd,
        env,
        // Windows cannot directly execute command scripts with shell:false.
        // Only the fixed npm run <script> boundary is allowed to use a shell;
        // gh.exe, git, and every other executable remain shell-free.
        shell: usesControlledWindowsShell(program, executable),
        windowsHide: true,
      });
    } catch (error) {
      reject(new ProcessError(`failed to start ${commandText(program, args)} in ${cwd}: ${error.message}`, { cause: error }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ProcessError(`failed to run ${commandText(program, args)} in ${cwd}: ${error.message}`, {
        cause: error,
        program,
        args,
        cwd,
        stdout: options.redactOutput ? '<redacted>' : stdout,
        stderr: options.redactOutput ? '<redacted>' : stderr,
      }));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { program, args: [...args], cwd, code, signal, stdout, stderr };
      const stdoutDiagnostic = diagnostic(stdout, options.redactOutput === true);
      const stderrDiagnostic = diagnostic(stderr, options.redactOutput === true);
      if (timedOut) {
        reject(new ProcessError(
          `timed out after ${timeoutMs}ms: ${commandText(program, args)} (cwd ${cwd}); ` +
            `stdout: ${stdoutDiagnostic}; stderr: ${stderrDiagnostic}`,
          {
            ...result,
            stdout: options.redactOutput ? '<redacted>' : stdout,
            stderr: options.redactOutput ? '<redacted>' : stderr,
            timedOut: true,
          },
        ));
        return;
      }
      if (code !== 0) {
        reject(new ProcessError(
          `command failed with exit code ${code ?? 'unknown'}: ${commandText(program, args)} (cwd ${cwd}); ` +
            `stdout: ${stdoutDiagnostic}; stderr: ${stderrDiagnostic}`,
          {
            ...result,
            stdout: options.redactOutput ? '<redacted>' : stdout,
            stderr: options.redactOutput ? '<redacted>' : stderr,
            exitCode: code,
          },
        ));
        return;
      }
      resolve(result);
    });
  });
}

export function createGhClient({
  runProcess: runner = runProcess,
  command = 'gh',
  defaultTimeoutMs,
  defaultEnv,
} = {}) {
  const call = async (args, options = {}) => {
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ProcessError(`gh ${args.join(' ')} requires a positive timeoutMs`);
    }
    return runner(command, args, { env: defaultEnv, ...options, timeoutMs });
  };

  return {
    run: call,
    async text(args, options = {}) {
      return (await call(args, { ...options, redactOutput: options.sensitive === true })).stdout.trim();
    },
    async json(args, options = {}) {
      const result = await call(args, options);
      try {
        return JSON.parse(result.stdout);
      } catch (error) {
        throw new ProcessError(
          `gh returned invalid JSON for "${commandText(command, args)}": ${error.message}; ` +
            `stdout: ${result.stdout.trim() || '(empty)'}; stderr: ${result.stderr.trim() || '(empty)'}`,
          { cause: error, result },
        );
      }
    },
  };
}
