import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientAddress } from "../src/infrastructure/abuse/clientAddress.js";

describe("clientAddress (SEG-3, reusable for non-repudiation)", () => {
  it("uses the socket address when no proxy is trusted, whatever the header says", () => {
    assert.equal(clientAddress("203.0.113.9", "1.2.3.4", 0), "203.0.113.9");
  });

  it("takes the address the trusted proxy saw, not what the client wrote", () => {
    // One proxy (the load balancer at 10.0.0.2) appended the address it received the request from.
    assert.equal(clientAddress("10.0.0.2", "198.51.100.7", 1), "198.51.100.7");
    // The client tried to pass itself off as 1.2.3.4; the proxy still appended the real address.
    assert.equal(clientAddress("10.0.0.2", "1.2.3.4, 198.51.100.7", 1), "198.51.100.7");
  });

  it("walks back one entry per trusted proxy", () => {
    // Client -> ingress (adds the client) -> gateway (adds the ingress) -> service.
    assert.equal(clientAddress("10.0.0.3", "198.51.100.7, 10.0.0.2", 2), "198.51.100.7");
  });

  it("stops at the first entry when there are fewer entries than trusted proxies", () => {
    assert.equal(clientAddress("10.0.0.2", undefined, 3), "10.0.0.2");
    assert.equal(clientAddress("10.0.0.2", "198.51.100.7", 5), "198.51.100.7");
  });

  it("accepts the header as several values and normalizes IPv4-mapped addresses", () => {
    assert.equal(clientAddress("::ffff:10.0.0.2", ["198.51.100.7", "::ffff:10.0.0.9"], 2), "198.51.100.7");
    assert.equal(clientAddress("::ffff:127.0.0.1", undefined, 0), "127.0.0.1");
    assert.equal(clientAddress("::1", undefined, 0), "::1");
  });

  it("falls back to the socket address when the chosen entry is not an IP address", () => {
    assert.equal(clientAddress("10.0.0.2", "not-an-ip", 1), "10.0.0.2");
    assert.equal(clientAddress(undefined, undefined, 0), "unknown");
  });
});
