import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/daemon.js', () => ({
  isDaemonRunning: vi.fn(() => false),
  SOCKET_PATH: '/tmp/test-stealth.sock',
}));

import {
  daemonRequest, daemonNavigate, daemonSnapshot,
  daemonText, daemonScreenshot, daemonTitle,
  daemonEvaluate, daemonStatus, daemonShutdown,
} from '../../src/client.js';
import { isDaemonRunning } from '../../src/daemon.js';

describe('client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('daemonRequest', () => {
    it('should return null when daemon is not running', async () => {
      isDaemonRunning.mockReturnValue(false);
      const result = await daemonRequest('/status');
      expect(result).toBeNull();
    });

    it('should return null for any route when daemon is down', async () => {
      isDaemonRunning.mockReturnValue(false);
      expect(await daemonRequest('/navigate', { url: 'https://example.com' })).toBeNull();
      expect(await daemonRequest('/text')).toBeNull();
      expect(await daemonRequest('/screenshot')).toBeNull();
    });
  });

  describe('convenience methods', () => {
    it('daemonNavigate should return null when daemon not running', async () => {
      isDaemonRunning.mockReturnValue(false);
      const result = await daemonNavigate('https://example.com', { timeout: 5000 });
      expect(result).toBeNull();
    });

    it('daemonSnapshot should return null when daemon not running', async () => {
      isDaemonRunning.mockReturnValue(false);
      expect(await daemonSnapshot()).toBeNull();
    });

    it('daemonText should return null when daemon not running', async () => {
      isDaemonRunning.mockReturnValue(false);
      expect(await daemonText()).toBeNull();
    });

    it('daemonScreenshot should return null when daemon not running', async () => {
      isDaemonRunning.mockReturnValue(false);
      expect(await daemonScreenshot()).toBeNull();
    });

    it('daemonTitle should return null when daemon not running', async () => {
      isDaemonRunning.mockReturnValue(false);
      expect(await daemonTitle()).toBeNull();
    });

    it('daemonEvaluate should return null when daemon not running', async () => {
      isDaemonRunning.mockReturnValue(false);
      expect(await daemonEvaluate('1+1')).toBeNull();
    });

    it('daemonStatus should return null when daemon not running', async () => {
      isDaemonRunning.mockReturnValue(false);
      expect(await daemonStatus()).toBeNull();
    });

    it('daemonShutdown should return null when daemon not running', async () => {
      isDaemonRunning.mockReturnValue(false);
      expect(await daemonShutdown()).toBeNull();
    });
  });
});
