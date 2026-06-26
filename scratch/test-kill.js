const { spawn } = require("node:child_process");
const http = require("node:http");

console.log("Starting dummy server...");
const server = http.createServer((req, res) => {
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log("Listening on port:", port);
  console.log("PID:", process.pid);
  
  // Set up exit handlers
  process.on("SIGINT", () => {
    console.log("Got SIGINT gracefully");
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });
});
