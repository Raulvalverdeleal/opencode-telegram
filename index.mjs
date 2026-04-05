import { readFile } from 'node:fs/promises';
import { Telegraf } from 'telegraf';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeClient as createOpencodeClientV2 } from '@opencode-ai/sdk/v2';
import { Buffer } from 'node:buffer';
import { loadConfig } from './src/config.mjs';
import { logError, logInfo, nowIso } from './src/logger.mjs';
import { withChatLock } from './src/chat-locks.mjs';
import { createSessionStore } from './src/session-store.mjs';
import { createAuthService } from './src/auth.mjs';
import { createPromptService } from './src/prompt-service.mjs';

const {
	AUTH_MODE,
	BASE_URL,
	BOT_TOKEN,
	PASSWORD,
	POLL_INTERVAL_MS,
	POLL_TIMEOUT_MS,
	STORE_PATH,
	UNAUTHORIZED_MESSAGE,
	USERNAME,
	allowedFingerprints,
	modelConfig,
	parsedFingerprints,
} = await loadConfig();

const botInstructions = await readFile(new URL('./BOT.md', import.meta.url), 'utf8').catch(() => '');

const basicAuthValue = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;

const authFetch = async (input, init = {}) => {
	const baseHeaders = init.headers || (input instanceof Request ? input.headers : undefined);
	const headers = new Headers(baseHeaders);
	headers.set('Authorization', basicAuthValue);
	return fetch(input, { ...init, headers });
};

const client = createOpencodeClient({
	baseUrl: BASE_URL,
	fetch: authFetch,
	throwOnError: true,
});

const interactionClient = createOpencodeClientV2({
	baseUrl: BASE_URL,
	fetch: authFetch,
	throwOnError: true,
});

const bot = new Telegraf(BOT_TOKEN);
const sessionStore = createSessionStore({ client, storePath: STORE_PATH, nowIso });
const authService = createAuthService({
	authMode: AUTH_MODE,
	allowedFingerprints,
	logInfo,
	unauthorizedMessage: UNAUTHORIZED_MESSAGE,
});

async function isSessionActiveForChat(chatId, sessionId) {
	if (!sessionId) return false;
	const currentSessionId = await sessionStore.getCurrentSessionId(chatId);
	return currentSessionId === sessionId;
}

async function enqueueSessionMessage(chatId, sessionId, text) {
	await withChatLock(chatId, () => sessionStore.enqueueSessionMessage(chatId, sessionId, text));
}

async function flushSessionQueue(chatId, sessionId) {
	const queued = await withChatLock(chatId, () => sessionStore.consumeSessionMessages(chatId, sessionId));
	for (const item of queued) {
		await promptService.replySplit(chatId, item.text);
	}
	return queued.length;
}

const promptService = createPromptService({
	bot,
	client,
	interactionClient,
	enqueueSessionMessage,
	isSessionActive: isSessionActiveForChat,
	isVerboseEnabled: chatId => sessionStore.isVerbose(chatId),
	logInfo,
	modelConfig,
	pollIntervalMs: POLL_INTERVAL_MS,
	pollTimeoutMs: POLL_TIMEOUT_MS,
});

function commandArgument(text, commandName) {
	const pattern = new RegExp(`^/${commandName}(?:@\\S+)?\\s*`, 'i');
	return (text || '').replace(pattern, '').trim();
}

function parseSessionShortcut(text) {
	const match = (text || '').trim().match(/^\/(ses_[^\s@]+)(?:@\S+)?$/i);
	return match ? match[1] : null;
}

function parseDeleteShortcut(text) {
	const match = (text || '').trim().match(/^\/d_(ses_[^\s@]+)(?:@\S+)?$/i);
	return match ? match[1] : null;
}

function parseSwitchShortcut(text) {
	const match = (text || '').trim().match(/^\/s_(ses_[^\s@]+)(?:@\S+)?$/i);
	return match ? match[1] : null;
}

function parseAgentShortcut(text) {
	const match = (text || '').trim().match(/^\/agent_(\S+)(?:@\S+)?$/i);
	return match ? match[1] : null;
}

function parseMcpShortcut(text) {
	const match = (text || '').trim().match(/^\/mcp_(\S+)(?:@\S+)?$/i);
	return match ? match[1] : null;
}

function safeMcpName(name) {
	return String(name || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

function resolveMcpNameFromSafe(safeName, statusByName) {
	for (const name of Object.keys(statusByName || {})) {
		if (safeMcpName(name) === safeName) return name;
	}
	return null;
}

async function buildStatusText(chatId) {
	const sessionId = await sessionStore.ensureSession(chatId);
	const record = await sessionStore.listSessions(chatId);
	const savedName = record.sessions.find(item => item.id === sessionId)?.name;
	const sessionResult = await client.session.get({ path: { id: sessionId } });
	const sessionName = savedName || sessionResult.data?.title || 'N/A';
	const agent = await sessionStore.getAgent(chatId);
	return `Session: ${sessionName}\nAgent: ${agent}`;
}

bot.start(async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	promptService.clearPending(chatId);
	const sessionId = await withChatLock(chatId, () => sessionStore.ensureSession(chatId));
	const sessionResult = await client.session.get({ path: { id: sessionId } });
	const sessionName = sessionResult.data?.title || sessionId;
	const agent = await sessionStore.getAgent(chatId);
	await ctx.reply(`Ready.\nSession: ${sessionName}\nAgent: ${agent}`);
});

bot.command('new', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	const raw = ctx.message.text || '';
	const sessionName = commandArgument(raw, 'new') || null;
	promptService.clearPending(chatId);
	const sessionId = await withChatLock(chatId, () => sessionStore.newSession(chatId, sessionName));
	await promptService.syncPendingForSession(chatId, sessionId);
	const suffix = sessionName ? `\nName: ${sessionName}` : '';
	await ctx.reply(`New session created: ${sessionId}${suffix}`);
});

bot.command('rename', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	const raw = ctx.message.text || '';
	const sessionName = commandArgument(raw, 'rename');
	if (!sessionName) {
		await ctx.reply('Usage: /rename <new_name_for_current_session>');
		return;
	}

	await withChatLock(chatId, async () => {
		const renamed = await sessionStore.renameCurrentSession(chatId, sessionName);
		await ctx.reply(`Current session renamed: ${renamed.name}\nID: ${renamed.sessionId}`);
	});
});

bot.command('status', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	promptService.clearPending(chatId);
	await withChatLock(chatId, async () => {
		await ctx.reply(await buildStatusText(chatId));
	});
});

bot.command('verbose', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;

	await withChatLock(chatId, async () => {
		const enabled = await sessionStore.toggleVerbose(chatId);
		await ctx.reply(`Verbose ${enabled ? 'ON' : 'OFF'}`);
	});
});

bot.command('sessions', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	const raw = ctx.message.text || '';
	const queryText = commandArgument(raw, 'sessions');
	const query = queryText.toLowerCase();
	promptService.clearPending(chatId);
	await withChatLock(chatId, async () => {
		const activeSessionId = await sessionStore.ensureSession(chatId);
		const record = await sessionStore.listSessions(chatId);
		const namesById = new Map(record.sessions.map(item => [item.id, item.name]));
		const allSessions = await client.session.list();
		const sessions = (allSessions.data || []).filter(item => {
			if (!query) return true;
			const name = namesById.get(item.id) || item.title || '';
			return name.toLowerCase().includes(query);
		});
		if (sessions.length === 0) {
			await ctx.reply(query ? `No sessions for "${queryText}".` : 'No sessions on server.');
			return;
		}
		const lines = [];
		for (const item of sessions.slice(0, 20)) {
			const active = item.id === activeSessionId ? '* ' : '';
			const name = namesById.get(item.id) || item.title || 'unnamed';
			const pendingCount = await sessionStore.pendingSessionCount(chatId, item.id);
			const pendingSuffix = pendingCount > 0 ? ` (${pendingCount} pending)` : '';
			lines.push(`${active}${name}${pendingSuffix}\n/s_${item.id}\n/d_${item.id}`);
		}
		await ctx.reply(lines.join('\n\n'));
	});
});

bot.command('agents', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	try {
		const result = await interactionClient.app.agents();
		const agents = (result.data || []).filter(a => (a.mode === 'primary' || a.mode === 'all') && !a.hidden);
		if (agents.length === 0) {
			await ctx.reply('No main agents available.');
			return;
		}
		const lines = ['Main agents:'];
		for (const agent of agents) {
			const desc = agent.description ? ` - ${agent.description}` : '';
			lines.push(`/agent_${agent.name}${desc}`);
		}
		await ctx.reply(lines.join('\n\n'));
	} catch (error) {
		await ctx.reply(`Error getting agents: ${error instanceof Error ? error.message : error}`);
	}
});

bot.command('mcp', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const raw = ctx.message.text || '';
	const queryText = commandArgument(raw, 'mcp');
	const query = queryText.toLowerCase();
	try {
		const result = await interactionClient.mcp.status();
		const statusByName = result.data || {};
		const names = Object.keys(statusByName).filter(name => {
			if (!query) return true;
			return name.toLowerCase().includes(query);
		});
		if (names.length === 0) {
			await ctx.reply(query ? `No MCP for "${queryText}".` : 'No MCP available.');
			return;
		}
		const lines = [];
		for (const name of names) {
			const safeName = safeMcpName(name);
			const status = statusByName[name]?.status || 'unknown';
			lines.push(`/mcp_${safeName} ${status}`);
		}
		await ctx.reply(lines.join('\n'));
	} catch (error) {
		await ctx.reply(`Error listing MCP: ${error instanceof Error ? error.message : error}`);
	}
});

bot.command('help', async ctx => {
	await ctx.reply(
		[
			'/new <optional_name> — create new session',
			'/rename <name> — rename current session',
			'/stop — abort current execution',
			'/verbose — toggle progress traces',
			'/status — show active session',
			'/sessions <optional_filter> — list sessions',
			'/files — show modified files',
			'/file_<safe_name> — show file content',
			'/agents — list available agents',
			'/mcp <optional_filter> — list MCP servers',
			'/restart — restart bot',
			'/fingerprint — get fingerprint for authorization',
		].join('\n'),
	);
});

bot.command('stop', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	const sessionId = await withChatLock(chatId, () => sessionStore.ensureSession(chatId));
	const stopped = await promptService.stopSession(sessionId);
	if (!stopped) {
		await ctx.reply('No active execution in current session.');
		return;
	}
	await ctx.reply('Execution stopped.');
});

bot.command('restart', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	await ctx.reply('Restarting...');
	const { exec } = await import('node:child_process');
	setTimeout(() => {
		exec('npm run pm2:restart', { cwd: new URL('.', import.meta.url).pathname }, async error => {
			if (!error) return;
			await bot.telegram.sendMessage(chatId, `Restart error: ${error.message}`);
		});
	}, 500);
});

bot.command('fingerprint', async ctx => {
	if (ctx.chat?.id !== undefined) promptService.clearPending(ctx.chat.id);
	const fingerprint = authService.requestFingerprint(ctx);
	if (!fingerprint) {
		await ctx.reply('No se pudo calcular fingerprint para este update.');
		return;
	}
	await ctx.reply(fingerprint);
});

bot.on('text', async ctx => {
	const prompt = ctx.message.text?.trim();
	if (!prompt) return;

	const chatId = ctx.chat.id;
	if (prompt.startsWith('/')) {
		const handledDecision = await promptService.handleDecisionReply(chatId, prompt);
		if (handledDecision) return;

		const deleteId = parseDeleteShortcut(prompt);
		if (deleteId) {
			if (!(await authService.authorizeRequest(ctx))) return;
			promptService.clearPending(chatId);
			await client.session.delete({ path: { id: deleteId } });
			await sessionStore.removeSession(chatId, deleteId);
			await ctx.reply(`Session deleted: ${deleteId}`);
			return;
		}

		const switchId = parseSwitchShortcut(prompt);
		if (switchId) {
			if (!(await authService.authorizeRequest(ctx))) return;
			promptService.clearPending(chatId);
			await withChatLock(chatId, async () => {
				const previousSessionId = await sessionStore.getCurrentSession(chatId);
				const result = await sessionStore.switchSession(chatId, switchId);
				await promptService.deliverQueuedMessages(chatId, previousSessionId);
				await ctx.reply(`Active session updated: ${result.sessionId}`);
			});
			return;
		}

		const agentName = parseAgentShortcut(prompt);
		if (agentName) {
			if (!(await authService.authorizeRequest(ctx))) return;
			promptService.clearPending(chatId);
			await withChatLock(chatId, async () => {
				const sessionId = await sessionStore.ensureSession(chatId);
				await client.session.prompt({
					path: { id: sessionId },
					body: { agent: agentName, parts: [], noReply: true },
				});
				await sessionStore.setAgent(chatId, agentName);
				await ctx.reply(`Agent updated: ${agentName}`);
			});
			return;
		}

		const mcpSafeName = parseMcpShortcut(prompt);
		if (mcpSafeName) {
			if (!(await authService.authorizeRequest(ctx))) return;
			try {
				const result = await interactionClient.mcp.status();
				const statusByName = result.data || {};
				const mcpName = resolveMcpNameFromSafe(mcpSafeName, statusByName);
				if (!mcpName) {
					await ctx.reply(`MCP not found: ${mcpSafeName}`);
					return;
				}
				const currentStatus = statusByName[mcpName]?.status;
				if (currentStatus === 'connected') {
					await interactionClient.mcp.disconnect({ name: mcpName });
				} else {
					await interactionClient.mcp.connect({ name: mcpName });
				}
				const updated = await interactionClient.mcp.status();
				const newStatus = updated.data?.[mcpName]?.status || 'unknown';
				await ctx.reply(`/mcp_${mcpSafeName} ${newStatus}`);
			} catch (error) {
				await ctx.reply(`Error changing MCP: ${error instanceof Error ? error.message : error}`);
			}
			return;
		}

		const sessionIdFromShortcut = parseSessionShortcut(prompt);
		if (sessionIdFromShortcut) {
			if (!(await authService.authorizeRequest(ctx))) return;
			promptService.clearPending(chatId);
			const active = await withChatLock(chatId, () => sessionStore.switchSession(chatId, sessionIdFromShortcut));
			await ctx.reply(`Active session updated: ${active}`);
			const flushed = await flushSessionQueue(chatId, active);
			if (flushed > 0) {
				await ctx.reply(`Delivered ${flushed} pending message(s).`);
			}
			await promptService.syncPendingForSession(chatId, active);
			return;
		}

		promptService.clearPending(chatId);
		return;
	}

	if (promptService.hasPending(chatId)) {
		if (promptService.isAwaitingOtherInput(chatId)) {
			const submitted = await promptService.submitOtherInput(chatId, prompt);
			if (submitted) return;
		}
		promptService.clearPending(chatId);
	}
	if (!(await authService.authorizeRequest(ctx))) return;

	const traceId = `tg-${chatId}-${Date.now()}`;
	logInfo('telegram.request.received', { traceId, chatId, promptChars: prompt.length });

	let sessionId;
	await withChatLock(chatId, async () => {
		logInfo('telegram.lock.acquired', { traceId, chatId });
		sessionId = await sessionStore.ensureSession(chatId);
		logInfo('telegram.session.ready', { traceId, chatId, sessionId });
	});

	promptService
		.promptWithPolling(sessionId, prompt, traceId, chatId, botInstructions || undefined)
		.then(async text => {
			logInfo('telegram.reply.sending', { traceId, chatId, chars: text.length });
			if (await isSessionActiveForChat(chatId, sessionId)) {
				await promptService.replySplit(chatId, text);
			} else {
				await enqueueSessionMessage(chatId, sessionId, text);
			}
			logInfo('telegram.reply.sent', { traceId, chatId });
		})
		.catch(async error => {
			if (promptService.isStopError(error)) {
				logInfo('telegram.request.stopped', { traceId, chatId });
				return;
			}
			logError('telegram.request.failed', error, { traceId, chatId });
			const message = error instanceof Error ? error.message : JSON.stringify(error);
			if (await isSessionActiveForChat(chatId, sessionId)) {
				await bot.telegram.sendMessage(chatId, `Error: ${message}`);
			} else {
				await enqueueSessionMessage(chatId, sessionId, `Error: ${message}`);
			}
		});
});

bot.catch(async (err, ctx) => {
	const message = err instanceof Error ? err.message : JSON.stringify(err);
	await ctx.reply(`Error: ${message}`);
});

function startupErrorMessage(error) {
	if (typeof error === 'string') {
		if (error.toLowerCase().includes('unauthorized')) {
			return `Unauthorized: revisa username y password en ~/.config/opencode/telegram-bot.json y en opencode serve.`;
		}
		return error;
	}
	if (error instanceof Error) {
		const cause = error.cause;
		if (cause && typeof cause === 'object') {
			const code = cause.code || '';
			if (code === 'ECONNREFUSED') {
				return `No connection to OpenCode server at ${BASE_URL}.`;
			}
			if (code === 'ENOTFOUND') {
				return `Cannot resolve host ${BASE_URL}. Check baseUrl in ~/.config/opencode/telegram-bot.json.`;
			}
			if (code === 'EACCES') {
				return `No permissions to connect to ${BASE_URL}. Check network/firewall and ports.`;
			}
			if (cause.message) {
				return `Connection failed to OpenCode server (${BASE_URL}): ${cause.message}`;
			}
		}
		if (error.message.toLowerCase().includes('unauthorized')) {
			return `Unauthorized: check username and password in ~/.config/opencode/telegram-bot.json and in opencode serve.`;
		}
		if (error.message === 'fetch failed') {
			return `Connection failed to OpenCode server (${BASE_URL}). Check it's running and credentials match.`;
		}
		return `Startup error: ${error.message}`;
	}
	return 'Unknown startup error';
}

function isConnectionError(error) {
	if (!(error instanceof Error)) return false;
	const code = error.cause?.code;
	return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || error.message === 'fetch failed';
}

let opencodeProc = null;

async function spawnOpenCode() {
	const { spawn } = await import('node:child_process');
	const url = new URL(BASE_URL);
	const args = ['serve', '--hostname', url.hostname || '127.0.0.1', '--port', url.port || '4096'];
	opencodeProc = spawn('opencode', args, {
		cwd: process.cwd(),
		stdio: 'ignore',
		env: {
			...process.env,
			OPENCODE_SERVER_USERNAME: USERNAME,
			OPENCODE_SERVER_PASSWORD: PASSWORD,
		},
	});
	opencodeProc.on('error', error => {
		logError('opencode.spawn.failed', error);
	});
	logInfo('opencode.spawned', { pid: opencodeProc.pid });
}

async function waitForOpenCode(retries = 15, delayMs = 2000) {
	for (let i = 1; i <= retries; i++) {
		try {
			await client.project.current();
			return;
		} catch (error) {
			if (!isConnectionError(error)) throw error;
			if (i === 1) {
				console.log('OpenCode server not running, starting it...');
				await spawnOpenCode();
			} else {
				console.log(`Waiting for OpenCode server... (${i}/${retries})`);
			}
			await new Promise(resolve => setTimeout(resolve, delayMs));
		}
	}
	throw new Error(`OpenCode server at ${BASE_URL} not reachable after ${retries} attempts.`);
}

async function notifyStartupStatus() {
	const chatIds = await sessionStore.listChatIds();
	logInfo('startup.notify', { chatIds });
	for (const chatId of chatIds) {
		try {
			await withChatLock(chatId, async () => {
				const text = await buildStatusText(chatId);
				logInfo('startup.notify.sending', { chatId, text });
				await bot.telegram.sendMessage(chatId, ['Bot listo.', text].join('\n'));
			});
		} catch (error) {
			logError('telegram.startup.notify.failed', error, { chatId });
		}
	}
}

try {
	logInfo('auth.mode', {
		mode: AUTH_MODE,
		configuredFingerprints: allowedFingerprints.size,
		rawEntries: parsedFingerprints.length,
	});
	await waitForOpenCode();
	await notifyStartupStatus();
	await bot.launch();
} catch (error) {
	console.error(startupErrorMessage(error));
	process.exit(1);
}

process.on('unhandledRejection', reason => {
	const text = reason instanceof Error ? reason.stack || reason.message : JSON.stringify(reason);
	console.error(`Unhandled rejection: ${text}`);
});

process.once('SIGINT', () => {
	bot.stop('SIGINT');
	opencodeProc?.kill();
});
process.once('SIGTERM', () => {
	bot.stop('SIGTERM');
	opencodeProc?.kill();
});
