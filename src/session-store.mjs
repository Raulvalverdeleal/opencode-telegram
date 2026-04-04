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
		return {
			currentSessionId,
			instructionsSent: raw?.instructionsSent || false,
			verbose: raw?.verbose !== false,
			sessions: merged,
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
		const record = normalizeRecord(db[key]);
		db[key] = record;
		await saveStore(db);
		return record;
	}

	async function isInstructionsSent(chatId) {
		const db = await loadStore();
		const record = normalizeRecord(db[String(chatId)]);
		return record.instructionsSent;
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

	return {
		ensureSession,
		findChatIdBySession,
		isVerbose,
		isInstructionsSent,
		listChatIds,
		listSessions,
		markInstructionsSent,
		newSession,
		renameCurrentSession,
		removeSession,
		setVerbose,
		switchSession,
		toggleVerbose,
	};
}

export { createSessionStore };
