const chatLocks = new Map();

async function withChatLock(chatId, fn) {
	const key = String(chatId);
	const prev = chatLocks.get(key) || Promise.resolve();
	const next = prev.then(fn, fn);

	chatLocks.set(
		key,
		next.finally(() => {
			if (chatLocks.get(key) === next) chatLocks.delete(key);
		}),
	);

	return next;
}

export { withChatLock };
