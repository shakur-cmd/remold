// IV r2: host rule table for channel() at 117917d. Asserts what is refused; prints the rest.
import { expect, it } from "vitest";
import { channel } from "./alerts";
it("channel host table", () => {
  const urls = ["https://hooks.example.com/x", "https://localhost./x", "https://foo.localhost./x", "https://metadata.google.internal./x", "https://printer.local./x",
    "https://0x7f.1/x", "https://2130706433/x", "https://017700000001/x", "https://[::ffff:127.0.0.1]/x", "https://[::ffff:a00:1]/x", "https://[0:0:0:0:0:0:0:1]/x",
    "https://[::127.0.0.1]/x", "https://[64:ff9b::a9fe:a9fe]/x", "https://[fe80::1]/x", "https://[fc00::1]/x", "https://198.18.0.1/x", "https://224.0.0.1/x", "https://255.255.255.255/x",
    "https://127.0.0.1.nip.io/x", "https://kubernetes.default.svc/x", "https://169.254.169.254.nip.io/x", "http://localhost./x", "http://127.0.0.1:9@evil.test/x", "https://user@10.0.0.1/x"];
  const t = Object.fromEntries(urls.map((u) => [u, channel(u)]));
  console.log("IV2 channel table", JSON.stringify(t, null, 1));
  for (const bad of ["https://0x7f.1/x", "https://2130706433/x", "https://017700000001/x", "https://[::ffff:127.0.0.1]/x", "https://[::ffff:a00:1]/x", "https://[0:0:0:0:0:0:0:1]/x", "https://[fe80::1]/x", "https://[fc00::1]/x", "http://localhost./x", "http://127.0.0.1:9@evil.test/x", "https://user@10.0.0.1/x"]) expect(t[bad], bad).toBeNull();
});
