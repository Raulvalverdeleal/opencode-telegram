import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_PATH = join(homedir(), '.config', 'opencode', 'telegram-bot.json');

function parseFingerprintList(value) {
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	if (typeof value === 'string')
		return value
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);
	return [];
}

async function loadConfig() {
	let raw;
	try {
		raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT') {
			throw new Error(
				[
					`Config file not found: ${CONFIG_PATH}`,
					'Create it with the following structure:',
				].join('\n'),
			);
		}
		throw new Error(`Failed to read config ${CONFIG_PATH}: ${error.message}`);
	}

	const BOT_TOKEN = raw.botToken;
	const USERNAME = raw.username;
	const PASSWORD = raw.password;
	const BASE_URL = raw.baseUrl || 'http://127.0.0.1:4096';
	const STORE_PATH = join(homedir(), '.local', 'share', 'opencode', 'telegram-sessions.json');
	const [DEFAULT_PROVIDER_ID, DEFAULT_MODEL_ID] = raw.model ? raw.model.split('/') : ['', '']
	const POLL_INTERVAL_MS = Number(raw.pollIntervalMs || 1000);
	const POLL_TIMEOUT_MS = Number(raw.pollTimeoutMs || 60 * 60 * 1000);

	if (!BOT_TOKEN) throw new Error('Config missing required field: botToken');
	if (!USERNAME) throw new Error('Config missing required field: username');
	if (!PASSWORD) throw new Error('Config missing required field: password');

	const parsedFingerprints = parseFingerprintList(raw.allowedFingerprints);
	const AUTH_MODE = parsedFingerprints.length === 0 ? 'deny-all' : parsedFingerprints[0] === '*' ? 'discovery' : 'allowlist';
	const allowedFingerprints = new Set(parsedFingerprints.filter(item => item !== '*'));

	function modelConfig() {
		if (!DEFAULT_PROVIDER_ID || !DEFAULT_MODEL_ID) return undefined;
		return { providerID: DEFAULT_PROVIDER_ID, modelID: DEFAULT_MODEL_ID };
	}

	return {
		AUTH_MODE,
		BASE_URL,
		BOT_TOKEN,
		DEFAULT_MODEL_ID,
		DEFAULT_PROVIDER_ID,
		PASSWORD,
		POLL_INTERVAL_MS,
		POLL_TIMEOUT_MS,
		STORE_PATH,
		UNAUTHORIZED_MESSAGE:
			'Unauthorized. Run /fingerprint and add the result to allowedFingerprints in ~/.config/opencode/telegram-bot.json',
		USERNAME,
		allowedFingerprints,
		modelConfig,
		parsedFingerprints,
	};
}

export { loadConfig, CONFIG_PATH };
