import os from 'os';
import path from 'path';
import { ProfileError } from '../errors.js';

const STATE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function getStealthHome() {
  return process.env.STEALTH_HOME || path.join(os.homedir(), '.stealth');
}

export function getProfilesDir() {
  return path.join(getStealthHome(), 'profiles');
}

export function getSessionsDir() {
  return path.join(getStealthHome(), 'sessions');
}

export function getStateLocksDir() {
  return path.join(getStealthHome(), 'locks');
}

export function assertStateName(name, kind) {
  if (typeof name !== 'string' || !STATE_NAME_PATTERN.test(name)) {
    throw new ProfileError(
      `${kind} name must contain only letters, numbers, underscores, and hyphens`,
    );
  }
  return name;
}
