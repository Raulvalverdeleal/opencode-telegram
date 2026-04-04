import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createSessionStore } from '../src/session-store.mjs';

async function withTempStore(run) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'opencode-server-test-'));
	const storePath = path.join(dir, 'chat-sessions.json');
	try {
		await run(storePath);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('ensureSession creates and persists session for a chat', async () => {
	await withTempStore(async storePath => {
		const createdCalls = [];
		const client = {
			session: {
				create: async ({ body }) => {
					createdCalls.push(body.title);
					return { data: { id: 'session-1' } };
				},
				get: async () => ({ data: {} }),
			},
		};
		const store = createSessionStore({
			client,
			storePath,
			nowIso: () => '2026-04-04T12:00:00.000Z',
		});

		const sessionId = await store.ensureSession(77);

		assert.equal(sessionId, 'session-1');
		assert.equal(createdCalls.length, 1);
		assert.equal(createdCalls[0], 'telegram-77-2026-04-04T12:00:00.000Z');

		const raw = JSON.parse(await readFile(storePath, 'utf8'));
		assert.equal(raw['77'].currentSessionId, 'session-1');
		assert.equal(raw['77'].sessions.length, 1);
	});
});

test('ensureSession reuses existing current session', async () => {
	await withTempStore(async storePath => {
		let createCalls = 0;
		const client = {
			session: {
				create: async () => {
					createCalls += 1;
					return { data: { id: 'session-new' } };
				},
				get: async () => ({ data: {} }),
			},
		};
		const store = createSessionStore({
			client,
			storePath,
			nowIso: () => '2026-04-04T12:00:00.000Z',
		});

		await store.newSession(77);
		const existing = await store.ensureSession(77);

		assert.equal(existing, 'session-new');
		assert.equal(createCalls, 1);
	});
});

test('switchSession validates target session before persisting', async () => {
	await withTempStore(async storePath => {
		const client = {
			session: {
				create: async () => ({ data: { id: 'session-1' } }),
				get: async ({ path: idPath }) => {
					assert.equal(idPath.id, 'session-2');
					return { data: { id: idPath.id } };
				},
			},
		};
		const store = createSessionStore({
			client,
			storePath,
			nowIso: () => '2026-04-04T12:00:00.000Z',
		});

		await store.newSession(77);
		const current = await store.switchSession(77, 'session-2');

		assert.equal(current, 'session-2');
		const raw = JSON.parse(await readFile(storePath, 'utf8'));
		assert.equal(raw['77'].currentSessionId, 'session-2');
		assert.equal(
			raw['77'].sessions.some(item => item.id === 'session-2'),
			true,
		);
	});
});

test('newSession uses provided name as session title', async () => {
	await withTempStore(async storePath => {
		const createdCalls = [];
		const client = {
			session: {
				create: async ({ body }) => {
					createdCalls.push(body.title);
					return { data: { id: 'session-named', title: body.title } };
				},
				get: async () => ({ data: {} }),
			},
		};
		const store = createSessionStore({
			client,
			storePath,
			nowIso: () => '2026-04-04T12:00:00.000Z',
		});

		await store.newSession(77, 'Deploy prep');

		assert.deepEqual(createdCalls, ['Deploy prep']);
		const raw = JSON.parse(await readFile(storePath, 'utf8'));
		assert.equal(raw['77'].sessions[0].name, 'Deploy prep');
	});
});

test('switchSession stores title returned by API as name', async () => {
	await withTempStore(async storePath => {
		const client = {
			session: {
				create: async () => ({ data: { id: 'session-1' } }),
				get: async () => ({ data: { id: 'session-2', title: 'Refactor cache layer' } }),
			},
		};
		const store = createSessionStore({
			client,
			storePath,
			nowIso: () => '2026-04-04T12:00:00.000Z',
		});

		await store.newSession(77);
		await store.switchSession(77, 'session-2');

		const raw = JSON.parse(await readFile(storePath, 'utf8'));
		const switched = raw['77'].sessions.find(item => item.id === 'session-2');
		assert.equal(switched.name, 'Refactor cache layer');
	});
});

test('verbose mode defaults to ON and can be toggled/persisted', async () => {
	await withTempStore(async storePath => {
		const client = {
			session: {
				create: async () => ({ data: { id: 'session-1' } }),
				get: async () => ({ data: {} }),
			},
		};
		const store = createSessionStore({
			client,
			storePath,
			nowIso: () => '2026-04-04T12:00:00.000Z',
		});

		assert.equal(await store.isVerbose(77), true);
		assert.equal(await store.toggleVerbose(77), false);
		assert.equal(await store.isVerbose(77), false);
		assert.equal(await store.setVerbose(77, true), true);
		assert.equal(await store.isVerbose(77), true);

		const raw = JSON.parse(await readFile(storePath, 'utf8'));
		assert.equal(raw['77'].verbose, true);
	});
});

test('listChatIds returns known chats from store', async () => {
	await withTempStore(async storePath => {
		const client = {
			session: {
				create: async () => ({ data: { id: 'session-1' } }),
				get: async () => ({ data: {} }),
			},
		};
		const store = createSessionStore({
			client,
			storePath,
			nowIso: () => '2026-04-04T12:00:00.000Z',
		});

		await store.newSession(77);
		await store.newSession(88);

		const chatIds = await store.listChatIds();
		assert.deepEqual(chatIds.sort(), ['77', '88']);
	});
});

test('renameCurrentSession updates active session title and local name', async () => {
	await withTempStore(async storePath => {
		const updateCalls = [];
		const client = {
			session: {
				create: async () => ({ data: { id: 'session-1' } }),
				get: async () => ({ data: {} }),
				update: async payload => {
					updateCalls.push(payload);
					return { data: { id: payload.path.id, title: payload.body.title } };
				},
			},
		};
		const store = createSessionStore({
			client,
			storePath,
			nowIso: () => '2026-04-04T12:00:00.000Z',
		});

		await store.newSession(77);
		const renamed = await store.renameCurrentSession(77, 'Session renamed');

		assert.equal(renamed.sessionId, 'session-1');
		assert.equal(renamed.name, 'Session renamed');
		assert.equal(updateCalls.length, 1);
		assert.equal(updateCalls[0].path.id, 'session-1');
		assert.equal(updateCalls[0].body.title, 'Session renamed');

		const raw = JSON.parse(await readFile(storePath, 'utf8'));
		assert.equal(raw['77'].sessions[0].name, 'Session renamed');
	});
});

test('restart pending chat ids are consumed once', async () => {
	await withTempStore(async storePath => {
		const client = {
			session: {
				create: async () => ({ data: { id: 'session-1' } }),
				get: async () => ({ data: {} }),
				update: async () => ({ data: {} }),
			},
		};
		const store = createSessionStore({
			client,
			storePath,
			nowIso: () => '2026-04-04T12:00:00.000Z',
		});

		await store.newSession(77);
		await store.newSession(88);
		await store.markRestartStatusPending(77);
		await store.markRestartStatusPending(88);

		const first = await store.consumeRestartStatusPendingChats();
		assert.deepEqual(first.sort(), ['77', '88']);

		const second = await store.consumeRestartStatusPendingChats();
		assert.deepEqual(second, []);
	});
});
