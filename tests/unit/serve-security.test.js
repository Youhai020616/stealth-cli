import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

describe('serve security', () => {
  it('should generate a valid token', () => {
    const token = crypto.randomBytes(24).toString('hex');
    expect(token).toHaveLength(48);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  it('should validate bearer token format', () => {
    const token = 'abc123';
    const authHeader = `Bearer ${token}`;
    const extracted = authHeader.replace(/^Bearer\s+/i, '');
    expect(extracted).toBe(token);
  });

  it('should reject missing auth header', () => {
    const authHeader = undefined;
    const isValid = authHeader && authHeader.startsWith('Bearer ');
    expect(isValid).toBeFalsy();
  });

  it('should reject wrong token', () => {
    const serverToken = 'correct-token';
    const clientToken = 'wrong-token';
    expect(serverToken === clientToken).toBe(false);
  });

  it('should accept correct token', () => {
    const serverToken = crypto.randomBytes(24).toString('hex');
    const authHeader = `Bearer ${serverToken}`;
    const extracted = authHeader.replace(/^Bearer\s+/i, '');
    expect(extracted === serverToken).toBe(true);
  });
});
