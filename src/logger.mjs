function nowIso() {
	return new Date().toISOString();
}

function hms() {
	return new Date().toTimeString().slice(0, 8);
}

const formatters = {
	'auth.mode': ({ mode, configuredFingerprints }) => `Auth started — mode: ${mode}, ${configuredFingerprints} fingerprint(s) configured`,
	'auth.denied.missing_fingerprint': ({ chatId, userId }) => `Auth denied — missing fingerprint (chat=${chatId}, user=${userId})`,
	'auth.discovery.fingerprint': ({ fingerprint, chatId }) => `Discovery mode — fingerprint ${fingerprint} replied to chat ${chatId}`,
	'auth.denied.deny_all': ({ chatId, userId }) => `Auth denied — deny-all mode (chat=${chatId}, user=${userId})`,
	'auth.denied.not_allowed': ({ fingerprint }) => `Auth denied — ${fingerprint} not in allowlist`,

	'telegram.request.received': ({ traceId, chatId, promptChars }) => `[${traceId}] chat ${chatId} → ${promptChars} chars received`,
	'telegram.processing.sent': ({ traceId, chatId }) => `[${traceId}] "Procesando..." sent to chat ${chatId}`,
	'telegram.lock.acquired': ({ traceId, chatId }) => `[${traceId}] lock acquired for chat ${chatId}`,
	'telegram.session.ready': ({ traceId, sessionId }) => `[${traceId}] session ready — ${sessionId}`,
	'telegram.reply.sending': ({ traceId, chatId, chars }) => `[${traceId}] sending ${chars} chars to chat ${chatId}`,
	'telegram.reply.sent': ({ traceId, chatId }) => `[${traceId}] reply sent to chat ${chatId}`,

	'polling.start': ({ traceId, sessionId, timeoutMs, intervalMs }) =>
		`[${traceId}] polling session ${sessionId} (timeout=${Math.round(timeoutMs / 1000)}s, interval=${intervalMs}ms)`,
	'polling.status': ({ traceId, sessionId, status, attempts }) =>
		`[${traceId}] status=${status} — session ${sessionId} (attempt ${attempts})`,
	'polling.timeout': ({ traceId, sessionId, attempts }) =>
		`[${traceId}] timed out waiting for session ${sessionId} after ${attempts} attempts`,

	'prompt.prepare': ({ traceId, sessionId }) => `[${traceId}] preparing prompt for session ${sessionId}`,
	'prompt.history.loaded': ({ traceId, knownMessages }) => `[${traceId}] ${knownMessages} prior message(s) loaded`,
	'prompt.async.send': ({ traceId, sessionId, promptChars }) => `[${traceId}] sending ${promptChars}-char prompt to session ${sessionId}`,
	'prompt.async.accepted': ({ traceId }) => `[${traceId}] prompt accepted`,
	'prompt.fetch.attempt': ({ traceId, attempt }) => `[${traceId}] fetching response (attempt ${attempt})`,
	'prompt.fetch.found': ({ traceId, messageId }) => `[${traceId}] response found — message ${messageId}`,
};

function format(event, data) {
	const fn = formatters[event];
	if (fn) return fn(data);
	const parts = Object.entries(data).map(([k, v]) => `${k}=${v}`);
	return parts.length > 0 ? `${event} — ${parts.join(', ')}` : event;
}

function logInfo(event, data = {}) {
	console.log(`${hms()}  ${format(event, data)}`);
}

function logError(event, error, data = {}) {
	const message = error instanceof Error ? error.message : JSON.stringify(error);
	const base = format(event, data);
	console.error(`${hms()}  [ERROR] ${base} — ${message}`);
}

export { logError, logInfo, nowIso };
