import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Telegraf } from 'telegraf';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { createOpencodeClient as createOpencodeClientV2 } from '@opencode-ai/sdk/v2';
import { Buffer } from 'node:buffer';
import {
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
	validateRequiredEnv,
} from './src/config.mjs';
import { logError, logInfo, nowIso } from './src/logger.mjs';
import { withChatLock } from './src/chat-locks.mjs';
import { createSessionStore } from './src/session-store.mjs';
import { createAuthService } from './src/auth.mjs';
import { createPromptService } from './src/prompt-service.mjs';

validateRequiredEnv();

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
const promptService = createPromptService({
	bot,
	client,
	interactionClient,
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

async function buildStatusText(chatId) {
	const sessionId = await sessionStore.ensureSession(chatId);
	const record = await sessionStore.listSessions(chatId);
	const verbose = await sessionStore.isVerbose(chatId);
	const savedName = record.sessions.find(item => item.id === sessionId)?.name;
	const sessionResult = await client.session.get({ path: { id: sessionId } });
	const sessionName = savedName || sessionResult.data?.title || 'N/A';
	return [`Session: ${sessionName}`, `Verbose: ${verbose ? 'ON' : 'OFF'}`].join('\n');
}

bot.start(async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	promptService.clearPending(chatId);
	const sessionId = await withChatLock(chatId, () => sessionStore.ensureSession(chatId));
	await ctx.reply(
		['Listo.', `Este chat usa la sesión: ${sessionId}`, 'Comandos: /new /rename /stop /verbose /status /sessions /<session_id>.'].join(
			'\n',
		),
	);
});

bot.command('new', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	const raw = ctx.message.text || '';
	const sessionName = commandArgument(raw, 'new') || null;
	promptService.clearPending(chatId);
	const sessionId = await withChatLock(chatId, () => sessionStore.newSession(chatId, sessionName));
	const suffix = sessionName ? `\nNombre: ${sessionName}` : '';
	await ctx.reply(`Nueva sesión creada: ${sessionId}${suffix}`);
});

bot.command('rename', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	const raw = ctx.message.text || '';
	const sessionName = commandArgument(raw, 'rename');
	if (!sessionName) {
		await ctx.reply('Uso: /rename <nuevo_nombre_para_sesion_actual>');
		return;
	}

	promptService.clearPending(chatId);
	await withChatLock(chatId, async () => {
		const renamed = await sessionStore.renameCurrentSession(chatId, sessionName);
		await ctx.reply(`Sesión actual renombrada: ${renamed.name}\nID: ${renamed.sessionId}`);
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
	const raw = ctx.message.text || '';
	const arg = commandArgument(raw, 'verbose').toLowerCase();

	await withChatLock(chatId, async () => {
		let enabled;
		if (!arg) {
			enabled = await sessionStore.toggleVerbose(chatId);
		} else if (arg === '1') {
			enabled = await sessionStore.setVerbose(chatId, true);
		} else if (arg === '0') {
			enabled = await sessionStore.setVerbose(chatId, false);
		} else {
			await ctx.reply('Uso: /verbose (toggle) | /verbose 1 | /verbose 0');
			return;
		}

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
			await ctx.reply(query ? `No hay sesiones para "${queryText}".` : 'No hay sesiones en el servidor.');
			return;
		}
		for (const item of sessions.slice(0, 20)) {
			const active = item.id === activeSessionId ? '* ' : '';
			const name = namesById.get(item.id) || item.title || 'sin nombre';
			await bot.telegram.sendMessage(chatId, `${active}${name}\n/${item.id}`);
		}
	});
});

bot.command('delete', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const raw = ctx.message.text || '';
	const sessionId = raw.replace(/^\/delete\s+/i, '').trim();
	if (!sessionId || sessionId.includes(' ')) {
		await ctx.reply('Uso: /delete <session_id>');
		return;
	}
	const chatId = ctx.chat.id;
	promptService.clearPending(chatId);
	await client.session.delete({ path: { id: sessionId } });
	await sessionStore.removeSession(chatId, sessionId);
	await ctx.reply(`Sesión eliminada: ${sessionId}`);
});

bot.command('switch', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const raw = ctx.message.text || '';
	const sessionId = commandArgument(raw, 'switch');
	if (!sessionId || sessionId.includes(' ') || !sessionId.startsWith('ses_')) {
		await ctx.reply('Uso: /switch <session_id>');
		return;
	}
	const chatId = ctx.chat.id;
	promptService.clearPending(chatId);
	await withChatLock(chatId, async () => {
		const active = await sessionStore.switchSession(chatId, sessionId);
		await ctx.reply(`Sesión activa actualizada: ${active}`);
	});
});

bot.command('help', async ctx => {
	await ctx.reply(
		[
			'/new <nombre_opcional> — nueva sesión',
			'/rename <nombre> — renombrar sesión actual',
			'/stop — interrumpir ejecución actual',
			'/verbose — toggle de trazas de progreso',
			'/verbose 1|0 — activar/desactivar trazas',
			'/status — sesión activa, nombre y directorio',
			'/sessions <filtro_opcional> — sesiones filtradas por nombre',
			'/switch <session_id> — cambiar sesión activa',
			'/delete <session_id> — eliminar sesión',
			'/restart — reiniciar bot de Telegram',
			'/fingerprint — obtener fingerprint de autorización',
			'/help — mostrar esta ayuda',
		].join('\n'),
	);
});

bot.command('stop', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	const stopped = await promptService.stopActive(chatId);
	if (!stopped) {
		await ctx.reply('No hay una ejecución activa en este chat.');
		return;
	}
	await ctx.reply('Ejecución detenida.');
});

bot.command('restart', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	await ctx.reply('Reiniciando...');
	const { exec } = await import('node:child_process');
	setTimeout(() => {
		exec('npm run pm2:restart', { cwd: new URL('.', import.meta.url).pathname }, async error => {
			if (!error) return;
			await bot.telegram.sendMessage(chatId, `Error al reiniciar: ${error.message}`);
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
	await ctx.reply(
		[
			`Fingerprint: ${fingerprint}`,
			'Agrega este valor a TELEGRAM_ALLOWED_FINGERPRINTS en el servidor para autorizar este chat/usuario.',
		].join('\n'),
	);
});

bot.on('text', async ctx => {
	const prompt = ctx.message.text?.trim();
	if (!prompt) return;

	const chatId = ctx.chat.id;
	if (prompt.startsWith('/')) {
		const handledDecision = await promptService.handleDecisionReply(chatId, prompt);
		if (handledDecision) return;

		const sessionIdFromShortcut = parseSessionShortcut(prompt);
		if (sessionIdFromShortcut) {
			if (!(await authService.authorizeRequest(ctx))) return;
			promptService.clearPending(chatId);
			await withChatLock(chatId, async () => {
				const active = await sessionStore.switchSession(chatId, sessionIdFromShortcut);
				await ctx.reply(`Sesión activa actualizada: ${active}`);
			});
			return;
		}

		promptService.clearPending(chatId);
		return;
	}

	if (promptService.hasPending(chatId)) {
		promptService.clearPending(chatId);
	}
	if (!(await authService.authorizeRequest(ctx))) return;

	const traceId = `tg-${chatId}-${Date.now()}`;
	logInfo('telegram.request.received', { traceId, chatId, promptChars: prompt.length });

	withChatLock(chatId, async () => {
		logInfo('telegram.lock.acquired', { traceId, chatId });
		const sessionId = await sessionStore.ensureSession(chatId);
		logInfo('telegram.session.ready', { traceId, chatId, sessionId });
		const sent = await sessionStore.isInstructionsSent(chatId);
		const system = sent || !botInstructions ? undefined : botInstructions;
		if (system) await sessionStore.markInstructionsSent(chatId);
		const text = await promptService.promptWithPolling(sessionId, prompt, traceId, chatId, system);
		logInfo('telegram.reply.sending', { traceId, chatId, chars: text.length });
		await promptService.replySplit(chatId, text);
		logInfo('telegram.reply.sent', { traceId, chatId });
	}).catch(async error => {
		if (promptService.isStopError(error)) {
			logInfo('telegram.request.stopped', { traceId, chatId });
			return;
		}
		logError('telegram.request.failed', error, { traceId, chatId });
		const message = error instanceof Error ? error.message : JSON.stringify(error);
		await bot.telegram.sendMessage(chatId, `Error: ${message}`);
	});
});

bot.catch(async (err, ctx) => {
	const message = err instanceof Error ? err.message : JSON.stringify(err);
	await ctx.reply(`Error: ${message}`);
});

function startupErrorMessage(error) {
	if (typeof error === 'string') {
		if (error.toLowerCase().includes('unauthorized')) {
			return 'Unauthorized: revisa OPENCODE_SERVER_USERNAME y OPENCODE_SERVER_PASSWORD en .env y en opencode serve.';
		}
		return error;
	}
	if (error instanceof Error) {
		const cause = error.cause;
		if (cause && typeof cause === 'object') {
			const code = cause.code || '';
			if (code === 'ECONNREFUSED') {
				return `No hay conexion con OpenCode server en ${BASE_URL}. Arranca: npm run start:opencode`;
			}
			if (code === 'ENOTFOUND') {
				return `No se puede resolver el host de OPENCODE_BASE_URL (${BASE_URL}). Revisa la URL en .env.`;
			}
			if (code === 'EACCES') {
				return `No hay permisos para conectar con ${BASE_URL}. Revisa red/firewall y puertos.`;
			}
			if (cause.message) {
				return `Fallo de conexion con OpenCode server (${BASE_URL}): ${cause.message}`;
			}
		}
		if (error.message.toLowerCase().includes('unauthorized')) {
			return 'Unauthorized: revisa OPENCODE_SERVER_USERNAME y OPENCODE_SERVER_PASSWORD en .env y en opencode serve.';
		}
		if (error.message === 'fetch failed') {
			return `Fallo de conexion con OpenCode server (${BASE_URL}). Revisa que este levantado con npm run start:opencode y que usuario/password coincidan.`;
		}
		return `Error al iniciar: ${error.message}`;
	}
	return 'Error desconocido al iniciar';
}

function isConnectionError(error) {
	if (!(error instanceof Error)) return false;
	const code = error.cause?.code;
	return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || error.message === 'fetch failed';
}

async function waitForOpenCode(retries = 10, delayMs = 2000) {
	for (let i = 1; i <= retries; i++) {
		try {
			await client.project.current();
			return;
		} catch (error) {
			if (!isConnectionError(error)) throw error;
			console.log(`Waiting for OpenCode server... (${i}/${retries})`);
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

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
