import { describe, it, expect } from 'vitest';
import { isPrivateOrReservedIp, isDeliverableUrl } from './ssrf';

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1',
      '172.32.0.1',
      '93.184.216.34',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local IPv6 and IPv4-mapped privates', () => {
    for (const ip of [
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12::34',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });

  it('flags IPv4-mapped in hex, IPv4-compatible and NAT64 forms of private IPv4', () => {
    for (const ip of [
      // What the URL parser writes for [::ffff:127.0.0.1] / [::ffff:169.254.169.254].
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '::ffff:0a00:0005',
      '0:0:0:0:0:ffff:c0a8:0101',
      '::ffff:169.254.169.254',
      // IPv4-compatible.
      '::7f00:1',
      '::a9fe:a9fe',
      '::127.0.0.1',
      // NAT64 well-known prefix and local-use NAT64.
      '64:ff9b::7f00:1',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::10.0.0.1',
      '64:ff9b:1::808:808',
      // Unspecified in long form, and garbage.
      '0:0:0:0:0:0:0:0',
      'zz::1',
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });

  it('allows the same forms when the embedded IPv4 is public', () => {
    for (const ip of ['::ffff:808:808', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(false);
    }
  });
});

describe('isDeliverableUrl', () => {
  it('rejects literal private IPs and internal names without DNS', async () => {
    expect(await isDeliverableUrl('https://127.0.0.1/hook')).toBe(false);
    expect(
      await isDeliverableUrl('https://169.254.169.254/latest/meta-data')
    ).toBe(false);
    expect(await isDeliverableUrl('https://[::1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://localhost/hook')).toBe(false);
    expect(await isDeliverableUrl('https://foo.internal/hook')).toBe(false);
    // The parser rewrites these to hex (`[::ffff:7f00:1]`, `[::ffff:a9fe:a9fe]`).
    expect(await isDeliverableUrl('https://[::ffff:127.0.0.1]/hook')).toBe(
      false
    );
    expect(
      await isDeliverableUrl('https://[::ffff:169.254.169.254]/latest')
    ).toBe(false);
    expect(await isDeliverableUrl('https://[::127.0.0.1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://[64:ff9b::a9fe:a9fe]/hook')).toBe(
      false
    );
  });

  it('rejects a malformed URL', async () => {
    expect(await isDeliverableUrl('not a url')).toBe(false);
  });

  it('allows a literal public IP', async () => {
    expect(await isDeliverableUrl('https://8.8.8.8/hook')).toBe(true);
  });
});
