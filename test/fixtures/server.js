"use strict";

const http = require("node:http");

// Read token from args to satisfy the allowlist requirement
const token = process.argv[2];
if (!token) {
  process.exit(0);
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end(`Fixture running with token: ${token}\n`);
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log(`LISTENING:${port}`);
});

process.on("SIGINT", () => {
  console.log("RECEIVED_SIGINT");
  server.close(() => {
    console.log("SERVER_CLOSED");
    process.exit(0);
  });
});
