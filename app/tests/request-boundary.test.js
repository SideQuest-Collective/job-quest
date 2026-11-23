const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequestBoundary } = require('../lib/feedback/boundary');

// Model Tailscale's documented HTTP Serve proxy, not a real tailnet connection.
// Primary source: tailscale/tailscale ipn/ipnlocal/serve.go, reverseProxy.ServeHTTP,
// addProxyForwardedHeaders, and addTailscaleIdentityHeaders.
const origin = 'https://device.example.ts.net';
const owner = 'owner@example.test';
const serveHeaders = {
  host: 'device.example.ts.net', origin,
  'x-forwarded-host': 'device.example.ts.net', 'x-forwarded-proto': 'https',
  'x-forwarded-for': '100.100.10.20', 'tailscale-user-login': owner,
  'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': '2',
};
function check(headers, method = 'POST', remoteAddress = '127.0.0.1') {
  let status = 200, reached = false;
  createRequestBoundary({ origins: origin, tailscaleUser: owner })({headers,method,socket:{localPort:3847,remoteAddress},is:(type)=>headers['content-type']===type},
    {status:(n)=>{status=n;return {json:()=>{}};}},()=>{reached=true;});
  return {status,reached};
}

test('documented HTTP Serve request headers allow owner GETs and same-origin JSON writes', () => {
  assert.equal(check(serveHeaders).reached,true);
  assert.equal(check({...serveHeaders,origin:undefined,'sec-fetch-site':undefined},'GET').reached,true);
  assert.equal(check({...serveHeaders,origin:undefined},'POST').status,403);
});

test('canonical HTTPS authority accepts explicit default port but rejects a different port or scheme', () => {
  assert.equal(check({...serveHeaders,host:'device.example.ts.net:443','x-forwarded-host':'device.example.ts.net:443'}).reached,true);
  assert.equal(check({...serveHeaders,host:'device.example.ts.net:80'}).status,403);
  assert.equal(check({...serveHeaders,host:'device.example.ts.net:444'}).status,403);
  assert.equal(check({...serveHeaders,origin:'http://device.example.ts.net'}).status,403);
});

test('tagged devices, Funnel, wrong users and direct tailnet sockets never reach routes', () => {
  for(const login of [undefined,'other@example.test',owner+',other@example.test']) assert.equal(check({...serveHeaders,'tailscale-user-login':login}).status,403);
  assert.equal(check({...serveHeaders,'tailscale-user-login':undefined,'tailscale-funnel-request':'?1'}).status,403);
  assert.equal(check(serveHeaders,'POST','100.100.10.20').status,403);
});

test('client-supplied localhost Host cannot bypass proxy identity and hostile origin checks', () => {
  assert.equal(check({...serveHeaders,host:'127.0.0.1:3847','x-forwarded-host':'127.0.0.1:3847','tailscale-user-login':undefined,origin:undefined},'GET').status,403);
  assert.equal(check({...serveHeaders,origin:'https://evil.example'}).status,403);
  assert.equal(check({...serveHeaders,'sec-fetch-site':'cross-site'}).status,403);
  assert.equal(check({...serveHeaders,'content-type':'text/plain'}).status,415);
});
