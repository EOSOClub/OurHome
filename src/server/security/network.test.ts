import { describe, expect, it } from 'vitest';
import {
  hostnameOf,
  isFromLocalNetwork,
  isHttpsRequest,
  isLocalHostname,
  isLoopbackHost,
  isPrivateIp,
} from './network';

describe('isPrivateIp', () => {
  it.each([
    '10.0.0.5',
    '127.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '169.254.1.1',
    '100.101.102.103',
    '::1',
    '[::1]',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:192.168.1.20',
  ])('%s is private', (ip) => expect(isPrivateIp(ip)).toBe(true));

  it.each(['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1', 'example.com'])(
    '%s is not private',
    (ip) => expect(isPrivateIp(ip)).toBe(false),
  );
});

describe('isLocalHostname', () => {
  it.each(['localhost', 'homeserver', 'nas.local', 'pi.lan', 'box.home.arpa', '192.168.1.20', '[::1]'])(
    '%s is local',
    (host) => expect(isLocalHostname(host)).toBe(true),
  );
  it.each(['home.example.com', '8.8.8.8', '[2606:4700::1]'])('%s is not local', (host) =>
    expect(isLocalHostname(host)).toBe(false),
  );
});

describe('hostnameOf / isLoopbackHost', () => {
  it('strips the port', () => {
    expect(hostnameOf('192.168.1.20:3000')).toBe('192.168.1.20');
    expect(hostnameOf('[::1]:3000')).toBe('::1');
    expect(hostnameOf('Home.Example.com')).toBe('home.example.com');
  });
  it.each(['localhost', 'app.localhost', '127.0.0.1', '::1', '[::1]'])('%s is loopback', (h) =>
    expect(isLoopbackHost(h)).toBe(true),
  );
  it.each(['192.168.1.20', 'homeserver', 'localhost.example.com'])('%s is not loopback', (h) =>
    expect(isLoopbackHost(h)).toBe(false),
  );
});

describe('isHttpsRequest', () => {
  it('trusts the forwarded scheme', () => {
    expect(isHttpsRequest(new Headers({ 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(isHttpsRequest(new Headers({ 'cf-visitor': '{"scheme":"https"}' }))).toBe(true);
    expect(isHttpsRequest(new Headers({ 'x-forwarded-proto': 'http' }))).toBe(false);
    expect(isHttpsRequest(new Headers(), 'https://home.example.com/')).toBe(true);
  });
});

describe('isFromLocalNetwork', () => {
  it('accepts direct and LAN-forwarded requests', () => {
    expect(isFromLocalNetwork(new Headers())).toBe(true);
    expect(isFromLocalNetwork(new Headers({ 'x-forwarded-for': '192.168.1.40' }))).toBe(true);
    expect(isFromLocalNetwork(new Headers({ 'x-forwarded-for': '172.18.0.1, 10.0.0.2' }))).toBe(true);
  });
  it('rejects anything that came from the internet', () => {
    expect(isFromLocalNetwork(new Headers({ 'cf-connecting-ip': '192.168.1.40' }))).toBe(false);
    expect(isFromLocalNetwork(new Headers({ 'x-forwarded-for': '192.168.1.40, 203.0.113.9' }))).toBe(false);
    expect(isFromLocalNetwork(new Headers({ 'x-real-ip': '203.0.113.9' }))).toBe(false);
    // A spoofed private x-forwarded-for doesn't hide the proxy's real x-real-ip.
    expect(
      isFromLocalNetwork(
        new Headers({ 'x-forwarded-for': '192.168.1.40', 'x-real-ip': '203.0.113.9' }),
      ),
    ).toBe(false);
    expect(isFromLocalNetwork(new Headers({ forwarded: 'for=203.0.113.9;proto=https' }))).toBe(false);
    expect(isFromLocalNetwork(new Headers({ forwarded: 'for="[2001:db8::1]:443"' }))).toBe(false);
    expect(isFromLocalNetwork(new Headers({ forwarded: 'for=192.168.1.40:5000' }))).toBe(true);
  });
});
