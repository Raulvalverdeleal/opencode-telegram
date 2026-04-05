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

function parseModelShortcut(text) {
	const match = (text || '').trim().match(/^\/model_(\S+)(?:@\S+)?$/i);
	return match ? match[1] : null;
}

function safeModelId(providerId, modelId) {
	return `${providerId}_${modelId}`.replace(/\//g, '_').replace(/-/g, '_').replace(/\./g, '_');
}

function parseModelFromSafe(safeId, providers) {
	for (const provider of providers || []) {
		const modelIds = Object.keys(provider.models || {});
		for (const modelId of modelIds) {
			const safe = safeModelId(provider.id, modelId);
			if (safe === safeId) {
				return `${provider.id}/${modelId}`;
			}
		}
	}
	return null;
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
			await ctx.reply(query ? `No hay sesiones para "${queryText}".` : 'No hay sesiones en el servidor.');
			return;
		}
		const lines = [];
		for (const item of sessions.slice(0, 20)) {
			const active = item.id === activeSessionId ? '* ' : '';
			const name = namesById.get(item.id) || item.title || 'sin nombre';
			lines.push(`${active}${name}\n▶️ /s_${item.id}\n⏹️ /d_${item.id}`);
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
			await ctx.reply('No hay agentes principales disponibles.');
			return;
		}
		const lines = ['Agentes principales:'];
		for (const agent of agents) {
			const desc = agent.description ? ` - ${agent.description}` : '';
			lines.push(`/agent_${agent.name}${desc}`);
		}
		await ctx.reply(lines.join('\n\n'));
	} catch (error) {
		await ctx.reply(`Error al obtener agentes: ${error instanceof Error ? error.message : error}`);
	}
});

bot.command('model', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	try {
		const sessionId = await sessionStore.ensureSession(chatId);
		const messages = await client.session.messages({ path: { id: sessionId }, query: { limit: 50 } });
		const assistant = messages.data.findLast(item => item.info?.role === 'assistant');
		if (!assistant) {
			await ctx.reply('No hay mensajes del asistente en esta sesión.');
			return;
		}
		const { providerID, modelID } = assistant.info;
		await ctx.reply(`Modelo actual: ${providerID}/${modelID}`);
	} catch (error) {
		await ctx.reply(`Error al obtener modelo: ${error instanceof Error ? error.message : error}`);
	}
});

bot.command('models', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const raw = ctx.message.text || '';
	const queryText = commandArgument(raw, 'models');
	const query = queryText.toLowerCase();
	try {
		const result = await client.config.providers();
		const { providers } = result.data || {};
		if (!providers || providers.length === 0) {
			await ctx.reply('No hay providers conectados.');
			return;
		}
		const lines = ['Modelos disponibles:'];
		for (const provider of providers) {
			const providerId = provider.id;
			const modelIds = Object.keys(provider.models || {});
			for (const modelId of modelIds) {
				if (query && !`${providerId}/${modelId}`.toLowerCase().includes(query)) {
					continue;
				}
				const safe = safeModelId(providerId, modelId);
				lines.push(`/model_${safe}`);
			}
		}
		if (lines.length === 1) {
			await ctx.reply(query ? `No hay modelos para "${queryText}".` : 'No hay modelos disponibles.');
			return;
		}
		await ctx.reply(lines.join('\n'));
	} catch (error) {
		await ctx.reply(`Error al obtener modelos: ${error instanceof Error ? error.message : error}`);
	}
});

bot.command('help', async ctx => {
	await ctx.reply(
		[
			'/new <nombre_opcional> — nueva sesión',
			'/rename <nombre> — renombrar sesión actual',
			'/stop — interrumpir ejecución actual',
			'/verbose — toggle trazas de progreso',
			'/status — sesión activa, nombre y directorio',
			'/sessions <filtro_opcional> — sesiones filtradas por nombre',
			'/agents — listar agentes principales',
			'/model — modelo actual',
			'/models — modelos disponibles',
			'/restart — reiniciar bot de Telegram',
			'/fingerprint — obtener fingerprint de autorización',
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
	await ctx.reply(fingerprint);
});

bot.on('voice', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	const voice = ctx.message.voice;
	if (!voice) return;

	await ctx.reply('Procesando audio...');
	const traceId = `tg-${chatId}-${Date.now()}`;

	withChatLock(chatId, async () => {
		const sessionId = await sessionStore.ensureSession(chatId);
		const fileLink = await bot.telegram.getFileLink(voice.file_id);
		const text = await promptService.promptWithPolling(sessionId, null, traceId, chatId, undefined, [
			{ type: 'file', mime: voice.mime_type || 'audio/ogg', url: fileLink, filename: `voice_${voice.file_unique_id}.oga` },
		]);
		if (text?.toLowerCase().includes('does not support audio')) {
			await bot.telegram.sendMessage(chatId, 'Este modelo no soporta audio. Cambia a un modelo con soporte de audio (ej: Claude).');
		} else {
			await promptService.replySplit(chatId, text);
		}
	}).catch(async error => {
		const message = error instanceof Error ? error.message : JSON.stringify(error);
		logError('audio.voice.error', error, { chatId });
		if (message.toLowerCase().includes('does not support audio')) {
			await bot.telegram.sendMessage(chatId, 'Este modelo no soporta audio. Cambia a un modelo con soporte de audio (ej: Claude).');
		} else {
			await bot.telegram.sendMessage(chatId, `Error: ${message}`);
		}
	});
});

bot.on('audio', async ctx => {
	if (!(await authService.authorizeRequest(ctx))) return;
	const chatId = ctx.chat.id;
	const audio = ctx.message.audio || ctx.message.voice;
	if (!audio) return;

	await ctx.reply('Procesando audio...');
	const traceId = `tg-${chatId}-${Date.now()}`;

	withChatLock(chatId, async () => {
		const sessionId = await sessionStore.ensureSession(chatId);
		const fileLink = await bot.telegram.getFileLink(audio.file_id);
		const text = await promptService.promptWithPolling(sessionId, null, traceId, chatId, undefined, [
			{ type: 'file', mime: audio.mime_type || 'audio/mpeg', url: fileLink, filename: audio.file_name || `audio_${audio.file_unique_id}` },
		]);
		if (text?.toLowerCase().includes('does not support audio')) {
			await bot.telegram.sendMessage(chatId, 'Este modelo no soporta audio. Cambia a un modelo con soporte de audio (ej: Claude).');
		} else {
			await promptService.replySplit(chatId, text);
		}
	}).catch(async error => {
		const message = error instanceof Error ? error.message : JSON.stringify(error);
		logError('audio.file.error', error, { chatId });
		if (message.toLowerCase().includes('does not support audio')) {
			await bot.telegram.sendMessage(chatId, 'Este modelo no soporta audio. Cambia a un modelo con soporte de audio (ej: Claude).');
		} else {
			await bot.telegram.sendMessage(chatId, `Error: ${message}`);
		}
	});
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
			await ctx.reply(`Sesión eliminada: ${deleteId}`);
			return;
		}

		const switchId = parseSwitchShortcut(prompt);
		if (switchId) {
			if (!(await authService.authorizeRequest(ctx))) return;
			promptService.clearPending(chatId);
			await withChatLock(chatId, async () => {
				const active = await sessionStore.switchSession(chatId, switchId);
				await ctx.reply(`Sesión activa actualizada: ${active}`);
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
				await ctx.reply(`Agente actualizado: ${agentName}`);
			});
			return;
		}

		const modelId = parseModelShortcut(prompt);
		if (modelId) {
			if (!(await authService.authorizeRequest(ctx))) return;
			try {
				const result = await client.config.providers();
				const { providers } = result.data || {};
				const fullModel = parseModelFromSafe(modelId, providers);
				if (!fullModel) {
					await ctx.reply(`Modelo no encontrado: ${modelId}`);
					return;
				}
				await client.config.update({ config: { model: fullModel } });
				await ctx.reply(`Modelo actualizado: ${fullModel}`);
			} catch (error) {
				await ctx.reply(`Error al cambiar modelo: ${error instanceof Error ? error.message : error}`);
			}
			return;
		}

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
		if (promptService.isAwaitingOtherInput(chatId)) {
			const submitted = await promptService.submitOtherInput(chatId, prompt);
			if (submitted) return;
		}
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
			return `Unauthorized: revisa username y password en ~/.config/opencode/telegram-bot.json y en opencode serve.`;
		}
		return error;
	}
	if (error instanceof Error) {
		const cause = error.cause;
		if (cause && typeof cause === 'object') {
			const code = cause.code || '';
			if (code === 'ECONNREFUSED') {
				return `No hay conexion con OpenCode server en ${BASE_URL}.`;
			}
			if (code === 'ENOTFOUND') {
				return `No se puede resolver el host ${BASE_URL}. Revisa baseUrl en ~/.config/opencode/telegram-bot.json.`;
			}
			if (code === 'EACCES') {
				return `No hay permisos para conectar con ${BASE_URL}. Revisa red/firewall y puertos.`;
			}
			if (cause.message) {
				return `Fallo de conexion con OpenCode server (${BASE_URL}): ${cause.message}`;
			}
		}
		if (error.message.toLowerCase().includes('unauthorized')) {
			return `Unauthorized: revisa username y password en ~/.config/opencode/telegram-bot.json y en opencode serve.`;
		}
		if (error.message === 'fetch failed') {
			return `Fallo de conexion con OpenCode server (${BASE_URL}). Revisa que este levantado y que usuario/password coincidan.`;
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
