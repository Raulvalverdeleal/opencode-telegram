const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4096';
const USERNAME = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || '';
const STORE_PATH = process.env.SESSION_STORE || './data/chat-sessions.json';
const DEFAULT_PROVIDER_ID = process.env.DEFAULT_PROVIDER_ID || '';
const DEFAULT_MODEL_ID = process.env.DEFAULT_MODEL_ID || '';
const TELEGRAM_ALLOWED_FINGERPRINTS = process.env.TELEGRAM_ALLOWED_FINGERPRINTS || '';
const POLL_INTERVAL_MS = Number(process.env.OPENCODE_POLL_INTERVAL_MS || 1000);
const POLL_TIMEOUT_MS = Number(process.env.OPENCODE_POLL_TIMEOUT_MS || 60 * 60 * 1000);
const UNAUTHORIZED_MESSAGE = 'Unauthorized. Run /fingerprint and add the result to TELEGRAM_ALLOWED_FINGERPRINTS on the server.';

function parseFingerprintList(raw) {
	return raw
		.split(',')
		.map(item => item.trim())
		.filter(Boolean);
}

const parsedFingerprints = parseFingerprintList(TELEGRAM_ALLOWED_FINGERPRINTS);
const AUTH_MODE = parsedFingerprints.length === 0 ? 'deny-all' : parsedFingerprints[0] === '*' ? 'discovery' : 'allowlist';
const allowedFingerprints = new Set(parsedFingerprints.filter(item => item !== '*'));

function modelConfig() {
	if (!DEFAULT_PROVIDER_ID || !DEFAULT_MODEL_ID) return undefined;
	return {
		providerID: DEFAULT_PROVIDER_ID,
		modelID: DEFAULT_MODEL_ID,
	};
}

function validateRequiredEnv() {
	if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
	if (!PASSWORD) throw new Error('Missing OPENCODE_SERVER_PASSWORD');
}

export {
	AUTH_MODE,
	BASE_URL,
	BOT_TOKEN,
	DEFAULT_MODEL_ID,
	DEFAULT_PROVIDER_ID,
	PASSWORD,
	POLL_INTERVAL_MS,
	POLL_TIMEOUT_MS,
	STORE_PATH,
	TELEGRAM_ALLOWED_FINGERPRINTS,
	UNAUTHORIZED_MESSAGE,
	USERNAME,
	allowedFingerprints,
	modelConfig,
	parsedFingerprints,
	validateRequiredEnv,
};
