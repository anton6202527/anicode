const mode = process.argv[2];

if (mode === "allow") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const payload = JSON.parse(input);
    if (payload.hook_event_name !== "PreToolUse" || payload.toolName !== "bash") {
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      JSON.stringify({ decision: "allow", additionalContext: "来自命令hook" }) + "\n",
    );
  });
} else if (mode === "block") {
  process.stderr.write("危险命令，拒绝\n");
  process.exitCode = 2;
} else if (mode === "context") {
  process.stdout.write("当前分支: main\n");
} else if (mode === "noop") {
  process.stdout.write("oops\n");
  process.exitCode = 3;
} else if (mode === "hang") {
  setInterval(() => {}, 30_000);
} else {
  process.exitCode = 64;
}
