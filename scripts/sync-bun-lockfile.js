const { execSync } = require("child_process");

// Prevent infinite loop: use a sentinel env var.
// When npm runs postinstall, we spawn `bun install`. Bun then runs
// postinstall again — the sentinel tells us we're already syncing.
if (process.env.DEVDB_BUN_SYNC) {
	process.exit(0);
}

try {
	execSync("bun install", {
		stdio: "inherit",
		env: { ...process.env, DEVDB_BUN_SYNC: "1" },
	});
} catch {
	console.warn("Could not sync bun.lockb (is bun installed?)");
}
