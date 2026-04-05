function createPromptService({
	bot,
	client,
	interactionClient,
	modelConfig,
	pollIntervalMs,
	pollTimeoutMs,
	logInfo,
	isVerboseEnabled,
	isSessionActive,
	enqueueSessionMessage,
}) {
	const verboseForChat = isVerboseEnabled || (async () => true);
	const sessionIsActive = isSessionActive || (async () => true);
	const enqueueForSession = enqueueSessionMessage || (async () => {});
	const pendingByChat = new Map();
	const activeBySession = new Map();
	const STOPPED_ERROR_CODE = 'SESSION_STOPPED';
	const PROGRESS_THROTTLE_MS = 2000;

	function getPending(chatId) {
		return pendingByChat.get(String(chatId)) || null;
	}

	function setPending(chatId, pending) {
		pendingByChat.set(String(chatId), pending);
	}

	function clearPending(chatId) {
		pendingByChat.delete(String(chatId));
	}

	function hasPending(chatId) {
		return pendingByChat.has(String(chatId));
	}

	function isAwaitingOtherInput(chatId) {
		const pending = getPending(chatId);
		return pending?.awaitingOtherInput === true;
	}

	async function submitOtherInput(chatId, text) {
		const pending = getPending(chatId);
		const requestId = pending?.requestId;
		if (!requestId) return false;
		await interactionClient.question.reply({ requestID: requestId, answers: [[text]] });
		clearPending(chatId);
		await bot.telegram.sendMessage(chatId, `Respondido: ${text}`);
		return true;
	}

	function getActive(sessionId) {
		if (!sessionId) return null;
		return activeBySession.get(String(sessionId)) || null;
	}

	function trackActive(chatId, sessionId) {
		if (!sessionId) return null;
		const active = {
			chatId,
			sessionId,
			controller: new AbortController(),
			stopped: false,
			timedOut: false,
		};
		activeBySession.set(String(sessionId), active);
		return active;
	}

	function untrackActive(active) {
		if (!active?.sessionId) return;
		const key = String(active.sessionId);
		const current = activeBySession.get(key);
		if (!active || current === active) {
			activeBySession.delete(key);
		}
	}

	function stoppedError() {
		const error = new Error('Execution stopped by user.');
		error.code = STOPPED_ERROR_CODE;
		return error;
	}

	function isStopError(error) {
		return error instanceof Error && error.code === STOPPED_ERROR_CODE;
	}

	async function stopSession(sessionId) {
		const active = getActive(sessionId);
		if (!active) return false;

		active.stopped = true;
		active.controller.abort();
		try {
			await client.session.abort({ path: { id: active.sessionId } });
		} catch {
			// Session may already be idle/finished.
		}
		return true;
	}

	async function sendRequired(chatId, sessionId, text) {
		if (!text) return;
		if (await sessionIsActive(chatId, sessionId)) {
			await bot.telegram.sendMessage(chatId, text);
			return;
		}
		await enqueueForSession(chatId, sessionId, text);
	}

	async function sendIfActive(chatId, sessionId, text) {
		if (!text) return;
		if (!(await sessionIsActive(chatId, sessionId))) return;
		await bot.telegram.sendMessage(chatId, text);
	}

	function assistantText(parts) {
		const text = (parts || [])
			.filter(part => part?.type === 'text' && typeof part.text === 'string')
			.map(part => part.text.trim())
			.filter(Boolean)
			.join('\n\n');

		return text || null;
	}

	async function replySplit(chatId, text) {
		const chunkSize = 3900;
		for (let i = 0; i < text.length; i += chunkSize) {
			await bot.telegram.sendMessage(chatId, text.slice(i, i + chunkSize));
		}
	}

	function delay(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	function clipText(value, max = 140) {
		if (typeof value !== 'string') return '';
		const compact = value.replace(/\s+/g, ' ').trim();
		if (!compact) return '';
		return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
	}

	function toolDurationText(state) {
		const start = Number(state?.time?.start || 0);
		const end = Number(state?.time?.end || 0);
		if (!start || !end || end < start) return '';
		const seconds = ((end - start) / 1000).toFixed(1);
		return `${seconds}s`;
	}

	function patchSummary(patchText) {
		if (typeof patchText !== 'string') return '';
		const normalized = patchText.replace(/\\n/g, '\n');
		const lines = normalized.split('\n');
		const files = [];
		for (const line of lines) {
			if (line.startsWith('*** Add File: ')) files.push(line.replace('*** Add File: ', '').trim());
			if (line.startsWith('*** Update File: ')) files.push(line.replace('*** Update File: ', '').trim());
			if (line.startsWith('*** Delete File: ')) files.push(line.replace('*** Delete File: ', '').trim());
		}
		if (files.length === 0) return '';
		if (files.length === 1) return files[0];
		return `${files[0]} (+${files.length - 1} más)`;
	}

	function extractToolInput(state) {
		if (state?.input && typeof state.input === 'object') return state.input;
		const raw = state?.raw;
		if (typeof raw !== 'string' || !raw.trim()) return {};
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') {
				if (parsed.input && typeof parsed.input === 'object') return parsed.input;
				if (parsed.arguments && typeof parsed.arguments === 'object') return parsed.arguments;
				return parsed;
			}
		} catch {
			return { raw };
		}
		return {};
	}

	function summarizeToolInput(tool, state) {
		const input = extractToolInput(state);
		if (tool === 'bash') {
			return clipText(input.command || input.description || '', 160);
		}
		if (tool === 'read') {
			return clipText(input.filePath || '', 120);
		}
		if (tool === 'glob') {
			return clipText(input.pattern || '', 120);
		}
		if (tool === 'grep') {
			return clipText(input.pattern || input.include || '', 120);
		}
		if (tool === 'apply_patch') {
			return clipText(patchSummary(input.patchText || input.raw || ''), 120);
		}
		if (tool === 'task') {
			return clipText(input.description || input.command || '', 120);
		}
		if (tool === 'write' || tool === 'edit') {
			return clipText(input.filePath || '', 120);
		}
		return clipText(state?.title || '', 120);
	}

	function latestAssistant(messages, knownMessageIds) {
		const freshAssistant = messages
			.filter(item => item?.info?.role === 'assistant' && !knownMessageIds.has(item.info.id))
			.sort((a, b) => (b.info?.time?.created || 0) - (a.info?.time?.created || 0));

		if (freshAssistant.length > 0) return freshAssistant[0];

		const anyAssistant = messages
			.filter(item => item?.info?.role === 'assistant')
			.sort((a, b) => (b.info?.time?.created || 0) - (a.info?.time?.created || 0));

		return anyAssistant[0] || null;
	}

	function formatPermissionRequest(request, requestId) {
		const lines = ['Permiso requerido.', `Permiso: ${request.permission}`];
		if (Array.isArray(request.patterns) && request.patterns.length > 0) {
			lines.push(`Patrones: ${request.patterns.join(', ')}`);
		}
		const replyMarkup = {
			inline_keyboard: [
				[{ text: 'Allow', callback_data: `allow_${requestId}` }],
				[{ text: 'Reject', callback_data: `reject_${requestId}` }],
				[{ text: 'Always', callback_data: `always_${requestId}` }],
			],
		};
		return { text: lines.join('\n'), replyMarkup };
	}

	function formatQuestionRequest(request) {
		const first = request.questions?.[0];
		if (!first) {
			return ['Pregunta requerida.', 'No se encontraron opciones para responder.'].join('\n');
		}

		const lines = [];
		if (first.header) lines.push(first.header);
		if (first.question) lines.push(first.question);
		(first.options || []).forEach((option, index) => {
			lines.push(`/${index + 1} ${option.label}`);
		});
		lines.push('/other');
		return lines.join('\n');
	}

	async function syncPendingRequest(chatId, sessionId, traceId) {
		if (!interactionClient) return;

		try {
			const [permissionResult, questionResult] = await Promise.all([
				interactionClient.permission.list(),
				interactionClient.question.list(),
			]);

			const pendingPermission = (permissionResult.data || []).find(item => item?.sessionID === sessionId);
			const pendingQuestion = (questionResult.data || []).find(item => item?.sessionID === sessionId);
			const current = getPending(chatId);
			const activeSession = await sessionIsActive(chatId, sessionId);

			if (pendingPermission) {
				if (activeSession && (!current || current.requestId !== pendingPermission.id || current.type !== 'permission')) {
					setPending(chatId, {
						type: 'permission',
						requestId: pendingPermission.id,
						sessionId,
					});
				}
				if (!current || current.requestId !== pendingPermission.id || current.type !== 'permission') {
					const { text, replyMarkup } = formatPermissionRequest(pendingPermission, pendingPermission.id);
					await bot.telegram.sendMessage(chatId, text, { reply_markup: replyMarkup });
					logInfo('permission.pending', { traceId, chatId, sessionId, requestId: pendingPermission.id });
				}
				return;
			}

			if (pendingQuestion) {
				if (activeSession && (!current || current.requestId !== pendingQuestion.id || current.type !== 'question')) {
					setPending(chatId, {
						type: 'question',
						requestId: pendingQuestion.id,
						sessionId,
						question: pendingQuestion.questions?.[0] || null,
					});
				}
				if (!current || current.requestId !== pendingQuestion.id || current.type !== 'question') {
					await sendRequired(chatId, sessionId, formatQuestionRequest(pendingQuestion));
					logInfo('question.pending', { traceId, chatId, sessionId, requestId: pendingQuestion.id });
				}
				return;
			}

			if (current && current.sessionId === sessionId) {
				clearPending(chatId);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : JSON.stringify(error);
			logInfo('pending.sync.failed', { traceId, chatId, sessionId, error: message });
		}
	}

	async function awaitSessionIdle(sessionId, chatId, traceId) {
		const deadline = Date.now() + pollTimeoutMs;
		let lastStatus = '';
		let attempts = 0;
		logInfo('polling.start', { traceId, sessionId, timeoutMs: pollTimeoutMs, intervalMs: pollIntervalMs });
		while (Date.now() < deadline) {
			attempts += 1;
			await syncPendingRequest(chatId, sessionId, traceId);
			const statuses = await client.session.status();
			const current = statuses.data?.[sessionId];
			const currentStatus = current?.type || 'missing';
			if (currentStatus !== lastStatus) {
				lastStatus = currentStatus;
				logInfo('polling.status', { traceId, sessionId, status: currentStatus, attempts });
			}
			if (!current || current.type === 'idle') return;
			await delay(pollIntervalMs);
		}
		logInfo('polling.timeout', { traceId, sessionId, attempts });
		throw new Error(`Timeout tras ${Math.round(pollTimeoutMs / 1000)}s esperando la respuesta.`);
	}

	function formatProgressEvent(event, traceId, state) {
		if (!event || typeof event !== 'object') return null;
		const now = Date.now();
		const noisyType = event.type === 'message.part.delta' || event.type === 'session.status';
		if (noisyType && state.lastProgressAt > 0 && now - state.lastProgressAt < PROGRESS_THROTTLE_MS) return null;

		if (event.type === 'session.status') {
			const status = event.properties?.status?.type;
			if (!status || status === state.lastStatus) return null;
			state.lastStatus = status;
			state.lastProgressAt = now;
			return `Estado: ${status}`;
		}

		if (event.type === 'message.part.delta') {
			state.lastProgressAt = now;
			return 'Generando respuesta...';
		}

		if (event.type !== 'message.part.updated') return null;
		const part = event.properties?.part;
		if (!part || !part.id) return null;

		if (part.type === 'tool') {
			const status = part.state?.status || 'pending';
			const detail = summarizeToolInput(part.tool, part.state);
			const duration = status === 'completed' ? toolDurationText(part.state) : '';
			const errorText = status === 'error' ? clipText(part.state?.error || '', 120) : '';
			const signature = `${status}|${detail}|${errorText}|${duration}`;
			const prevSignature = state.toolSignatures.get(part.id);
			if (prevSignature === signature) return null;
			state.toolSignatures.set(part.id, signature);
			state.lastProgressAt = now;
			const parts = [`Tool: ${part.tool} (${status}${duration ? `, ${duration}` : ''})`];
			if (detail) parts.push(`- ${detail}`);
			if (errorText) parts.push(`- ${errorText}`);
			return parts.join(' ');
		}

		if (part.type === 'step-start') {
			state.lastProgressAt = now;
			return 'Paso iniciado';
		}

		if (part.type === 'step-finish') {
			state.lastProgressAt = now;
			const output = part.tokens?.output;
			return output ? `Paso finalizado (output tokens: ${output})` : 'Paso finalizado';
		}

		if (part.type === 'retry') {
			state.lastProgressAt = now;
			const attempt = part.attempt || '?';
			return `Reintentando (intento ${attempt})`;
		}

		logInfo('sse.progress.ignored', { traceId, type: event.type, partType: part.type || 'unknown' });
		return null;
	}

	async function awaitSessionIdleSse(sessionId, chatId, traceId, active) {
		if (!interactionClient || !active) {
			await awaitSessionIdle(sessionId, chatId, traceId);
			return;
		}

		const progress = {
			lastProgressAt: 0,
			lastStatus: '',
			toolSignatures: new Map(),
		};
		const verboseEnabled = chatId === undefined || chatId === null ? true : await verboseForChat(chatId);

		const timeoutId = setTimeout(() => {
			active.timedOut = true;
			active.controller.abort();
		}, pollTimeoutMs);

		try {
			await syncPendingRequest(chatId, sessionId, traceId);
			logInfo('sse.start', { traceId, sessionId });
			const events = await interactionClient.event.subscribe({ signal: active.controller.signal });
			for await (const event of events.stream) {
				if (!event || typeof event !== 'object') continue;

				if (event?.type === 'permission.asked' && event.properties?.sessionID === sessionId) {
					if (await sessionIsActive(chatId, sessionId)) {
						setPending(chatId, { type: 'permission', requestId: event.properties.id, sessionId });
					}
					const { text, replyMarkup } = formatPermissionRequest(event.properties, event.properties.id);
					await bot.telegram.sendMessage(chatId, text, { reply_markup: replyMarkup });
					continue;
				}

				if (event?.type === 'question.asked' && event.properties?.sessionID === sessionId) {
					if (await sessionIsActive(chatId, sessionId)) {
						setPending(chatId, {
							type: 'question',
							requestId: event.properties.id,
							sessionId,
							question: event.properties.questions?.[0] || null,
						});
					}
					await sendRequired(chatId, sessionId, formatQuestionRequest(event.properties));
					continue;
				}

				const eventSessionId = event?.properties?.sessionID || event?.sessionID;
				if (eventSessionId !== sessionId) continue;

				if (event.type === 'session.idle') {
					logInfo('sse.idle', { traceId, sessionId });
					return;
				}

				if (!verboseEnabled) continue;
				const message = formatProgressEvent(event, traceId, progress);
				if (message) {
					await sendIfActive(chatId, sessionId, message);
					logInfo('sse.progress.sent', { traceId, sessionId, type: event.type });
				}
			}

			if (active.stopped) throw stoppedError();
			if (active.timedOut) throw new Error(`Timeout tras ${Math.round(pollTimeoutMs / 1000)}s esperando la respuesta.`);
			throw new Error('El stream SSE terminó antes de session.idle.');
		} catch {
			if (active.stopped) throw stoppedError();
			if (active.timedOut) throw new Error(`Timeout tras ${Math.round(pollTimeoutMs / 1000)}s esperando la respuesta.`);
			logInfo('sse.failed.fallback_polling', { traceId, sessionId });
			await awaitSessionIdle(sessionId, chatId, traceId);
		} finally {
			clearTimeout(timeoutId);
			logInfo('sse.end', { traceId, sessionId, stopped: active.stopped, timedOut: active.timedOut });
		}
	}

	async function promptWithPolling(sessionId, prompt, traceId, chatId, system) {
		const active = trackActive(chatId, sessionId);
		logInfo('prompt.prepare', { traceId, sessionId });
		try {
			const before = await client.session.messages({
				path: { id: sessionId },
				query: { limit: 30 },
			});
			const knownMessageIds = new Set(before.data.map(item => item.info.id));
			logInfo('prompt.history.loaded', { traceId, sessionId, knownMessages: knownMessageIds.size });

			logInfo('prompt.async.send', { traceId, sessionId, promptChars: prompt.length });
			await client.session.promptAsync({
				path: { id: sessionId },
				body: {
					model: modelConfig(),
					parts: [{ type: 'text', text: prompt }],
					...(system ? { system } : {}),
				},
			});
			logInfo('prompt.async.accepted', { traceId, sessionId });

			await awaitSessionIdleSse(sessionId, chatId, traceId, active);

			for (let attempt = 0; attempt < 5; attempt += 1) {
				logInfo('prompt.fetch.attempt', { traceId, sessionId, attempt: attempt + 1 });
				const messages = await client.session.messages({
					path: { id: sessionId },
					query: { limit: 30 },
				});
				const assistant = latestAssistant(messages.data, knownMessageIds);
				if (assistant) {
					const text = assistantText(assistant.parts);
					if (text) {
						logInfo('prompt.fetch.found', { traceId, sessionId, messageId: assistant.info?.id || 'unknown' });
						return text;
					}
				}
				await delay(500);
			}

			throw new Error('No se pudo recuperar la respuesta del asistente.');
		} finally {
			untrackActive(active);
		}
	}

	async function syncPendingForSession(chatId, sessionId, traceId = `pending-${sessionId}-${Date.now()}`) {
		await syncPendingRequest(chatId, sessionId, traceId);
	}

	async function handleDecisionReply(chatId, text) {
		const normalized = text.trim();

		if (!interactionClient) {
			await bot.telegram.sendMessage(chatId, 'No se puede responder solicitudes interactivas con esta configuración.');
			return true;
		}

		const permissionMatch = normalized.match(/^\/(allow|reject|always)-(\S+)$/u);
		if (permissionMatch) {
			const action = permissionMatch[1];
			const requestId = permissionMatch[2];
			const reply = action === 'allow' ? 'once' : action === 'always' ? 'always' : 'reject';
			await interactionClient.permission.reply({ requestID: requestId, reply });
			await bot.telegram.sendMessage(chatId, `Permiso /${action}-${requestId} registrado.`);
			return true;
		}

		const questionIndexMatch = normalized.match(/^\/(\d+)$/u);
		if (questionIndexMatch) {
			const optionIndex = Number(questionIndexMatch[1]);
			const pending = getPending(chatId);
			const question = pending?.question;
			const requestId = pending?.requestId;
			if (!question || !requestId) {
				await bot.telegram.sendMessage(chatId, 'No hay una pregunta pendiente.');
				return true;
			}
			const selected = question.options?.[optionIndex - 1];
			if (!selected) {
				await bot.telegram.sendMessage(chatId, `Opción inválida. Usa /1, /2, ... según la lista.`);
				return true;
			}
			await interactionClient.question.reply({ requestID: requestId, answers: [[selected.label]] });
			clearPending(chatId);
			await bot.telegram.sendMessage(chatId, `Respondido: ${selected.label}`);
			return true;
		}

		const otherQuestionMatch = normalized.match(/^\/other(?:\s+(.+))?$/iu);
		if (otherQuestionMatch) {
			const pending = getPending(chatId);
			const requestId = pending?.requestId;
			if (!requestId) {
				await bot.telegram.sendMessage(chatId, 'No hay una pregunta pendiente.');
				return true;
			}
			const customText = otherQuestionMatch[1]?.trim();
			if (customText) {
				await interactionClient.question.reply({ requestID: requestId, answers: [[customText]] });
				clearPending(chatId);
				await bot.telegram.sendMessage(chatId, `Respondido: ${customText}`);
			} else {
				setPending(chatId, { ...pending, awaitingOtherInput: true });
				await bot.telegram.sendMessage(chatId, 'Escribe tu respuesta personalizada:');
			}
			return true;
		}

		return false;
	}

	return {
		clearPending,
		handleDecisionReply,
		hasPending,
		isAwaitingOtherInput,
		isStopError,
		promptWithPolling,
		replySplit,
		syncPendingForSession,
		stopSession,
		submitOtherInput,
	};
}

export { createPromptService };
