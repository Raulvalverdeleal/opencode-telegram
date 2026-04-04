import test from 'node:test';
import assert from 'node:assert/strict';
import { withChatLock } from '../src/chat-locks.mjs';

function deferred() {
	let resolve;
	const promise = new Promise(r => {
		resolve = r;
	});
	return { promise, resolve };
}

test('withChatLock serializes work per chat id', async () => {
	const gate = deferred();
	const order = [];

	const first = withChatLock(7, async () => {
		order.push('first:start');
		await gate.promise;
		order.push('first:end');
	});

	const second = withChatLock(7, async () => {
		order.push('second:start');
		order.push('second:end');
	});

	await Promise.resolve();
	assert.deepEqual(order, ['first:start']);

	gate.resolve();
	await Promise.all([first, second]);

	assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
});
