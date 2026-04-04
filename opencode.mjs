import { spawn } from 'node:child_process';
import { loadConfig } from './src/config.mjs';

let config;
try {
	config = await loadConfig();
} catch (error) {
	console.error(error.message);
	process.exit(1);
}

const { BASE_URL: baseUrl, USERNAME: username, PASSWORD: password } = config;

let hostname = '127.0.0.1';
let port = '4096';

try {
	const url = new URL(baseUrl);
	hostname = url.hostname || hostname;
	port = url.port || port;
} catch {
	console.error(`Invalid baseUrl in config: ${baseUrl}`);
	process.exit(1);
}

const extraArgs = process.argv.slice(2);
const args = ['serve', '--hostname', hostname, '--port', port, ...extraArgs];

console.log(`Starting opencode serve on ${hostname}:${port}`);

const child = spawn('opencode', args, {
	stdio: 'inherit',
	env: {
		...process.env,
		OPENCODE_SERVER_USERNAME: username,
		OPENCODE_SERVER_PASSWORD: password,
	},
});

child.on('error', error => {
	console.error(`Failed to start opencode: ${error.message}`);
	process.exit(1);
});

child.on('exit', code => {
	process.exit(code ?? 0);
});
