import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function createSessionStore({ client, storePath, nowIso }) {
	function normalizeName(name) {
		if (typeof name !== 'string') return null;
		const trimmed = name.trim();
		return trimmed ? trimmed : null;
	}

	function sessionTitle(chatId) {
		return `telegram-${chatId}-${nowIso()}`;
	}

	function normalizeRecord(raw) {
		const sessions = Array.isArray(raw?.sessions)
			? raw.sessions
					.filter(item => item?.id)
					.map(item => ({
						id: item.id,
						createdAt: item.createdAt || nowIso(),
						name: normalizeName(item.name),
					}))
			: [];
		const legacySession = raw?.sessionId
			? [{ id: raw.sessionId, createdAt: raw.createdAt || nowIso(), name: normalizeName(raw.sessionName) }]
			: [];
		const merged = [...sessions, ...legacySession].reduce((acc, item) => {
			if (acc.some(existing => existing.id === item.id)) return acc;
			acc.push({ id: item.id, createdAt: item.createdAt || nowIso(), name: normalizeName(item.name) });
			return acc;
		}, []);
		const currentSessionId = raw?.currentSessionId || raw?.sessionId || merged[0]?.id || null;
		const outboxSource = raw?.outboxBySession && typeof raw.outboxBySession === 'object' ? raw.outboxBySession : {};
		const outboxBySession = {};
		for (const [sessionId, messages] of Object.entries(outboxSource)) {
			if (!sessionId || !Array.isArray(messages)) continue;
			outboxBySession[sessionId] = messages
				.filter(item => item && typeof item.text === 'string' && item.text.trim())
				.map(item => ({
					text: item.text,
					createdAt: item.createdAt || nowIso(),
				}));
		}
		return {
			currentSessionId,
			instructionsSent: raw?.instructionsSent || false,
			verbose: raw?.verbose !== false,
			sessions: merged,
			outboxBySession,
			agentsBySession: raw?.agentsBySession || {},
			updatedAt: raw?.updatedAt || nowIso(),
		};
	}

	function upsertSession(record, sessionId, sessionName = null) {
		const normalizedName = normalizeName(sessionName);
		const existing = record.sessions.find(item => item.id === sessionId);
		if (!existing) {
			record.sessions.unshift({ id: sessionId, createdAt: nowIso(), name: normalizedName });
		} else if (normalizedName) {
			existing.name = normalizedName;
		}
		record.currentSessionId = sessionId;
		record.updatedAt = nowIso();
		return record;
	}

	async function createSession(chatId, sessionName = null) {
		const normalizedName = normalizeName(sessionName);
		const created = await client.session.create({
			body: {
				title: normalizedName || sessionTitle(chatId),
			},
		});
		const savedName = normalizedName || normalizeName(created.data?.title);
		return { id: created.data.id, name: savedName };
	}

	async function loadStore() {
		try {
			const raw = await readFile(storePath, 'utf8');
			return JSON.parse(raw);
		} catch {
			return {};
		}
	}

	async function saveStore(data) {
		await mkdir(dirname(storePath), { recursive: true });
		await writeFile(storePath, JSON.stringify(data, null, 2), 'utf8');
	}

	async function ensureSession(chatId) {
		const db = await loadStore();
		const key = String(chatId);
		const record = normalizeRecord(db[key]);
		if (record.currentSessionId) {
			db[key] = record;
			await saveStore(db);
			return record.currentSessionId;
		}

		const created = await createSession(chatId);
		upsertSession(record, created.id, created.name);
		db[key] = record;
		await saveStore(db);
		return created.id;
	}

	async function newSession(chatId, sessionName = null) {
		const db = await loadStore();
		const key = String(chatId);
		const record = normalizeRecord(db[key]);

		const created = await createSession(chatId, sessionName);
		upsertSession(record, created.id, created.name);
		record.instructionsSent = false;
		db[key] = record;
		await saveStore(db);
		return created.id;
	}

	async function listSessions(chatId) {
		const db = await loadStore();
		const key = String(chatId);
		return normalizeRecord(db[key]);
	}

	async function getCurrentSessionId(chatId) {
		const record = await listSessions(chatId);
		return record.currentSessionId;
	}

	async function isVerbose(chatId) {
		const db = await loadStore();
		const record = normalizeRecord(db[String(chatId)]);
		return record.verbose;
	}

	async function setVerbose(chatId, enabled) {
		const db = await loadStore();
		const key = String(chatId);
		const record = normalizeRecord(db[key]);
		record.verbose = Boolean(enabled);
		record.updatedAt = nowIso();
		db[key] = record;
		await saveStore(db);
		return record.verbose;
	}

	async function toggleVerbose(chatId) {
		const current = await isVerbose(chatId);
		return setVerbose(chatId, !current);
	}

	async function getCurrentSession(chatId) {
		const db = await loadStore();
		const record = normalizeRecord(db[String(chatId)]);
		return record.currentSessionId;
	}

	async function getAgent(chatId) {
		const db = await loadStore();
		const record = normalizeRecord(db[String(chatId)]);
		return record.agentsBySession?.[record.currentSessionId] || 'default';
	}

	async function setAgent(chatId, agent) {
		const db = await loadStore();
		const key = String(chatId);
		const record = normalizeRecord(db[key]);
		if (!record.agentsBySession) record.agentsBySession = {};
		record.agentsBySession[record.currentSessionId] = agent;
		record.updatedAt = nowIso();
		db[key] = record;
		await saveStore(db);
		return agent;
	}

	async function listChatIds() {
		const db = await loadStore();
		return Object.keys(db);
	}

	async function removeSession(chatId, sessionId) {
		const db = await loadStore();
		const key = String(chatId);
		const record = normalizeRecord(db[key]);
		record.sessions = record.sessions.filter(item => item.id !== sessionId);
		if (record.currentSessionId === sessionId) {
			record.currentSessionId = record.sessions[0]?.id || null;
		}
		record.updatedAt = nowIso();
		db[key] = record;
		await saveStore(db);
	}

	async function switchSession(chatId, sessionId) {
		const found = await client.session.get({ path: { id: sessionId } });
		const db = await loadStore();
		const key = String(chatId);
		const record = normalizeRecord(db[key]);
		upsertSession(record, sessionId, found.data?.title);
		record.instructionsSent = false;
		db[key] = record;
		await saveStore(db);
		return record.currentSessionId;
	}

	async function enqueueSessionMessage(chatId, sessionId, text, maxPerSession = 100) {
		if (!sessionId || typeof text !== 'string' || !text.trim()) return;
		const db = await loadStore();
		const key = String(chatId);
		const record = normalizeRecord(db[key]);
		const current = Array.isArray(record.outboxBySession[sessionId]) ? record.outboxBySession[sessionId] : [];
		const next = [...current, { text, createdAt: nowIso() }];
		record.outboxBySession[sessionId] = next.slice(Math.max(next.length - maxPerSession, 0));
		record.updatedAt = nowIso();
		db[key] = record;
		await saveStore(db);
	}

	async function consumeSessionMessages(chatId, sessionId) {
		if (!sessionId) return [];
		const db = await loadStore();
		const key = String(chatId);
		const record = normalizeRecord(db[key]);
		const messages = Array.isArray(record.outboxBySession[sessionId]) ? record.outboxBySession[sessionId] : [];
		if (messages.length === 0) return [];
		record.outboxBySession[sessionId] = [];
		record.updatedAt = nowIso();
		db[key] = record;
		await saveStore(db);
		return messages;
	}

	async function pendingSessionCount(chatId, sessionId) {
		if (!sessionId) return 0;
		const db = await loadStore();
		const record = normalizeRecord(db[String(chatId)]);
		const messages = Array.isArray(record.outboxBySession[sessionId]) ? record.outboxBySession[sessionId] : [];
		return messages.length;
	}

	async function renameCurrentSession(chatId, sessionName) {
		const normalizedName = normalizeName(sessionName);
		if (!normalizedName) {
			throw new Error('Nombre de sesión inválido.');
		}

		const db = await loadStore();
		const key = String(chatId);
		const record = normalizeRecord(db[key]);

		let sessionId = record.currentSessionId;
		if (!sessionId) {
			sessionId = await ensureSession(chatId);
			record.currentSessionId = sessionId;
		}

		await client.session.update({
			path: { id: sessionId },
			body: { title: normalizedName },
		});

		upsertSession(record, sessionId, normalizedName);
		record.updatedAt = nowIso();
		db[key] = record;
		await saveStore(db);

		return {
			sessionId,
			name: normalizedName,
		};
	}

	async function findChatIdBySession(sessionId) {
		const db = await loadStore();
		for (const [chatId, raw] of Object.entries(db)) {
			const record = normalizeRecord(raw);
			if (record.currentSessionId === sessionId || record.sessions.some(item => item.id === sessionId)) {
				return chatId;
			}
		}
		return null;
	}

	async function isInstructionsSent(chatId) {
		const db = await loadStore();
		return normalizeRecord(db[String(chatId)]).instructionsSent;
	}

	async function markInstructionsSent(chatId) {
		const db = await loadStore();
		const key = String(chatId);
		const record = normalizeRecord(db[key]);
		record.instructionsSent = true;
		record.updatedAt = nowIso();
		db[key] = record;
		await saveStore(db);
	}

	return {
		consumeSessionMessages,
		ensureSession,
		enqueueSessionMessage,
		findChatIdBySession,
		getAgent,
		getCurrentSession,
		getCurrentSessionId,
		isInstructionsSent,
		isVerbose,
		listChatIds,
		listSessions,
		markInstructionsSent,
		newSession,
		pendingSessionCount,
		renameCurrentSession,
		removeSession,
		setAgent,
		setVerbose,
		switchSession,
		toggleVerbose,
	};
}

export { createSessionStore };
