// Preloaded into the server under test (see env.js): captures Brevo email
// and WhatsApp Cloud API calls into log files instead of sending them,
// fakes Paystack's bank account lookup, and blocks any other outside call.
// Addresses containing "fail" get a 500 so we can check email failures
// don't break requests.
const fs = require("fs");
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith("https://api.brevo.com/")) {
    const body = JSON.parse(opts.body);
    if (process.env.EMAIL_LOG) fs.appendFileSync(process.env.EMAIL_LOG, JSON.stringify({ headers: opts.headers, body }) + "\n");
    const fail = body.to[0].email.includes("fail");
    return new Response(fail ? "boom" : JSON.stringify({ messageId: "x" }), { status: fail ? 500 : 201 });
  }
  if (u.startsWith("https://api.paystack.co/bank/resolve")) {
    const acct = new URL(u).searchParams.get("account_number");
    const names = { "0123456789": "BELLO SADE ADUNNI", "0987654321": "OKAFOR CHINEDU" };
    return names[acct]
      ? new Response(JSON.stringify({ status: true, data: { account_name: names[acct] } }), { status: 200 })
      : new Response(JSON.stringify({ status: false, message: "Could not resolve account name" }), { status: 422 });
  }
  if (u.startsWith("https://graph.facebook.com/")) {
    if (process.env.WA_LOG) fs.appendFileSync(process.env.WA_LOG, JSON.stringify({ url: u, headers: opts.headers, body: JSON.parse(opts.body) }) + "\n");
    return new Response(JSON.stringify({ messages: [{ id: "wamid.reply" }] }), { status: 200 });
  }
  // Tests may only talk to the local server; anything else is a bug
  const host = new URL(u).hostname;
  if (host === "localhost" || host === "127.0.0.1") return realFetch(url, opts);
  throw new Error(`Blocked outside network call in tests: ${u}`);
};
