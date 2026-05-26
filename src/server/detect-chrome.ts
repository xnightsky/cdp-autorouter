import {existsSync} from 'node:fs';
import {execSync} from 'node:child_process';

/**
 * Platform-specific candidate paths for Chrome/Chromium executables.
 *
 * Order matters: prefer stable Chrome over Chromium, prefer standard
 * install locations over edge cases.
 */
const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.PROGRAMFILES ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
];

const MACOS_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

const LINUX_COMMANDS = [
  'google-chrome-stable',
  'google-chrome',
  'chromium-browser',
  'chromium',
];

/**
 * Attempt to resolve a command name to an absolute path via `which`.
 * Returns undefined if the command is not found or `which` fails.
 */
function whichSync(command: string): string | undefined {
  try {
    const result = execSync(`which ${command}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Auto-detect a Chrome/Chromium executable on the current platform.
 *
 * Scans well-known install locations and PATH. Returns the first
 * existing executable path, or undefined if none found.
 */
export function detectChromePath(): string | undefined {
  const platform = process.platform;

  if (platform === 'win32') {
    for (const candidate of WINDOWS_CANDIDATES) {
      if (candidate && existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  if (platform === 'darwin') {
    for (const candidate of MACOS_CANDIDATES) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    // Fallback: check PATH
    for (const cmd of LINUX_COMMANDS) {
      const resolved = whichSync(cmd);
      if (resolved) return resolved;
    }
    return undefined;
  }

  // Linux and other unix-like
  for (const cmd of LINUX_COMMANDS) {
    const resolved = whichSync(cmd);
    if (resolved) return resolved;
  }
  return undefined;
}
