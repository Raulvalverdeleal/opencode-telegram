import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService } from '../src/auth.mjs';

function createCtx({ chatId, userId }) {
	const replies = [];
	return {
		ctx: {
			chat: chatId === undefined ? undefined : { id: chatId },
			from: userId === undefined ? undefined : { id: userId },
			reply: async message => {
				replies.push(message);
			},
		},
		replies,
	};
}

test('allowlist mode authorizes known fingerprint', async () => {
	const logEvents = [];
	const service = createAuthService({
		authMode: 'allowlist',
		allowedFingerprints: new Set(['42:9']),
		logInfo: (event, data) => logEvents.push({ event, data }),
		unauthorizedMessage: 'Unauthorized',
	});
	const { ctx, replies } = createCtx({ chatId: 42, userId: 9 });

	const authorized = await service.authorizeRequest(ctx);

	assert.equal(authorized, true);
	assert.deepEqual(replies, []);
	assert.deepEqual(logEvents, []);
});

test('deny-all mode blocks requests and replies', async () => {
	const service = createAuthService({
		authMode: 'deny-all',
		allowedFingerprints: new Set(),
		logInfo: () => {},
		unauthorizedMessage: 'Unauthorized',
	});
	const { ctx, replies } = createCtx({ chatId: 42, userId: 9 });

	const authorized = await service.authorizeRequest(ctx);

	assert.equal(authorized, false);
	assert.deepEqual(replies, ['Unauthorized']);
});

test('discovery mode always replies with fingerprint guidance', async () => {
	const service = createAuthService({
		authMode: 'discovery',
		allowedFingerprints: new Set(),
		logInfo: () => {},
		unauthorizedMessage: 'Unauthorized',
	});
	const { ctx, replies } = createCtx({ chatId: -1001, userId: 22 });

	const authorized = await service.authorizeRequest(ctx);

	assert.equal(authorized, false);
	assert.equal(replies.length, 1);
	assert.match(replies[0], /Fingerprint: -1001:22/);
});

test('requestFingerprint returns null when chat or user is missing', () => {
	const service = createAuthService({
		authMode: 'allowlist',
		allowedFingerprints: new Set(),
		logInfo: () => {},
		unauthorizedMessage: 'Unauthorized',
	});

	assert.equal(service.requestFingerprint({}), null);
	assert.equal(service.requestFingerprint({ chat: { id: 1 } }), null);
	assert.equal(service.requestFingerprint({ from: { id: 2 } }), null);
});
