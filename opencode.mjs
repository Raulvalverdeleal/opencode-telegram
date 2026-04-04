import 'dotenv/config';
import { spawn } from 'node:child_process';

const baseUrl = process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4096';
const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
const password = process.env.OPENCODE_SERVER_PASSWORD || '';

if (!password) {
	console.error('Missing OPENCODE_SERVER_PASSWORD in .env');
	process.exit(1);
}

let hostname = '127.0.0.1';
let port = '4096';

try {
	const url = new URL(baseUrl);
	hostname = url.hostname || hostname;
	port = url.port || port;
} catch {
	console.error(`Invalid OPENCODE_BASE_URL: ${baseUrl}`);
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
