const { spawn } = require("node:child_process");
const { join } = require("node:path");

const child = spawn("node", [join(__dirname, "test-kill.js")], {
  stdio: ["pipe", "pipe", "pipe"]
});

child.stdout.on("data", (data) => {
  const line = data.toString();
  console.log("CHILD:", line.trim());
  if (line.includes("PID:")) {
    const pid = child.pid;
    console.log("Driver sending SIGINT to PID:", pid);
    
    const pKill = process.kill;
    pKill(pid, "SIGINT");
  }
});

child.stderr.on("data", (data) => {
  console.log("CHILD ERR:", data.toString().trim());
});

child.on("exit", (code, signal) => {
  console.log(`Child exited with code ${code} and signal ${signal}`);
  process.exit(0);
});
